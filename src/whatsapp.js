import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { processUpsert } from "@/src/messages.js";
import { normalizeJid } from "@/src/message-feed.js";

const SOCKET_CLOSE_TIMEOUT_MS = 5000;
const AUTOMATIC_PAIRING_REASON = "automatic-pairing-required";
const SOCKET_TERMINATION_REASON = "socket-termination-uncertain";
const DISCONNECT_REASONS = new Map([
  [DisconnectReason.loggedOut, "logged-out-or-rejected"],
  [DisconnectReason.forbidden, "forbidden"],
  [DisconnectReason.connectionLost, "connection-lost-or-timed-out"],
  [DisconnectReason.timedOut, "connection-lost-or-timed-out"],
  [DisconnectReason.multideviceMismatch, "multidevice-mismatch"],
  [DisconnectReason.connectionClosed, "connection-closed"],
  [DisconnectReason.connectionReplaced, "connection-replaced"],
  [DisconnectReason.badSession, "bad-session"],
  [DisconnectReason.unavailableService, "service-unavailable"],
  [DisconnectReason.restartRequired, "restart-required"],
]);

const START_ERROR_MESSAGES = {
  "registration-missing": "No saved registered WhatsApp account is available.",
  "saved-auth-malformed": "Saved WhatsApp authentication needs owner review.",
  "saved-auth-unavailable": "Saved WhatsApp authentication could not be read safely.",
};

export class WhatsAppSessionStartError extends Error {
  constructor(code) {
    super(START_ERROR_MESSAGES[code] ?? "The WhatsApp session could not be started safely.");
    this.name = "WhatsAppSessionStartError";
    this.code = Object.hasOwn(START_ERROR_MESSAGES, code) ? code : "startup-failed";
  }
}

function disconnectDiagnostic(error) {
  const code = error?.output?.statusCode;
  const statusCode = Number.isInteger(code) && code >= 100 && code <= 599 ? code : null;
  return {
    statusCode,
    reason: DISCONNECT_REASONS.get(statusCode) ?? "unknown",
  };
}

function accountJids(user) {
  return [user?.id, user?.lid].filter((jid) => typeof jid === "string");
}

function selfChatJid(user) {
  const jid = normalizeJid(user?.id);
  if (!jid || !jid.includes("@")) {
    throw new Error("The linked account identifier is not available");
  }
  return jid;
}

function isNotFound(error) {
  return error?.code === "ENOENT";
}

async function validateSavedRegistration(authDirectory, fileSystem) {
  let directory;
  try {
    directory = await fileSystem.lstat(authDirectory);
  } catch (error) {
    if (isNotFound(error)) throw new WhatsAppSessionStartError("registration-missing");
    throw new WhatsAppSessionStartError("saved-auth-unavailable");
  }

  if (!directory.isDirectory()) {
    throw new WhatsAppSessionStartError("saved-auth-malformed");
  }

  let entries;
  try {
    entries = await fileSystem.readdir(authDirectory, { withFileTypes: true });
  } catch {
    throw new WhatsAppSessionStartError("saved-auth-unavailable");
  }

  const credentialsEntry = entries.find((entry) => entry.name === "creds.json");
  if (!credentialsEntry) throw new WhatsAppSessionStartError("registration-missing");

  let credentials;
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const path = join(authDirectory, entry.name);

    let file;
    try {
      file = await fileSystem.lstat(path);
    } catch {
      throw new WhatsAppSessionStartError("saved-auth-unavailable");
    }
    if (!file.isFile()) throw new WhatsAppSessionStartError("saved-auth-malformed");

    let contents;
    try {
      contents = await fileSystem.readFile(path, "utf8");
    } catch {
      throw new WhatsAppSessionStartError("saved-auth-unavailable");
    }

    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new WhatsAppSessionStartError("saved-auth-malformed");
    }

    if (entry.name === "creds.json") credentials = parsed;
  }

  if (
    !credentials ||
    typeof credentials !== "object" ||
    Array.isArray(credentials) ||
    typeof credentials.registered !== "boolean"
  ) {
    throw new WhatsAppSessionStartError("saved-auth-malformed");
  }
  if (!credentials.registered) throw new WhatsAppSessionStartError("registration-missing");
}

export async function createWhatsAppSession(
  {
    onPairing,
    onOpen,
    onClose,
    onCredentialSaveFailure,
    onUpsert,
    onAlbumApproved,
    albumService,
    savedRegistrationOnly = false,
  },
  dependencies = {},
) {
  const {
    makeSocket = makeWASocket,
    loadAuthState = useMultiFileAuthState,
    loggerFactory = pino,
    authDirectory = "./auth_info",
    closeTimeoutMs = SOCKET_CLOSE_TIMEOUT_MS,
    fileSystem = { lstat, readFile, readdir },
  } = dependencies;
  const debug = process.env.DEBUG === "true";
  let stage = "starting";
  // Never pass library updates, raw errors, credentials, or QR values here.
  const diagnostic = (event, details = {}) => {
    if (debug) console.info("[whatsapp]", { event, stage, ...details });
  };
  diagnostic("session-start");

  let state;
  let saveCreds;
  let socket;
  try {
    if (savedRegistrationOnly) await validateSavedRegistration(authDirectory, fileSystem);
    ({ state, saveCreds } = await loadAuthState(authDirectory));
    if (savedRegistrationOnly && state?.creds?.registered !== true) {
      if (state?.creds?.registered === false) {
        throw new WhatsAppSessionStartError("registration-missing");
      }
      throw new WhatsAppSessionStartError("saved-auth-malformed");
    }
    socket = makeSocket({
      auth: state,
      logger: loggerFactory({ level: "silent" }),
      markOnlineOnConnect: false,
    });
  } catch (error) {
    diagnostic("session-start-failed");
    if (savedRegistrationOnly && !(error instanceof WhatsAppSessionStartError)) {
      throw new WhatsAppSessionStartError("saved-auth-unavailable");
    }
    throw error;
  }

  let closed = false;
  let hasQr = false;
  let automaticPairingBlocked = false;
  let reportedSaveFailure = false;
  let reportedUncertainClose = false;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  function reportUncertainClose() {
    if (closed || reportedUncertainClose) return;
    reportedUncertainClose = true;
    diagnostic("socket-close-unconfirmed");
    try {
      onClose?.({
        loggedOut: false,
        reason: SOCKET_TERMINATION_REASON,
        closeConfirmed: false,
      });
    } catch {
      // A controller callback must not interfere with socket cleanup.
    }
  }

  async function waitForClose() {
    if (closed) return;
    let timeout;
    try {
      await Promise.race([
        closedPromise,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Socket shutdown timed out")),
            closeTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function terminateAutomaticPairing() {
    try {
      if (!closed) await socket.end();
      await waitForClose();
    } catch {
      reportUncertainClose();
    }
  }

  function notifyCredentialSaveFailure() {
    try {
      const result = onCredentialSaveFailure?.();
      if (result && typeof result.catch === "function") void result.catch(() => {});
    } catch {
      // Persistence failure is reported through a fixed controller callback.
    }
  }

  socket.ev.on("creds.update", async () => {
    if (closed) return;
    try {
      await saveCreds();
    } catch {
      if (!reportedSaveFailure) {
        reportedSaveFailure = true;
        diagnostic("credentials-save-failed");
        notifyCredentialSaveFailure();
      }
    }
  });

  socket.ev.on("connection.update", ({ connection, qr, isNewLogin, lastDisconnect }) => {
    if (closed) return;
    if (qr && savedRegistrationOnly) {
      if (!automaticPairingBlocked) {
        automaticPairingBlocked = true;
        stage = "automatic-pairing-blocked";
        diagnostic("automatic-pairing-blocked");
        void terminateAutomaticPairing();
      }
      return;
    }
    if (automaticPairingBlocked && connection !== "close") return;
    if (qr) {
      stage = "awaiting-scan";
      diagnostic(hasQr ? "qr-refreshed" : "qr-issued");
      hasQr = true;
      onPairing?.(qr);
    }
    if (isNewLogin === true) {
      stage = "paired-awaiting-connection";
      diagnostic("pairing-accepted");
    }
    if (connection === "open") {
      stage = "connected";
      diagnostic("connection-open");
      onOpen?.();
    }
    if (connection === "close") {
      closed = true;
      const error = lastDisconnect?.error;
      const { statusCode, reason: disconnectReason } = disconnectDiagnostic(error);
      const reason = automaticPairingBlocked ? AUTOMATIC_PAIRING_REASON : disconnectReason;
      diagnostic("connection-close", {
        statusCode,
        reason,
      });
      try {
        onClose?.({
          loggedOut: !automaticPairingBlocked && statusCode === DisconnectReason.loggedOut,
          reason,
          closeConfirmed: true,
        });
      } finally {
        resolveClosed();
      }
    }
  });

  socket.ev.on("messages.upsert", (upsert) => {
    if (closed) return;
    const activeAccountJids = accountJids(socket.user);
    void processUpsert(upsert, (jid, content) => socket.sendMessage(jid, content), {
      accountJids: activeAccountJids,
      albumService,
      onAlbumApproved,
    }).catch(() => {});
    try {
      onUpsert?.(upsert, activeAccountJids);
    } catch {
      // A passive panel failure must not interfere with command processing.
    }
  });

  return {
    async logout() {
      await socket.logout();
      await waitForClose();
    },
    async end() {
      if (!closed) await socket.end();
      await waitForClose();
    },
    async sendSelf(text) {
      await socket.sendMessage(selfChatJid(socket.user), { text });
    },
  };
}

export function downloadImageStream(message) {
  return downloadMediaMessage(message, "stream", {});
}
