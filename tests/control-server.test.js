import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { expect, mock, test } from "bun:test";
import { AlbumImageCatalog, AlbumPaginationError } from "@/src/album-catalog.js";
import { createControlHandler } from "@/src/control-server.js";
import { ReceivedImageStore } from "@/src/received-image-store.js";
import {
  albumCookie,
  createAlbumSessionService,
  createDashboardSessionService,
  dashboardCookie,
} from "@/src/dashboard-auth.js";

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
const publicOrigin = "https://panel.example.com";
const albumPublicOrigin = "https://album.example.com";
const localAdminOrigin = "https://admin.localhost:8443";
const localAlbumOrigin = "https://album.localhost:8444";
const dashboardPassphrase = "synthetic dashboard passphrase";
const albumPassphrase = "synthetic album passphrase";
const mediaId = "e97f4567-2b76-4a29-8ad9-7201c4a2b75b";
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

function createPanel({
  manager = createManager(),
  mediaStore,
  albumCatalog,
  distDirectory = "./dist",
  expectedOrigin = origin,
  panelOrigin,
  albumOrigin,
  albumAuth,
  dashboardAuth,
} = {}) {
  const dashboardSessions = dashboardAuth ?? createDashboardSessionService(dashboardPassphrase);
  const cookie = dashboardCookie(dashboardSessions.createSession());
  const handler = createControlHandler({
    manager,
    mediaStore,
    albumCatalog,
    dashboardAuth: dashboardSessions,
    albumAuth,
    distDirectory,
    expectedOrigin,
    panelOrigin,
    albumOrigin,
  });
  const withDashboardSession = (request) => {
    const headers = new Headers(request.headers);
    headers.set("Cookie", cookie);
    return handler(new Request(request, { headers }));
  };
  return {
    handler,
    withDashboardSession,
    dashboardAuth: dashboardSessions,
    albumAuth,
    cookie,
    manager,
  };
}

test("same-origin control requests work without CORS headers", async () => {
  const panel = createPanel();
  const response = await panel.withDashboardSession(jsonPost("/api/session/start"));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ state: panel.manager.state });
  expect(panel.manager.start).toHaveBeenCalledTimes(1);
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("cross-origin and originless state-changing requests are rejected before action", async () => {
  const panel = createPanel();
  const crossOrigin = jsonPost("/api/session/logout", {}, { Origin: "https://attacker.example" });
  const missingOrigin = new Request(`${origin}/api/session/start`, {
    method: "POST",
    headers: {
      Cookie: panel.cookie,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  expect((await panel.withDashboardSession(crossOrigin)).status).toBe(403);
  expect((await panel.withDashboardSession(missingOrigin)).status).toBe(403);
  expect(panel.manager.logout).not.toHaveBeenCalled();
  expect(panel.manager.start).not.toHaveBeenCalled();
});

test("send endpoint rejects client-selected destinations before calling the sender", async () => {
  const panel = createPanel();
  const response = await panel.withDashboardSession(
    jsonPost("/api/messages/send", {
      text: "synthetic message",
      recipient: "group@g.us",
    }),
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Only message text is accepted; the destination is fixed to your own chat.",
  });
  expect(panel.manager.sendSelf).not.toHaveBeenCalled();
});

test("mutation endpoints require JSON and reject fetch metadata from other sites", async () => {
  const panel = createPanel();
  const formRequest = new Request(`${origin}/api/session/start`, {
    method: "POST",
    headers: {
      Cookie: panel.cookie,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "text/plain",
    },
    body: "start",
  });
  const crossSite = jsonPost("/api/session/start", {}, { "Sec-Fetch-Site": "cross-site" });

  expect((await panel.withDashboardSession(formRequest)).status).toBe(415);
  expect((await panel.withDashboardSession(crossSite)).status).toBe(403);
  expect(panel.manager.start).not.toHaveBeenCalled();
});

test("event stream sends the initial state and new updates only to a dashboard session", async () => {
  const panel = createPanel();
  const abort = new AbortController();
  const response = await panel.withDashboardSession(
    new Request(`${origin}/api/events`, { signal: abort.signal }),
  );
  const reader = response.body.getReader();

  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const initial = new TextDecoder().decode((await reader.read()).value);
  expect(initial).toContain('"type":"state"');
  expect(initial).toContain('"status":"stopped"');

  panel.manager.emit({ type: "message", message: { id: 1, text: "ephemeral synthetic body" } });
  const update = new TextDecoder().decode((await reader.read()).value);
  expect(update).toContain('"type":"message"');
  expect(update).toContain("ephemeral synthetic body");

  panel.manager.emit({
    type: "message",
    message: {
      id: 2,
      sequence: 2,
      kind: "image",
      direction: "incoming",
      label: "Synthetic contact",
      conversationId: "c".repeat(64),
      albumed: true,
      timestamp: "2026-11-12T12:00:00.000Z",
      caption: "synthetic caption",
      previewUrl: `/api/media/${mediaId}`,
      unavailable: false,
    },
  });
  const imageUpdate = new TextDecoder().decode((await reader.read()).value);
  expect(imageUpdate).toContain('"kind":"image"');
  expect(imageUpdate).toContain(`"conversationId":"${"c".repeat(64)}"`);
  expect(imageUpdate).toContain('"albumed":true');
  expect(imageUpdate).toContain(`"previewUrl":"/api/media/${mediaId}"`);
  expect(imageUpdate).toContain("synthetic caption");
  expect(imageUpdate).not.toContain("owner@s.whatsapp.net");
  expect(imageUpdate).not.toContain("contact@s.whatsapp.net");
  expect(imageUpdate).not.toContain("/private/local/path");
  expect(imageUpdate).not.toContain("synthetic image bytes");
  abort.abort();
  await reader.cancel().catch(() => {});
  expect(typeof panel.manager.subscribe.mock.results[0].value).toBe("function");
});

test("media route serves only registered image IDs with private response headers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "whatsapp-media-route-test-"));
  const imagePath = join(directory, "synthetic-image.png");
  const mediaStore = {
    openMedia: mock(async (id) =>
      id === mediaId ? { path: imagePath, contentType: "image/png" } : undefined,
    ),
  };
  try {
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const panel = createPanel({ mediaStore });
    const response = await panel.withDashboardSession(
      new Request(`${origin}/api/media/${mediaId}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );

    const unknown = await panel.withDashboardSession(
      new Request(`${origin}/api/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`),
    );
    const pathLike = await panel.withDashboardSession(
      new Request(`${origin}/api/media/%2e%2e%2fetc%2fpasswd`),
    );
    const nested = await panel.withDashboardSession(
      new Request(`${origin}/api/media/${mediaId}/extra`),
    );
    expect(unknown.status).toBe(404);
    expect(pathLike.status).toBe(404);
    expect(nested.status).toBe(404);
    expect(mediaStore.openMedia).toHaveBeenCalledTimes(2);

    const unsupported = createPanel({
      mediaStore: { openMedia: async () => ({ path: imagePath, contentType: "text/html" }) },
    });
    expect(
      (await unsupported.withDashboardSession(new Request(`${origin}/api/media/${mediaId}`)))
        .status,
    ).toBe(404);
    const method = await panel.withDashboardSession(
      new Request(`${origin}/api/media/${mediaId}`, { method: "HEAD" }),
    );
    expect(method.status).toBe(405);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unauthenticated page, API, event, media, and control requests disclose nothing or cause side effects", async () => {
  const manager = createManager();
  const mediaStore = { openMedia: mock(async () => undefined) };
  const panel = createPanel({ manager, mediaStore });
  const page = await panel.handler(new Request(`${origin}/`));
  const state = await panel.handler(new Request(`${origin}/api/state`));
  const events = await panel.handler(new Request(`${origin}/api/events`));
  const media = await panel.handler(new Request(`${origin}/api/media/${mediaId}`));

  expect(page.status).toBe(302);
  expect(page.headers.get("location")).toBe("/login/");
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(await page.text()).toBe("");
  expect(state.status).toBe(401);
  expect(await state.json()).toEqual({ error: "Authentication required." });
  expect(events.status).toBe(401);
  expect(media.status).toBe(401);

  for (const path of [
    "/api/session/start",
    "/api/session/cancel",
    "/api/session/logout",
    "/api/messages/send",
  ]) {
    expect((await panel.handler(jsonPost(path, {}))).status).toBe(401);
  }

  expect(manager.getSnapshot).not.toHaveBeenCalled();
  expect(manager.subscribe).not.toHaveBeenCalled();
  expect(mediaStore.openMedia).not.toHaveBeenCalled();
  expect(manager.start).not.toHaveBeenCalled();
  expect(manager.cancel).not.toHaveBeenCalled();
  expect(manager.logout).not.toHaveBeenCalled();
  expect(manager.sendSelf).not.toHaveBeenCalled();
});

test("login endpoint issues only a secure cookie and returns generic failures", async () => {
  const panel = createPanel();
  const incorrect = await panel.handler(
    jsonPost("/api/auth/login", { passphrase: "wrong passphrase" }),
  );
  expect(incorrect.status).toBe(401);
  expect(await incorrect.json()).toEqual({ error: "Authentication failed." });
  expect(incorrect.headers.get("set-cookie")).toBeNull();

  const correct = await panel.handler(
    jsonPost("/api/auth/login", { passphrase: dashboardPassphrase }),
  );
  expect(correct.status).toBe(200);
  expect(await correct.json()).toEqual({ ok: true });
  const cookie = correct.headers.get("set-cookie");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).toContain("Path=/");
  expect(cookie).not.toContain("Domain=");
  expect(cookie).not.toContain("Max-Age=");
  expect(cookie).not.toContain("Expires=");
  expect(cookie).not.toContain(dashboardPassphrase);

  const authorized = await panel.handler(
    new Request(`${origin}/api/state`, {
      headers: { Cookie: cookie.split(";")[0] },
    }),
  );
  expect(authorized.status).toBe(200);
  expect(panel.manager.getSnapshot).toHaveBeenCalledTimes(1);
});

test("album login and logout are confined to its exact local HTTPS origin", async () => {
  const albumAuth = createAlbumSessionService(albumPassphrase);
  albumAuth.authenticate = mock(albumAuth.authenticate);
  const panel = createPanel({
    albumAuth,
    expectedOrigin: localAdminOrigin,
    panelOrigin: localAdminOrigin,
    albumOrigin: localAlbumOrigin,
  });
  const albumHost = new URL(localAlbumOrigin).host;
  const adminHost = new URL(localAdminOrigin).host;
  const albumPost = (path, body, headers = {}) =>
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: {
        Host: albumHost,
        Origin: localAlbumOrigin,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });

  const wrongOrigin = await panel.handler(
    albumPost(
      "/api/album/auth/login",
      { passphrase: albumPassphrase },
      { Origin: localAdminOrigin },
    ),
  );
  expect(wrongOrigin.status).toBe(403);
  expect(wrongOrigin.headers.get("set-cookie")).toBeNull();
  expect(wrongOrigin.headers.get("cache-control")).toBe("no-store");

  const crossSite = await panel.handler(
    albumPost(
      "/api/album/auth/login",
      { passphrase: albumPassphrase },
      { "Sec-Fetch-Site": "cross-site" },
    ),
  );
  expect(crossSite.status).toBe(403);

  const incorrect = await panel.handler(
    albumPost("/api/album/auth/login", { passphrase: "wrong passphrase" }),
  );
  expect(incorrect.status).toBe(401);
  expect(await incorrect.json()).toEqual({ error: "No se pudo iniciar sesión." });
  expect(incorrect.headers.get("set-cookie")).toBeNull();

  const dashboardCredentialOnAlbum = await panel.handler(
    albumPost("/api/album/auth/login", { passphrase: dashboardPassphrase }),
  );
  expect(dashboardCredentialOnAlbum.status).toBe(401);
  expect(await dashboardCredentialOnAlbum.json()).toEqual({
    error: "No se pudo iniciar sesión.",
  });

  const albumCredentialOnAdmin = await panel.handler(
    new Request(`${origin}/api/auth/login`, {
      method: "POST",
      headers: {
        Host: new URL(localAdminOrigin).host,
        Origin: localAdminOrigin,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ passphrase: albumPassphrase }),
    }),
  );
  expect(albumCredentialOnAdmin.status).toBe(401);
  expect(await albumCredentialOnAdmin.json()).toEqual({
    error: "Authentication failed.",
  });

  const malformed = await panel.handler(
    new Request(`${origin}/api/album/auth/login`, {
      method: "POST",
      headers: {
        Host: albumHost,
        Origin: localAlbumOrigin,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: "{",
    }),
  );
  expect(malformed.status).toBe(401);
  expect(await malformed.json()).toEqual({ error: "No se pudo iniciar sesión." });

  const authCallsBeforeAdminRequest = albumAuth.authenticate.mock.calls.length;
  const createdOnAdmin = await panel.handler(
    new Request(`${origin}/api/album/auth/login`, {
      method: "POST",
      headers: {
        Host: adminHost,
        Origin: localAdminOrigin,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ passphrase: albumPassphrase }),
    }),
  );
  expect(createdOnAdmin.status).toBe(404);
  expect(createdOnAdmin.headers.get("set-cookie")).toBeNull();
  expect(albumAuth.authenticate.mock.calls).toHaveLength(authCallsBeforeAdminRequest);

  const correct = await panel.handler(
    albumPost("/api/album/auth/login", { passphrase: albumPassphrase }),
  );
  expect(correct.status).toBe(200);
  expect(correct.headers.get("cache-control")).toBe("no-store");
  const body = await correct.json();
  const setCookie = correct.headers.get("set-cookie");
  const token = /album_session=([^;]+)/.exec(setCookie)?.[1];
  expect(body).toEqual({ ok: true });
  expect(JSON.stringify(body)).not.toContain(albumPassphrase);
  expect(JSON.stringify(body)).not.toContain(token);
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).toContain("Path=/");
  expect(setCookie).not.toContain("Domain=");
  expect(
    albumAuth.isAuthorized(
      new Request(`${origin}/`, { headers: { Cookie: albumCookie(token) } }),
      "album",
    ),
  ).toBe(true);

  const logout = await panel.handler(
    albumPost("/api/album/auth/logout", {}, { Cookie: `album_session=${token}` }),
  );
  expect(logout.status).toBe(200);
  expect(logout.headers.get("cache-control")).toBe("no-store");
  expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(
    albumAuth.isAuthorized(
      new Request(`${origin}/`, { headers: { Cookie: `album_session=${token}` } }),
      "album",
    ),
  ).toBe(false);
  expect(panel.manager.start).not.toHaveBeenCalled();
  expect(panel.manager.logout).not.toHaveBeenCalled();
});

test("album image APIs require the album capability and remain unavailable on other surfaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "whatsapp-album-api-test-"));
  const imagePath = join(directory, "synthetic.png");
  const albumAuth = createAlbumSessionService(albumPassphrase);
  const albumCatalog = {
    listPage: mock(async ({ limit, cursor }) => {
      if (limit === "0" || cursor === "bad") throw new AlbumPaginationError();
      return {
        items: [{ id: mediaId, mediaUrl: `/api/album/media/${mediaId}`, date: "2026-11-12" }],
        nextCursor: null,
      };
    }),
    openMedia: mock(async () => ({ path: imagePath, contentType: "image/png" })),
  };
  const mediaStore = { openMedia: mock(async () => undefined) };
  const panel = createPanel({
    albumAuth,
    albumCatalog,
    mediaStore,
    expectedOrigin: localAdminOrigin,
    panelOrigin: localAdminOrigin,
    albumOrigin: localAlbumOrigin,
  });
  const dashboardToken = panel.dashboardAuth.createSession();
  const albumToken = albumAuth.createSession();
  const requestFor = (selectedOrigin, pathname, { method = "GET", cookie } = {}) =>
    new Request(`${origin}${pathname}`, {
      method,
      headers: {
        Host: new URL(selectedOrigin).host,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });

  try {
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    for (const pathname of ["/api/album/images", `/api/album/media/${mediaId}`]) {
      expect((await panel.handler(requestFor(localAlbumOrigin, pathname))).status).toBe(401);
      expect(
        (
          await panel.handler(
            requestFor(localAlbumOrigin, pathname, {
              cookie: albumCookie(dashboardToken),
            }),
          )
        ).status,
      ).toBe(401);
    }

    for (const pathname of ["/api/album/images", `/api/album/media/${mediaId}`]) {
      expect(
        (
          await panel.handler(
            requestFor(localAdminOrigin, pathname, {
              cookie: albumCookie(albumToken),
            }),
          )
        ).status,
      ).toBe(404);
    }
    expect(
      (
        await panel.handler(
          requestFor(localAlbumOrigin, `/api/media/${mediaId}`, {
            cookie: albumCookie(albumToken),
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await panel.handler(
          requestFor(localAlbumOrigin, "/api/album/images", {
            method: "HEAD",
            cookie: albumCookie(albumToken),
          }),
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await panel.handler(
          requestFor(localAlbumOrigin, `/api/album/media/${mediaId}`, {
            method: "POST",
            cookie: albumCookie(albumToken),
          }),
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await panel.handler(
          requestFor(localAlbumOrigin, "/api/album/media/%2e%2e%2fprivate", {
            cookie: albumCookie(albumToken),
          }),
        )
      ).status,
    ).toBe(404);

    expect(albumCatalog.listPage).not.toHaveBeenCalled();
    expect(albumCatalog.openMedia).not.toHaveBeenCalled();
    expect(mediaStore.openMedia).not.toHaveBeenCalled();

    const list = await panel.handler(
      requestFor(localAlbumOrigin, "/api/album/images", {
        cookie: albumCookie(albumToken),
      }),
    );
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(list.headers.get("x-content-type-options")).toBe("nosniff");
    expect(list.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(list.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await list.json()).toEqual({
      items: [{ id: mediaId, mediaUrl: `/api/album/media/${mediaId}`, date: "2026-11-12" }],
      nextCursor: null,
    });

    const media = await panel.handler(
      requestFor(localAlbumOrigin, `/api/album/media/${mediaId}`, {
        cookie: albumCookie(albumToken),
      }),
    );
    expect(media.status).toBe(200);
    expect(media.headers.get("content-type")).toBe("image/png");
    expect(media.headers.get("cache-control")).toBe("no-store");
    expect(media.headers.get("x-content-type-options")).toBe("nosniff");
    expect(media.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );

    const invalidPagination = await panel.handler(
      requestFor(localAlbumOrigin, "/api/album/images?limit=0", {
        cookie: albumCookie(albumToken),
      }),
    );
    expect(invalidPagination.status).toBe(400);
    expect(await invalidPagination.json()).toEqual({ error: "Invalid album pagination." });
    expect(albumCatalog.listPage).toHaveBeenCalledTimes(2);
    expect(albumCatalog.openMedia).toHaveBeenCalledTimes(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("album media remains approved-only and rechecks files after restart and between requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "whatsapp-album-media-integration-"));
  try {
    const store = new ReceivedImageStore({ root });
    const accountJid = "owner@s.whatsapp.net";
    const chatJid = "contact@s.whatsapp.net";
    await store.approveConversation({ accountJid, chatJid, displayName: "Contact" });
    const imageBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ]);
    const saved = await store.save({
      accountJid,
      chatJid,
      displayName: "Contact",
      messageId: "integration-image",
      timestamp: "2026-11-12T12:00:00.000Z",
      mimeType: "image/png",
      stream: Readable.from([imageBytes]),
    });
    const unapprovedChatJid = "not-approved@s.whatsapp.net";
    const unapproved = await store.save({
      accountJid,
      chatJid: unapprovedChatJid,
      displayName: "Not approved",
      messageId: "known-unapproved-image",
      timestamp: "2026-11-12T12:00:00.000Z",
      mimeType: "image/png",
      stream: Readable.from([imageBytes]),
    });
    const nonImage = await store.save({
      accountJid,
      chatJid,
      displayName: "Contact",
      messageId: "not-really-an-image",
      timestamp: "2026-11-12T12:01:00.000Z",
      mimeType: "image/png",
      stream: Readable.from([Buffer.from("<html>synthetic non-image</html>")]),
    });
    const albumAuth = createAlbumSessionService(albumPassphrase);
    const albumToken = albumAuth.createSession();
    const albumCookieHeader = albumCookie(albumToken);
    const createPanelWithCatalog = (catalog) =>
      createPanel({
        albumAuth,
        albumCatalog: catalog,
        expectedOrigin: localAdminOrigin,
        panelOrigin: localAdminOrigin,
        albumOrigin: localAlbumOrigin,
      });
    const requestFor = (panel, path) =>
      panel.handler(
        new Request(`${origin}${path}`, {
          headers: {
            Host: new URL(localAlbumOrigin).host,
            Cookie: albumCookieHeader,
          },
        }),
      );

    const afterRestart = new AlbumImageCatalog({ store: new ReceivedImageStore({ root }) });
    const panel = createPanelWithCatalog(afterRestart);
    const knownButUnapproved = await requestFor(panel, `/api/album/media/${unapproved.imageId}`);
    expect(knownButUnapproved.status).toBe(404);

    const directMedia = await requestFor(panel, `/api/album/media/${saved.imageId}`);
    expect(directMedia.status).toBe(200);
    expect(new Uint8Array(await directMedia.arrayBuffer())).toEqual(new Uint8Array(imageBytes));

    const listed = await requestFor(panel, "/api/album/images");
    expect(listed.status).toBe(200);
    const albumPage = await listed.json();
    expect(albumPage.items.map(({ id }) => id)).toEqual([saved.imageId]);
    expect(JSON.stringify(albumPage)).not.toContain(root);
    expect(JSON.stringify(albumPage)).not.toContain(accountJid);
    expect(JSON.stringify(albumPage)).not.toContain(chatJid);
    expect((await requestFor(panel, `/api/album/media/${nonImage.imageId}`)).status).toBe(404);

    const folder = dirname(saved.path);
    const approvalPath = join(folder, "album.json");
    const approval = JSON.parse(await readFile(approvalPath, "utf8"));
    await writeFile(approvalPath, JSON.stringify({ ...approval, albumed: false }), {
      mode: 0o600,
    });
    expect((await requestFor(panel, `/api/album/media/${saved.imageId}`)).status).toBe(404);

    await writeFile(approvalPath, JSON.stringify(approval), { mode: 0o600 });
    expect((await requestFor(panel, "/api/album/images")).status).toBe(200);
    await rm(saved.path);
    const deleted = await requestFor(panel, `/api/album/media/${saved.imageId}`);
    expect(deleted.status).toBe(404);
    expect(await deleted.text()).not.toContain(root);

    await writeFile(saved.path, imageBytes, { mode: 0o600 });
    await rm(saved.path);
    await symlink(unapproved.path, saved.path);
    const linked = await requestFor(panel, `/api/album/media/${saved.imageId}`);
    expect(linked.status).toBe(404);
    expect(await linked.text()).not.toContain(root);

    const invalidPagination = await requestFor(panel, "/api/album/images?limit=0");
    expect(invalidPagination.status).toBe(400);
    const repeatedPagination = await requestFor(panel, "/api/album/images?limit=24&limit=24");
    expect(repeatedPagination.status).toBe(400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native form fallbacks POST credentials to auth endpoints without exposing them in URLs", async () => {
  const albumAuth = createAlbumSessionService(albumPassphrase);
  const panel = createPanel({
    albumAuth,
    expectedOrigin: localAdminOrigin,
    panelOrigin: localAdminOrigin,
    albumOrigin: localAlbumOrigin,
  });
  const formPost = (selectedOrigin, path, passphrase) =>
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: {
        Host: new URL(selectedOrigin).host,
        Origin: selectedOrigin,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `passphrase=${encodeURIComponent(passphrase)}`,
    });

  const albumResponse = await panel.handler(
    formPost(localAlbumOrigin, "/api/album/auth/login", albumPassphrase),
  );
  const adminResponse = await panel.handler(
    formPost(localAdminOrigin, "/api/auth/login", dashboardPassphrase),
  );

  expect(
    new URL(formPost(localAlbumOrigin, "/api/album/auth/login", albumPassphrase).url).search,
  ).toBe("");
  expect(albumResponse.status).toBe(401);
  expect(await albumResponse.json()).toEqual({ error: "No se pudo iniciar sesión." });
  expect(albumResponse.headers.get("set-cookie")).toBeNull();
  expect(albumResponse.headers.get("cache-control")).toBe("no-store");
  expect(adminResponse.status).toBe(401);
  expect(await adminResponse.json()).toEqual({ error: "Authentication failed." });
  expect(adminResponse.headers.get("set-cookie")).toBeNull();
});

test("sign-out revokes only the dashboard session and does not log out WhatsApp", async () => {
  const panel = createPanel();
  const response = await panel.handler(jsonPost("/api/auth/logout", {}, { Cookie: panel.cookie }));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(
    panel.dashboardAuth.isAuthorized(
      new Request(`${origin}/`, { headers: { Cookie: panel.cookie } }),
    ),
  ).toBe(false);
  expect(
    (await panel.handler(new Request(`${origin}/api/state`, { headers: { Cookie: panel.cookie } })))
      .status,
  ).toBe(401);
  expect(panel.manager.logout).not.toHaveBeenCalled();
  expect(panel.manager.stopForProcessExit).toBeUndefined();
});

test("login and sign-out reject missing or untrusted origins without creating or revoking sessions", async () => {
  const panel = createPanel();
  const wrongOriginLogin = await panel.handler(
    jsonPost(
      "/api/auth/login",
      { passphrase: dashboardPassphrase },
      { Origin: "https://attacker.example" },
    ),
  );
  expect(wrongOriginLogin.status).toBe(403);
  expect(wrongOriginLogin.headers.get("set-cookie")).toBeNull();

  const untrustedSignOut = await panel.handler(
    jsonPost(
      "/api/auth/logout",
      {},
      {
        Origin: "https://attacker.example",
        Cookie: panel.cookie,
      },
    ),
  );
  expect(untrustedSignOut.status).toBe(403);
  expect(
    panel.dashboardAuth.isAuthorized(
      new Request(`${origin}/`, { headers: { Cookie: panel.cookie } }),
    ),
  ).toBe(true);

  const missingOriginSignOut = await panel.handler(
    new Request(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: panel.cookie, "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  expect(missingOriginSignOut.status).toBe(403);
  expect(
    panel.dashboardAuth.isAuthorized(
      new Request(`${origin}/`, { headers: { Cookie: panel.cookie } }),
    ),
  ).toBe(true);
});

test("configured public HTTPS origin works through a proxy without trusting forwarded-host headers", async () => {
  const panel = createPanel({
    expectedOrigin: publicOrigin,
    panelOrigin: publicOrigin,
  });
  const proxiedLogin = await panel.handler(
    new Request(`${origin}/api/auth/login`, {
      method: "POST",
      headers: {
        Origin: publicOrigin,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ passphrase: dashboardPassphrase }),
    }),
  );
  expect(proxiedLogin.status).toBe(200);

  const proxiedAction = await panel.handler(
    new Request(`${origin}/api/session/start`, {
      method: "POST",
      headers: {
        Cookie: panel.cookie,
        Origin: publicOrigin,
        "Sec-Fetch-Site": "same-origin",
        "X-Forwarded-Host": "untrusted.example",
        "X-Forwarded-Proto": "http",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
  );
  expect(proxiedAction.status).toBe(200);
  expect(panel.manager.start).toHaveBeenCalledTimes(1);

  const spoofedForwardedHost = await panel.handler(
    new Request(`${origin}/api/session/logout`, {
      method: "POST",
      headers: {
        Cookie: panel.cookie,
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "same-origin",
        "X-Forwarded-Host": "panel.example.com",
        "X-Forwarded-Proto": "https",
        Forwarded: "proto=https;host=panel.example.com",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
  );
  expect(spoofedForwardedHost.status).toBe(403);
  expect(panel.manager.logout).not.toHaveBeenCalled();
});

test("configured wildcard origin authorizes matching subdomains but not the apex or spoofed origins", async () => {
  const wildcard = "https://*.mydomain.com";
  const panel = createPanel({ expectedOrigin: wildcard, panelOrigin: wildcard });

  const dashboardLogin = await panel.handler(
    new Request(`${origin}/api/auth/login`, {
      method: "POST",
      headers: {
        Origin: "https://dashboard.mydomain.com",
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ passphrase: dashboardPassphrase }),
    }),
  );
  expect(dashboardLogin.status).toBe(200);

  const albumHostAction = await panel.handler(
    new Request(`${origin}/api/session/start`, {
      method: "POST",
      headers: {
        Cookie: panel.cookie,
        Origin: "https://deep.album.mydomain.com",
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
  );
  expect(albumHostAction.status).toBe(200);
  expect(panel.manager.start).toHaveBeenCalledTimes(1);

  for (const requestOrigin of [
    "https://mydomain.com",
    "https://mydomain.com.evil.example",
    "http://dashboard.mydomain.com",
    "https://dashboard.mydomain.com:8443",
  ]) {
    const rejected = await panel.handler(
      new Request(`${origin}/api/session/logout`, {
        method: "POST",
        headers: {
          Cookie: panel.cookie,
          Origin: requestOrigin,
          "Sec-Fetch-Site": "same-origin",
          "X-Forwarded-Host": "dashboard.mydomain.com",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(rejected.status).toBe(403);
  }

  expect(panel.manager.logout).not.toHaveBeenCalled();
});

test("Bun server keeps dashboard HTML private while serving login and static assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "whatsapp-panel-test-"));
  await mkdir(join(directory, "_astro"));
  await mkdir(join(directory, "login"));
  await writeFile(join(directory, "index.html"), "<main>protected dashboard fixture</main>");
  await writeFile(join(directory, "login", "index.html"), "<main>public login fixture</main>");
  await writeFile(join(directory, "_astro", "panel.01234567.css"), ".panel { color: teal; }");

  const manager = createManager();
  let server;
  const panel = createPanel({
    manager,
    distDirectory: directory,
    expectedOrigin: () => `http://127.0.0.1:${server.port}`,
  });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: panel.handler });

  try {
    expect(new URL(server.url).hostname).toBe("127.0.0.1");
    const privatePage = await fetch(server.url, { redirect: "manual" });
    expect(privatePage.status).toBe(302);
    expect(privatePage.headers.get("location")).toBe("/login/");

    const loginPage = await fetch(new URL("/login/", server.url));
    expect(loginPage.status).toBe(200);
    expect(loginPage.headers.get("cache-control")).toBe("no-store");
    expect(await loginPage.text()).toContain("public login fixture");

    const stylesheet = await fetch(new URL("/_astro/panel.01234567.css", server.url));
    expect(stylesheet.headers.get("content-type")).toContain("text/css");
    expect(await stylesheet.text()).toBe(".panel { color: teal; }");

    const dashboard = await fetch(server.url, { headers: { Cookie: panel.cookie } });
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain("protected dashboard fixture");
    const state = await fetch(new URL("/api/state", server.url), {
      headers: { Cookie: panel.cookie },
    });
    expect((await state.json()).state.status).toBe("stopped");
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("static serving rejects encoded paths, internal files, unversioned assets, and symlink escapes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "whatsapp-static-boundary-test-"));
  const outsideDirectory = await mkdtemp(join(tmpdir(), "whatsapp-static-outside-test-"));
  const assetDirectory = join(directory, "_astro");
  const outsideFile = join(outsideDirectory, "secret.css");
  await mkdir(assetDirectory, { recursive: true });
  await mkdir(join(directory, "login"), { recursive: true });
  await writeFile(join(directory, "index.html"), "<main>protected</main>");
  await writeFile(join(directory, "login", "index.html"), "<main>login</main>");
  await writeFile(outsideFile, "private content");
  await writeFile(join(assetDirectory, "theme.ABCDE123.css"), ".theme { color: plum; }");
  await symlink(outsideFile, join(assetDirectory, "linked.ABCDE123.css"));

  const panel = createPanel({ distDirectory: directory });
  const request = (pathname, method = "GET") => new Request(`${origin}${pathname}`, { method });

  try {
    const asset = await panel.handler(request("/_astro/theme.ABCDE123.css"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await asset.text()).toContain("plum");

    const head = await panel.handler(request("/_astro/theme.ABCDE123.css", "HEAD"));
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("content-type")).toContain("text/css");

    for (const pathname of [
      "/_astro/theme.css",
      "/_astro/nested/theme.ABCDE123.css",
      "/_astro/linked.ABCDE123.css",
      "/_astro/%2e%2e%2findex.html",
      "/%69ndex.html",
      "/album/index.html",
      "/album/login/index.html",
    ]) {
      expect((await panel.handler(request(pathname))).status).toBe(404);
    }

    expect((await panel.handler(request("/", "POST"))).status).toBe(405);
    expect((await panel.handler(request("/login/", "POST"))).status).toBe(405);
    expect((await panel.handler(request("/_astro/theme.ABCDE123.css", "POST"))).status).toBe(405);
    expect((await panel.handler(request("/api/state", "HEAD"))).status).toBe(405);
    expect(panel.manager.getSnapshot).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outsideDirectory, { recursive: true, force: true });
  }
});

test("dual-surface document maps keep admin and album build documents behind their public aliases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "whatsapp-dual-document-test-"));
  await mkdir(join(directory, "login"), { recursive: true });
  await mkdir(join(directory, "album", "login"), { recursive: true });
  await writeFile(join(directory, "index.html"), "<main>admin document</main>");
  await writeFile(join(directory, "login", "index.html"), "<main>admin login</main>");
  await writeFile(join(directory, "album", "index.html"), "<main>album document</main>");
  await writeFile(join(directory, "album", "login", "index.html"), "<main>album login</main>");

  const albumAuth = createAlbumSessionService(albumPassphrase);
  const panel = createPanel({
    distDirectory: directory,
    expectedOrigin: localAdminOrigin,
    panelOrigin: localAdminOrigin,
    albumOrigin: localAlbumOrigin,
    albumAuth,
  });
  const requestFor = (selectedOrigin, pathname, headers = {}) =>
    new Request(`${origin}${pathname}`, {
      headers: {
        Host: new URL(selectedOrigin).host,
        ...headers,
      },
    });

  try {
    for (const selectedOrigin of [localAdminOrigin, localAlbumOrigin]) {
      const root = await panel.handler(requestFor(selectedOrigin, "/"));
      const index = await panel.handler(requestFor(selectedOrigin, "/index.html"));
      expect(root.status).toBe(302);
      expect(index.status).toBe(302);
      expect(root.headers.get("location")).toBe("/login/");
      expect(root.headers.get("cache-control")).toBe("no-store");

      const login = await panel.handler(requestFor(selectedOrigin, "/login/"));
      const loginAlias = await panel.handler(requestFor(selectedOrigin, "/login/index.html"));
      expect(login.status).toBe(200);
      expect(loginAlias.status).toBe(200);
      expect(login.headers.get("cache-control")).toBe("no-store");
      expect(loginAlias.headers.get("cache-control")).toBe("no-store");
    }

    const adminLogin = await panel.handler(requestFor(localAdminOrigin, "/login/"));
    const albumLogin = await panel.handler(requestFor(localAlbumOrigin, "/login/"));
    expect(await adminLogin.text()).toContain("admin login");
    expect(await albumLogin.text()).toContain("album login");

    const adminPage = await panel.withDashboardSession(requestFor(localAdminOrigin, "/index.html"));
    const albumToken = albumAuth.createSession();
    const albumPage = await panel.handler(
      requestFor(localAlbumOrigin, "/index.html", {
        Cookie: albumCookie(albumToken),
      }),
    );
    expect(adminPage.status).toBe(200);
    expect(albumPage.status).toBe(200);
    expect(await adminPage.text()).toContain("admin document");
    expect(await albumPage.text()).toContain("album document");

    for (const selectedOrigin of [localAdminOrigin, localAlbumOrigin]) {
      for (const internalPath of ["/album/", "/album/index.html", "/album/login/index.html"]) {
        expect((await panel.handler(requestFor(selectedOrigin, internalPath))).status).toBe(404);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("surface API allowlists reject cross-capability and dashboard-service routes before dispatch", async () => {
  const manager = createManager();
  const mediaStore = { openMedia: mock(async () => undefined) };
  const albumCatalog = {
    listPage: mock(async () => ({ items: [], nextCursor: null })),
    openMedia: mock(async () => undefined),
  };
  const dashboardAuth = createDashboardSessionService(dashboardPassphrase);
  const albumAuth = createAlbumSessionService(albumPassphrase);
  const albumToken = albumAuth.createSession();
  dashboardAuth.isAuthorized = mock(dashboardAuth.isAuthorized);
  albumAuth.isAuthorized = mock(albumAuth.isAuthorized);
  albumAuth.authenticate = mock(albumAuth.authenticate);
  albumAuth.createSession = mock(albumAuth.createSession);
  albumAuth.revoke = mock(albumAuth.revoke);

  const panel = createPanel({
    manager,
    mediaStore,
    albumCatalog,
    dashboardAuth,
    albumAuth,
    expectedOrigin: localAdminOrigin,
    panelOrigin: localAdminOrigin,
    albumOrigin: localAlbumOrigin,
  });
  const cookie = `${panel.cookie}; ${albumCookie(albumToken)}`;
  const requestFor = (selectedOrigin, pathname, method = "GET") =>
    new Request(`${origin}${pathname}`, {
      method,
      headers: {
        Host: new URL(selectedOrigin).host,
        Cookie: cookie,
        Origin: selectedOrigin,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    });

  for (const [pathname, method] of [
    ["/api/state", "GET"],
    ["/api/events", "GET"],
    [`/api/media/${mediaId}`, "GET"],
    ["/api/auth/login", "POST"],
    ["/api/session/start", "POST"],
    ["/api/session/cancel", "POST"],
    ["/api/session/logout", "POST"],
    ["/api/messages/send", "POST"],
  ]) {
    const response = await panel.handler(requestFor(localAlbumOrigin, pathname, method));
    expect(response.status).toBe(404);
  }

  for (const pathname of ["/api/album/auth/login", "/api/album/auth/logout"]) {
    const response = await panel.handler(requestFor(localAdminOrigin, pathname, "POST"));
    expect(response.status).toBe(404);
  }
  for (const pathname of ["/api/album/images", `/api/album/media/${mediaId}`]) {
    const response = await panel.handler(requestFor(localAdminOrigin, pathname, "GET"));
    expect(response.status).toBe(404);
  }

  const unknownHost = await panel.handler(
    requestFor("https://unknown.localhost:8444", "/api/state"),
  );
  expect(unknownHost.status).toBe(404);
  expect(manager.getSnapshot).not.toHaveBeenCalled();
  expect(manager.subscribe).not.toHaveBeenCalled();
  expect(manager.start).not.toHaveBeenCalled();
  expect(manager.cancel).not.toHaveBeenCalled();
  expect(manager.logout).not.toHaveBeenCalled();
  expect(manager.sendSelf).not.toHaveBeenCalled();
  expect(mediaStore.openMedia).not.toHaveBeenCalled();
  expect(albumCatalog.listPage).not.toHaveBeenCalled();
  expect(albumCatalog.openMedia).not.toHaveBeenCalled();
  expect(dashboardAuth.isAuthorized).not.toHaveBeenCalled();
  expect(albumAuth.isAuthorized).not.toHaveBeenCalled();
  expect(albumAuth.authenticate).not.toHaveBeenCalled();
  expect(albumAuth.createSession).not.toHaveBeenCalled();
  expect(albumAuth.revoke).not.toHaveBeenCalled();
});

test("two-host request matrix enforces documents, capabilities, origins, methods, and public assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "whatsapp-surface-matrix-test-"));
  await mkdir(join(directory, "login"), { recursive: true });
  await mkdir(join(directory, "album", "login"), { recursive: true });
  await mkdir(join(directory, "_astro"), { recursive: true });
  await writeFile(join(directory, "index.html"), "<main>admin-only</main>");
  await writeFile(join(directory, "login", "index.html"), "<main>admin sign-in</main>");
  await writeFile(join(directory, "album", "index.html"), "<main>album-only</main>");
  await writeFile(join(directory, "album", "login", "index.html"), "<main>album sign-in</main>");
  await writeFile(join(directory, "_astro", "sample.ABCDE123.jpg"), "public demo image");

  const manager = createManager();
  const mediaStore = { openMedia: mock(async () => undefined) };
  const albumCatalog = {
    listPage: mock(async () => ({ items: [], nextCursor: null })),
    openMedia: mock(async () => undefined),
  };
  const dashboardAuth = createDashboardSessionService(dashboardPassphrase);
  const albumAuth = createAlbumSessionService(albumPassphrase);
  const dashboardToken = dashboardAuth.createSession();
  const albumToken = albumAuth.createSession();
  const albumAuthenticate = mock(albumAuth.authenticate);
  const albumCreateSession = mock(albumAuth.createSession);
  const albumRevoke = mock(albumAuth.revoke);
  albumAuth.authenticate = albumAuthenticate;
  albumAuth.createSession = albumCreateSession;
  albumAuth.revoke = albumRevoke;

  const panel = createPanel({
    manager,
    mediaStore,
    albumCatalog,
    dashboardAuth,
    albumAuth,
    distDirectory: directory,
    expectedOrigin: localAdminOrigin,
    panelOrigin: localAdminOrigin,
    albumOrigin: localAlbumOrigin,
  });
  const requestFor = (
    selectedOrigin,
    pathname,
    { method = "GET", cookie, requestOrigin, fetchSite, body } = {},
  ) => {
    const headers = { Host: new URL(selectedOrigin).host };
    if (cookie) headers.Cookie = cookie;
    if (requestOrigin !== undefined) headers.Origin = requestOrigin;
    if (fetchSite !== undefined) headers["Sec-Fetch-Site"] = fetchSite;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return new Request(`${origin}${pathname}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };

  try {
    for (const selectedOrigin of [localAdminOrigin, localAlbumOrigin]) {
      const unauthenticated = await panel.handler(requestFor(selectedOrigin, "/"));
      expect(unauthenticated.status).toBe(302);
      expect(unauthenticated.headers.get("location")).toBe("/login/");
      expect(await unauthenticated.text()).toBe("");
    }

    const adminApiUnauthenticated = await panel.handler(requestFor(localAdminOrigin, "/api/state"));
    const albumDashboardApi = await panel.handler(
      requestFor(localAlbumOrigin, "/api/state", {
        cookie: `${dashboardCookie(dashboardToken)}; ${albumCookie(albumToken)}`,
      }),
    );
    expect(adminApiUnauthenticated.status).toBe(401);
    expect(albumDashboardApi.status).toBe(404);
    expect(manager.getSnapshot).not.toHaveBeenCalled();

    const validAdmin = await panel.handler(
      requestFor(localAdminOrigin, "/", { cookie: dashboardCookie(dashboardToken) }),
    );
    const validAlbum = await panel.handler(
      requestFor(localAlbumOrigin, "/", { cookie: albumCookie(albumToken) }),
    );
    expect(validAdmin.status).toBe(200);
    expect(validAlbum.status).toBe(200);
    expect(await validAdmin.text()).toContain("admin-only");
    expect(await validAlbum.text()).toContain("album-only");

    for (const [selectedOrigin, wrongCookie] of [
      [localAdminOrigin, dashboardCookie(albumToken)],
      [localAdminOrigin, albumCookie(dashboardToken)],
      [localAlbumOrigin, albumCookie(dashboardToken)],
      [localAlbumOrigin, dashboardCookie(albumToken)],
    ]) {
      const wrongCapability = await panel.handler(
        requestFor(selectedOrigin, "/", { cookie: wrongCookie }),
      );
      expect(wrongCapability.status).toBe(302);
      expect(await wrongCapability.text()).toBe("");
    }

    for (const selectedOrigin of [localAdminOrigin, localAlbumOrigin]) {
      const image = await panel.handler(requestFor(selectedOrigin, "/_astro/sample.ABCDE123.jpg"));
      const head = await panel.handler(
        requestFor(selectedOrigin, "/_astro/sample.ABCDE123.jpg", { method: "HEAD" }),
      );
      expect(image.status).toBe(200);
      expect(image.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(await image.text()).toBe("public demo image");
      expect(head.status).toBe(200);
      expect(head.body).toBeNull();
    }

    for (const path of ["/album/index.html", "/album/login/index.html"]) {
      expect((await panel.handler(requestFor(localAdminOrigin, path))).status).toBe(404);
      expect((await panel.handler(requestFor(localAlbumOrigin, path))).status).toBe(404);
    }

    const siblingAdminMutation = await panel.handler(
      requestFor(localAdminOrigin, "/api/session/start", {
        method: "POST",
        cookie: dashboardCookie(dashboardToken),
        requestOrigin: localAlbumOrigin,
        fetchSite: "same-site",
        body: {},
      }),
    );
    const originlessAdminMutation = await panel.handler(
      requestFor(localAdminOrigin, "/api/session/start", {
        method: "POST",
        cookie: dashboardCookie(dashboardToken),
        body: {},
      }),
    );
    const siblingAlbumLogin = await panel.handler(
      requestFor(localAlbumOrigin, "/api/album/auth/login", {
        method: "POST",
        requestOrigin: localAdminOrigin,
        fetchSite: "same-site",
        body: { passphrase: albumPassphrase },
      }),
    );
    const originlessAlbumLogout = await panel.handler(
      requestFor(localAlbumOrigin, "/api/album/auth/logout", {
        method: "POST",
        cookie: albumCookie(albumToken),
        body: {},
      }),
    );
    expect(siblingAdminMutation.status).toBe(403);
    expect(originlessAdminMutation.status).toBe(403);
    expect(siblingAlbumLogin.status).toBe(403);
    expect(originlessAlbumLogout.status).toBe(403);
    expect(manager.start).not.toHaveBeenCalled();
    expect(albumAuthenticate).not.toHaveBeenCalled();
    expect(albumCreateSession).not.toHaveBeenCalled();
    expect(albumRevoke).not.toHaveBeenCalled();

    for (const [selectedOrigin, pathname, method] of [
      [localAdminOrigin, "/", "POST"],
      [localAdminOrigin, "/api/session/start", "GET"],
      [localAdminOrigin, "/api/state", "HEAD"],
      [localAlbumOrigin, "/api/album/auth/logout", "GET"],
    ]) {
      const response = await panel.handler(requestFor(selectedOrigin, pathname, { method }));
      expect(response.status).toBe(405);
    }

    const unknownHost = await panel.handler(
      requestFor("https://unknown.localhost:8444", "/api/state", {
        cookie: `${dashboardCookie(dashboardToken)}; ${albumCookie(albumToken)}`,
      }),
    );
    expect(unknownHost.status).toBe(404);

    const permittedAdminMutation = await panel.handler(
      requestFor(localAdminOrigin, "/api/session/start", {
        method: "POST",
        cookie: dashboardCookie(dashboardToken),
        requestOrigin: localAdminOrigin,
        fetchSite: "same-origin",
        body: {},
      }),
    );
    expect(permittedAdminMutation.status).toBe(200);
    expect(manager.start).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot).not.toHaveBeenCalled();
    expect(manager.subscribe).not.toHaveBeenCalled();
    expect(mediaStore.openMedia).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
