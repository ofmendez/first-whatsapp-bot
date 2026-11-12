import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import { processUpsert } from "./messages.js";

export async function startWhatsApp() {
  const { state, saveCreds } =
    await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("WhatsApp connected!");
    }

    if (connection === "close") {
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status !== DisconnectReason.loggedOut) {
        console.log("Connection lost");
      } else {
        console.log("Session logged out");
      }
    }
  });

  sock.ev.on("messages.upsert", (upsert) =>
    processUpsert(upsert, (jid, content) => sock.sendMessage(jid, content)),
  );
}
