import { rm } from "node:fs/promises";
import { ImageReceiver } from "@/src/image-receiver.js";
import { ReceivedImageStore } from "@/src/received-image-store.js";
import { createControlHandler } from "@/src/control-server.js";
import { SessionController } from "@/src/session-controller.js";
import { createWhatsAppSession, downloadImageStream } from "@/src/whatsapp.js";

function panelPort(value) {
  const port = value === undefined || value === "" ? 3008 : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Invalid panel port");
  }
  return port;
}

export async function startControlPanel() {
  const imageStore = new ReceivedImageStore({ root: "./received-images/" });
  const imageReceiver = new ImageReceiver({ store: imageStore, download: downloadImageStream });
  const manager = new SessionController({
    createSession: createWhatsAppSession,
    clearAuth: () => rm("./auth_info", { recursive: true, force: true }),
    imageReceiver,
    selfChatValidation: process.env.WHATSAPP_SELF_CHAT_VALIDATION ?? "not-run",
  });

  let server;
  const handle = createControlHandler({
    manager,
    mediaStore: imageStore,
    distDirectory: "./dist",
    expectedOrigin: () => `http://127.0.0.1:${server.port}`,
  });

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: panelPort(process.env.PANEL_PORT),
    idleTimeout: 60,
    fetch: handle,
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await manager.stopForProcessExit();
    server.stop(true);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("exit", () => manager.clearTransient());

  console.log(`Control panel listening at http://127.0.0.1:${server.port}`);
  return { manager, server, shutdown };
}

if (import.meta.main) {
  startControlPanel().catch((error) => {
    if (error?.code === "EADDRINUSE") {
      const port = process.env.PANEL_PORT || "3008";
      console.error(
        `Control panel port ${port} is already in use. Set PANEL_PORT to another local port.`,
      );
      return;
    }
    console.error("Control panel startup failed");
  });
}
