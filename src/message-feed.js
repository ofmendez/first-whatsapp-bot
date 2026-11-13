const DEFAULT_LIMIT = 200;

export function normalizeJid(jid) {
  return typeof jid === "string" ? jid.replace(/:\d+(?=@)/, "") : "";
}

export function extractText(message) {
  const text = message?.message?.conversation ?? message?.message?.extendedTextMessage?.text;

  return typeof text === "string" && text.trim() ? text : undefined;
}

function isDirectChatJid(jid) {
  const server = jid.slice(jid.lastIndexOf("@") + 1);
  return ["s.whatsapp.net", "lid", "c.us"].includes(server);
}

function toTimestamp(value) {
  const numeric = typeof value?.toNumber === "function" ? value.toNumber() : Number(value);

  if (!Number.isFinite(numeric) || numeric <= 0) return new Date().toISOString();
  const milliseconds = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function imageContent(message) {
  let content = message;
  for (let depth = 0; depth < 6 && content && typeof content === "object"; depth += 1) {
    if (content.imageMessage && typeof content.imageMessage === "object")
      return content.imageMessage;
    content =
      content.ephemeralMessage?.message ??
      content.viewOnceMessage?.message ??
      content.viewOnceMessageV2?.message ??
      content.viewOnceMessageV2Extension?.message ??
      content.documentWithCaptionMessage?.message;
  }
  return undefined;
}

export function projectLiveImages(upsert, selfJids = []) {
  if (upsert?.type !== "notify" || !Array.isArray(upsert.messages)) return [];

  const self = new Set(selfJids.map(normalizeJid).filter(Boolean));
  const projected = [];

  for (const message of upsert.messages) {
    const remoteJid = message?.key?.remoteJid;
    if (typeof remoteJid !== "string" || !remoteJid.includes("@") || !isDirectChatJid(remoteJid))
      continue;

    const content = imageContent(message.message);
    if (!content) continue;

    const isSelfChat = self.has(normalizeJid(remoteJid));
    if (message.key?.fromMe && !isSelfChat) continue;

    projected.push({
      message,
      remoteJid: normalizeJid(remoteJid),
      direction: message.key?.fromMe ? "outgoing" : "incoming",
      isSelfChat,
      label: isSelfChat
        ? "Message yourself"
        : (typeof message.pushName === "string" && message.pushName.trim()) || "Direct chat",
      timestamp: toTimestamp(message.messageTimestamp),
      mimeType: typeof content.mimetype === "string" ? content.mimetype : undefined,
      caption: typeof content.caption === "string" && content.caption ? content.caption : undefined,
    });
  }

  return projected;
}

export function projectLiveMessages(upsert, selfJids = []) {
  if (upsert?.type !== "notify" || !Array.isArray(upsert.messages)) return [];

  const self = new Set(selfJids.map(normalizeJid).filter(Boolean));
  const projected = [];

  for (const message of upsert.messages) {
    const remoteJid = message?.key?.remoteJid;
    if (typeof remoteJid !== "string" || !remoteJid.includes("@") || !isDirectChatJid(remoteJid))
      continue;

    const text = extractText(message);
    if (text === undefined) continue;

    const isSelfChat = self.has(normalizeJid(remoteJid));
    projected.push({
      direction: message.key?.fromMe ? "outgoing" : "incoming",
      isSelfChat,
      label: isSelfChat
        ? "Message yourself"
        : (typeof message.pushName === "string" && message.pushName.trim()) || "Direct chat",
      timestamp: toTimestamp(message.messageTimestamp),
      text,
    });
  }

  return projected;
}

export class MessageFeed {
  #limit;
  #sequence = 0;
  #messages = [];

  constructor(limit = DEFAULT_LIMIT) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  append(message) {
    const item = { ...message, id: ++this.#sequence, sequence: this.#sequence };
    this.#messages.push(item);
    if (this.#messages.length > this.#limit) {
      this.#messages.splice(0, this.#messages.length - this.#limit);
    }
    return item;
  }

  snapshot() {
    return this.#messages.map((message) => ({ ...message }));
  }

  clear() {
    this.#messages = [];
  }
}
