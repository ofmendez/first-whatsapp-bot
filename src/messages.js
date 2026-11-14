import { replyForCommand } from "@/src/commands.js";
import { normalizeJid } from "@/src/message-feed.js";

const ALBUM_COMMAND = "inicia album";
const ALBUM_CONFIRMATION = "Hemos iniciado, ya estoy disponible!";
const DIRECT_CHAT_SERVERS = new Set(["s.whatsapp.net", "lid", "c.us"]);

function messageText(message) {
  return message?.message?.conversation ?? message?.message?.extendedTextMessage?.text;
}

function normalizeAlbumCommand(text) {
  return typeof text === "string"
    ? text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase()
    : "";
}

function isDirectContact(jid) {
  if (typeof jid !== "string" || !jid.includes("@")) return false;
  return DIRECT_CHAT_SERVERS.has(jid.slice(jid.lastIndexOf("@") + 1));
}

export async function processUpsert(
  { messages, type },
  send,
  { accountJids = [], albumService, onAlbumApproved } = {},
) {
  if (type !== "notify") return;

  const activeAccountJids = Array.isArray(accountJids) ? accountJids : [];
  const normalizedAccounts = new Set(activeAccountJids.map(normalizeJid).filter(Boolean));
  const accountJid = normalizeJid(activeAccountJids[0]);
  for (const message of messages) {
    if (message.key.fromMe) continue;

    const jid = message.key.remoteJid;
    const text = messageText(message);

    if (!jid || !text || jid.endsWith("@g.us")) continue;

    const reply = replyForCommand(text);
    if (reply) {
      await send(jid, { text: reply });
      continue;
    }

    if (
      normalizeAlbumCommand(text) !== ALBUM_COMMAND ||
      message.key?.fromMe !== false ||
      !accountJid ||
      !isDirectContact(jid) ||
      normalizedAccounts.has(normalizeJid(jid)) ||
      typeof albumService?.approveConversation !== "function"
    ) {
      continue;
    }

    const approval = await albumService.approveConversation({
      accountJid,
      chatJid: jid,
      displayName: message.pushName || "unknown-contact",
    });
    if (!approval?.approved) continue;
    if (approval.newlyApproved || approval.reactivated) {
      try {
        onAlbumApproved?.(approval);
      } catch {
        // A transient dashboard update must not undo durable approval.
      }
    }
    if (approval.shouldConfirm) {
      await send(jid, { text: ALBUM_CONFIRMATION });
    }
  }
}
