import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { processUpsert } from "@/src/messages.js";
import { normalizeJid } from "@/src/message-feed.js";

const SOCKET_CLOSE_TIMEOUT_MS = 5000;

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

export async function createWhatsAppSession({ onPairing, onOpen, onClose, onUpsert }) {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
  const socket = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    markOnlineOnConnect: false,
  });

  let closed = false;
  let resolveClosed;
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  socket.ev.on("creds.update", () => {
    void saveCreds().catch(() => {});
  });

  socket.ev.on("connection.update", ({ connection, qr, lastDisconnect }) => {
    if (qr) onPairing?.(qr);
    if (connection === "open") onOpen?.();
    if (connection === "close" && !closed) {
      closed = true;
      const status = lastDisconnect?.error?.output?.statusCode;
      onClose?.({ loggedOut: status === DisconnectReason.loggedOut });
      resolveClosed();
    }
  });

  socket.ev.on("messages.upsert", (upsert) => {
    void processUpsert(upsert, (jid, content) => socket.sendMessage(jid, content)).catch(() => {});
    try {
      onUpsert?.(upsert, accountJids(socket.user));
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
