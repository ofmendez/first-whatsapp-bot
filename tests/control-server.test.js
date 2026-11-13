import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, mock, test } from "bun:test";
import { createControlHandler } from "@/src/control-server.js";

function createManager() {
  const listeners = new Set();
  const manager = {
    state: { status: "stopped", qr: null, messages: [], selfChatValidation: "not-run" },
    start: mock(async () => manager.state),
    cancel: mock(async () => manager.state),
    logout: mock(async () => manager.state),
    sendSelf: mock(async () => ({ ok: true })),
    getSnapshot: mock(() => manager.state),
    subscribe: mock((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(update) {
      for (const listener of listeners) listener(update);
    },
  };
  return manager;
}

const origin = "http://127.0.0.1:3217";
const jsonPost = (path, body = {}, headers = {}) =>
  new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

test("same-origin control requests work without CORS headers", async () => {
  const manager = createManager();
  const handle = createControlHandler({ manager, expectedOrigin: origin });
  const response = await handle(jsonPost("/api/session/start"));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: manager.state });
  expect(manager.start).toHaveBeenCalledTimes(1);
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("cross-origin and originless state-changing requests are rejected before action", async () => {
  const manager = createManager();
  const handle = createControlHandler({ manager, expectedOrigin: origin });
  const crossOrigin = jsonPost("/api/session/logout", {}, { Origin: "https://attacker.example" });
  const missingOrigin = new Request(`${origin}/api/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  expect((await handle(crossOrigin)).status).toBe(403);
  expect((await handle(missingOrigin)).status).toBe(403);
  expect(manager.logout).not.toHaveBeenCalled();
  expect(manager.start).not.toHaveBeenCalled();
});

test("send endpoint rejects client-selected destinations before calling the sender", async () => {
  const manager = createManager();
  const handle = createControlHandler({ manager, expectedOrigin: origin });
  const response = await handle(
    jsonPost("/api/messages/send", {
      text: "synthetic message",
      recipient: "group@g.us",
    }),
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Only message text is accepted; the destination is fixed to your own chat.",
  });
  expect(manager.sendSelf).not.toHaveBeenCalled();
});

test("mutation endpoints require JSON and reject fetch metadata from other sites", async () => {
  const manager = createManager();
  const handle = createControlHandler({ manager, expectedOrigin: origin });
  const formRequest = new Request(`${origin}/api/session/start`, {
    method: "POST",
    headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "text/plain" },
    body: "start",
  });
  const crossSite = jsonPost("/api/session/start", {}, { "Sec-Fetch-Site": "cross-site" });

  expect((await handle(formRequest)).status).toBe(415);
  expect((await handle(crossSite)).status).toBe(403);
  expect(manager.start).not.toHaveBeenCalled();
});

test("event stream sends the initial state and new updates without persistent storage", async () => {
  const manager = createManager();
  const abort = new AbortController();
  const handle = createControlHandler({ manager, expectedOrigin: origin });
  const response = await handle(new Request(`${origin}/api/events`, { signal: abort.signal }));
  const reader = response.body.getReader();

  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const initial = new TextDecoder().decode((await reader.read()).value);
  expect(initial).toContain('"type":"state"');
  expect(initial).toContain('"status":"stopped"');

  manager.emit({ type: "message", message: { id: 1, text: "ephemeral synthetic body" } });
  const update = new TextDecoder().decode((await reader.read()).value);
  expect(update).toContain('"type":"message"');
  expect(update).toContain("ephemeral synthetic body");

  manager.emit({
    type: "message",
    message: {
      id: 2,
      sequence: 2,
      kind: "image",
      direction: "incoming",
      label: "Synthetic contact",
      timestamp: "2026-11-12T12:00:00.000Z",
      caption: "synthetic caption",
      previewUrl: "/api/media/e97f4567-2b76-4a29-8ad9-7201c4a2b75b",
      unavailable: false,
    },
  });
  const imageUpdate = new TextDecoder().decode((await reader.read()).value);
  expect(imageUpdate).toContain('"kind":"image"');
  expect(imageUpdate).toContain('"previewUrl":"/api/media/e97f4567-2b76-4a29-8ad9-7201c4a2b75b"');
  expect(imageUpdate).toContain("synthetic caption");
  expect(imageUpdate).not.toContain("owner@s.whatsapp.net");
  expect(imageUpdate).not.toContain("contact@s.whatsapp.net");
  expect(imageUpdate).not.toContain("/private/local/path");
  expect(imageUpdate).not.toContain("synthetic image bytes");
  abort.abort();
  await reader.cancel().catch(() => {});
  expect(typeof manager.subscribe.mock.results[0].value).toBe("function");
});

test("media route serves only registered image IDs with private response headers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "whatsapp-media-route-test-"));
  const imagePath = join(directory, "synthetic-image.png");
  const mediaId = "e97f4567-2b76-4a29-8ad9-7201c4a2b75b";
  const mediaStore = {
    openMedia: mock(async (id) =>
      id === mediaId ? { path: imagePath, contentType: "image/png" } : undefined,
    ),
  };
  try {
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const handle = createControlHandler({
      manager: createManager(),
      mediaStore,
      expectedOrigin: origin,
    });
    const response = await handle(new Request(`${origin}/api/media/${mediaId}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );

    const unknown = await handle(
      new Request(`${origin}/api/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`),
    );
    const pathLike = await handle(new Request(`${origin}/api/media/%2e%2e%2fetc%2fpasswd`));
    const nested = await handle(new Request(`${origin}/api/media/${mediaId}/extra`));
    expect(unknown.status).toBe(404);
    expect(pathLike.status).toBe(404);
    expect(nested.status).toBe(404);
    expect(mediaStore.openMedia).toHaveBeenCalledTimes(3);

    const unsupported = createControlHandler({
      manager: createManager(),
      mediaStore: { openMedia: async () => ({ path: imagePath, contentType: "text/html" }) },
    });
    expect((await unsupported(new Request(`${origin}/api/media/${mediaId}`))).status).toBe(404);
    const method = await handle(new Request(`${origin}/api/media/${mediaId}`, { method: "HEAD" }));
    expect(method.status).toBe(405);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("same Bun server process serves static Astro output and control API on loopback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "whatsapp-panel-test-"));
  await mkdir(join(directory, "_astro"));
  await writeFile(
    join(directory, "index.html"),
    '<link rel="stylesheet" href="/_astro/panel.css"><main>static panel fixture</main>',
  );
  await writeFile(join(directory, "_astro", "panel.css"), ".panel { color: teal; }");
  const manager = createManager();
  let server;
  const handle = createControlHandler({
    manager,
    distDirectory: directory,
    expectedOrigin: () => `http://127.0.0.1:${server.port}`,
  });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });

  try {
    expect(new URL(server.url).hostname).toBe("127.0.0.1");
    const page = await fetch(server.url);
    expect(await page.text()).toContain('href="/_astro/panel.css"');
    const stylesheet = await fetch(new URL("/_astro/panel.css", server.url));
    expect(stylesheet.headers.get("content-type")).toContain("text/css");
    expect(await stylesheet.text()).toBe(".panel { color: teal; }");
    const state = await fetch(new URL("/api/state", server.url));
    expect((await state.json()).state.status).toBe("stopped");
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
