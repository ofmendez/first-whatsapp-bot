import { startWhatsApp } from "./src/whatsapp.js";

startWhatsApp().catch(() => {
  console.error("WhatsApp startup failed");
});
