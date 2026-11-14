import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { processUpsert } from "@/src/messages.js";
import { normalizeJid } from "@/src/message-feed.js";

const SOCKET_CLOSE_TIMEOUT_MS = 5000;
const DISCONNECT_REASONS = new Map([
  [401, "logged-out-or-rejected"],
  [403, "forbidden"],
  [408, "connection-lost-or-timed-out"],
  [411, "multidevice-mismatch"],
  [428, "connection-closed"],
  [440, "connection-replaced"],
  [500, "bad-session"],
  [503, "service-unavailable"],
  [515, "restart-required"],
]);

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

export async function createWhatsAppSession({
  onPairing,
  onOpen,
  onClose,
  onUpsert,
  onAlbumApproved,
  albumService,
}) {
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
    ({ state, saveCreds } = await useMultiFileAuthState("./auth_info"));
    socket = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      markOnlineOnConnect: false,
    });
  } catch (error) {
    diagnostic("session-start-failed");
    throw error;
  }

  let closed = false;
  let hasQr = false;
  let reportedSaveFailure = false;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  socket.ev.on("creds.update", () => {
    return saveCreds().catch(() => {
      if (!reportedSaveFailure) {
        reportedSaveFailure = true;
        diagnostic("credentials-save-failed");
      }
    });
  });

  socket.ev.on("connection.update", ({ connection, qr, isNewLogin, lastDisconnect }) => {
    if (closed) return;
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
      const status = lastDisconnect?.error?.output?.statusCode;
      diagnostic("connection-close", disconnectDiagnostic(lastDisconnect?.error));
      onClose?.({ loggedOut: status === DisconnectReason.loggedOut });
      resolveClosed();
    }
  });

  socket.ev.on("messages.upsert", (upsert) => {
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

  async function waitForClose() {
    if (closed) return;
    let timeout;
    try {
      await Promise.race([
        closedPromise,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Socket shutdown timed out")),
            SOCKET_CLOSE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async logout() {
      await socket.logout();
      await waitForClose();
    },
    async end() {
      if (!closed) socket.end();
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
