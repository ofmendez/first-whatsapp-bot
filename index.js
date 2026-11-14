import { rm } from "node:fs/promises";
import { AlbumImageCatalog } from "@/src/album-catalog.js";
import { ImageReceiver } from "@/src/image-receiver.js";
import { ReceivedImageStore } from "@/src/received-image-store.js";
import { createControlHandler } from "@/src/control-server.js";
import {
  createAlbumSessionService,
  createDashboardSessionService,
  DashboardConfigurationError,
  readDashboardConfig,
} from "@/src/dashboard-auth.js";
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
  const configuration = readDashboardConfig();
  const dashboardAuth = createDashboardSessionService(configuration.dashboardPassphrase);
  const albumAuth = configuration.albumOrigin
    ? createAlbumSessionService(configuration.albumPassphrase)
    : undefined;
  const imageStore = new ReceivedImageStore({ root: "./received-images/" });
  const albumCatalog = new AlbumImageCatalog({ store: imageStore });
  await albumCatalog.refresh();
  const imageReceiver = new ImageReceiver({
    store: imageStore,
    download: downloadImageStream,
    onSaved: () => albumCatalog.notifyChanged(),
    isConversationApproved: (conversationId) => albumCatalog.isConversationApproved(conversationId),
  });
  const manager = new SessionController({
    createSession: createWhatsAppSession,
    clearAuth: () => rm("./auth_info", { recursive: true, force: true }),
    imageReceiver,
    albumService: imageStore,
    albumCatalog,
    onAlbumApproved: ({ conversationId }) => {
      albumCatalog.markConversationApproved(conversationId);
      return albumCatalog.notifyChanged().then(() => {
        albumCatalog.markConversationApproved(conversationId);
      });
    },
    selfChatValidation: process.env.WHATSAPP_SELF_CHAT_VALIDATION ?? "not-run",
  });

  let server;
  const handle = createControlHandler({
    manager,
    mediaStore: imageStore,
    dashboardAuth,
    albumAuth,
    albumCatalog,
    distDirectory: "./dist",
    expectedOrigin: () => configuration.panelOrigin ?? `http://127.0.0.1:${server.port}`,
    panelOrigin: configuration.panelOrigin,
    albumOrigin: configuration.albumOrigin,
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
    } else if (error instanceof DashboardConfigurationError) {
      console.error(error.message);
    } else {
      console.error("Control panel startup failed");
    }
    process.exitCode = 1;
  });
}
