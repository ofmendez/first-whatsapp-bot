
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

import qrcode from "qrcode-terminal";
import pino from "pino";

async function start() {
  const { state, saveCreds } =
    await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({
    connection,
    qr,
    lastDisconnect,
  }) => {
    if (qr) {
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("WhatsApp connected!");
    }

    if (connection === "close") {
      const status =
        lastDisconnect?.error?.output?.statusCode;

      if (status !== DisconnectReason.loggedOut) {
        console.log("Connection lost");
      } else {
        console.log("Session logged out");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const message of messages) {
      if (message.key.fromMe) continue;

      const jid = message.key.remoteJid;

      const text =
        message.message?.conversation ??
        message.message?.extendedTextMessage?.text;

      if (!jid || !text || jid.endsWith("@g.us")) {
        continue;
      }

      console.log("Received:", text);

      if (text.trim().toLowerCase() === "!ping") {
        await sock.sendMessage(jid, {
          text: "Pong! Running on Bun 🚀",
        });
      }
    }
  });
}

start().catch(console.error);

