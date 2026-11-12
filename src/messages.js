import { replyForCommand } from "./commands.js";

export async function processUpsert({ messages, type }, send) {
  if (type !== "notify") return;

  for (const message of messages) {
    if (message.key.fromMe) continue;

    const jid = message.key.remoteJid;
    const text =
      message.message?.conversation ??
      message.message?.extendedTextMessage?.text;

    if (!jid || !text || jid.endsWith("@g.us")) continue;

    const reply = replyForCommand(text);
    if (reply) {
      await send(jid, { text: reply });
    }
  }
}
