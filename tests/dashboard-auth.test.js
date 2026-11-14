import { expect, test } from "bun:test";
import {
  ALBUM_COOKIE_NAME,
  DashboardConfigurationError,
  albumCookie,
  clearAlbumCookie,
  clearDashboardCookie,
  createAlbumSessionService,
  createDashboardSessionService,
  dashboardCookie,
  isAllowedPanelOrigin,
  readDashboardConfig,
} from "@/src/dashboard-auth.js";
import { startControlPanel } from "@/index.js";

const dashboardPassphrase = "synthetic dashboard passphrase";

test("configuration fails closed without the dashboard passphrase and keeps diagnostics secret-free", () => {
  expect(() => readDashboardConfig({ PASS_ALBUM: "synthetic album passphrase" })).toThrow(
    DashboardConfigurationError,
  );

  try {
    readDashboardConfig({
      PASS_DASHBOAR: "",
      PASS_ALBUM: "synthetic album passphrase",
    });
  } catch (error) {
    expect(error.message).not.toContain("synthetic");
    return;
  }
  throw new Error("Expected missing dashboard configuration to fail.");
});

test("configuration accepts reserved album and canonical public origin without treating album as dashboard access", () => {
  const config = readDashboardConfig({
    PASS_DASHBOAR: dashboardPassphrase,
    PASS_ALBUM: "synthetic album passphrase",
    PANEL_ORIGIN: "https://panel.example.com",
  });

  expect(config).toEqual({
    dashboardPassphrase,
    albumPassphrase: "synthetic album passphrase",
    panelOrigin: "https://panel.example.com",
    albumOrigin: undefined,
  });

  const auth = createDashboardSessionService(config.dashboardPassphrase);
  expect(auth.authenticate(dashboardPassphrase)).toBe(true);
  expect(auth.authenticate(config.albumPassphrase)).toBe(false);
  expect(readDashboardConfig({ PASS_DASHBOAR: dashboardPassphrase }).panelOrigin).toBeUndefined();
});

test("dual-surface configuration accepts exact HTTPS origins on distinct hosts and ports", () => {
  expect(
    readDashboardConfig({
      PASS_DASHBOAR: dashboardPassphrase,
      PASS_ALBUM: "different synthetic album passphrase",
      PANEL_ORIGIN: "https://admin.localhost:8443",
      ALBUM_ORIGIN: "https://album.localhost:8444",
    }),
  ).toEqual({
    dashboardPassphrase,
    albumPassphrase: "different synthetic album passphrase",
    panelOrigin: "https://admin.localhost:8443",
    albumOrigin: "https://album.localhost:8444",
  });
});

test("PASS_ALBUM alone keeps the application in dashboard-only mode", () => {
  const config = readDashboardConfig({
    PASS_DASHBOAR: dashboardPassphrase,
    PASS_ALBUM: "synthetic album passphrase",
  });

  expect(config.panelOrigin).toBeUndefined();
  expect(config.albumOrigin).toBeUndefined();
});

test("dual-surface configuration rejects incomplete, ambiguous, and non-canonical values without secrets", () => {
  const dashboardSecret = "synthetic admin secret";
  const albumSecret = "synthetic independent album secret";
  const valid = {
    PASS_DASHBOAR: dashboardSecret,
    PASS_ALBUM: albumSecret,
    PANEL_ORIGIN: "https://admin.example.com:8443",
    ALBUM_ORIGIN: "https://album.example.com:9443",
  };
  const invalidConfigurations = [
    { ...valid, PASS_ALBUM: undefined },
    { ...valid, PASS_ALBUM: "" },
    { ...valid, PASS_ALBUM: dashboardSecret },
    { ...valid, PANEL_ORIGIN: undefined },
    { ...valid, PANEL_ORIGIN: "https://*.example.com" },
    { ...valid, PANEL_ORIGIN: "http://admin.example.com" },
    { ...valid, ALBUM_ORIGIN: "http://album.example.com" },
    { ...valid, ALBUM_ORIGIN: "https://album.example.com/" },
    { ...valid, ALBUM_ORIGIN: "https://user:pass@album.example.com" },
    { ...valid, ALBUM_ORIGIN: "https://album.example.com/path" },
    { ...valid, ALBUM_ORIGIN: "https://album.example.com?next=/" },
    { ...valid, ALBUM_ORIGIN: "https://*.example.com" },
    {
      ...valid,
      PANEL_ORIGIN: "https://same.example.com:8443",
      ALBUM_ORIGIN: "https://same.example.com:9443",
    },
  ];

  for (const environment of invalidConfigurations) {
    try {
      readDashboardConfig(environment);
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardConfigurationError);
      expect(error.message).not.toContain(dashboardSecret);
      expect(error.message).not.toContain(albumSecret);
      continue;
    }
    throw new Error("Expected invalid dual-surface configuration to fail.");
  }
});

test("application startup rejects missing dashboard credentials before creating a server", async () => {
  const originalPassphrase = process.env.PASS_DASHBOAR;
  delete process.env.PASS_DASHBOAR;
  try {
    await expect(startControlPanel()).rejects.toThrow(DashboardConfigurationError);
  } finally {
    if (originalPassphrase === undefined) delete process.env.PASS_DASHBOAR;
    else process.env.PASS_DASHBOAR = originalPassphrase;
  }
});

test("dual-surface startup wires album authentication into the loopback server without starting WhatsApp", async () => {
  const environment = {
    PASS_DASHBOAR: process.env.PASS_DASHBOAR,
    PASS_ALBUM: process.env.PASS_ALBUM,
    PANEL_ORIGIN: process.env.PANEL_ORIGIN,
    ALBUM_ORIGIN: process.env.ALBUM_ORIGIN,
    PANEL_PORT: process.env.PANEL_PORT,
  };
  process.env.PASS_DASHBOAR = "synthetic startup dashboard passphrase";
  process.env.PASS_ALBUM = "synthetic startup album passphrase";
  process.env.PANEL_ORIGIN = "https://admin.localhost:8443";
  process.env.ALBUM_ORIGIN = "https://album.localhost:8444";
  process.env.PANEL_PORT = "0";

  let started;
  try {
    started = await startControlPanel();
    expect(new URL(started.server.url).hostname).toBe("127.0.0.1");
    expect(started.manager.getSnapshot().status).toBe("stopped");

    const albumOrigin = "https://album.localhost:8444";
    const albumHost = new URL(albumOrigin).host;
    const response = await fetch(new URL("/api/album/auth/login", started.server.url), {
      method: "POST",
      headers: {
        Host: albumHost,
        Origin: albumOrigin,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ passphrase: "synthetic startup album passphrase" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toContain("album_session=");

    const unauthenticatedAlbum = await fetch(started.server.url, {
      headers: { Host: albumHost },
      redirect: "manual",
    });
    expect(unauthenticatedAlbum.status).toBe(302);
    expect(unauthenticatedAlbum.headers.get("location")).toBe("/login/");
  } finally {
    if (started) await started.shutdown();
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("configuration rejects non-HTTPS or non-canonical panel origins", () => {
  for (const PANEL_ORIGIN of [
    "http://panel.example.com",
    "https://panel.example.com/",
    "https://panel.example.com/dashboard",
    "https://user:password@panel.example.com",
    "https://panel.example.com?next=/",
    "https://*.*.example.com",
    "https://*.example.com/dashboard",
    "https://*.com",
    "https://*.127.0.0.1",
  ]) {
    expect(() => readDashboardConfig({ PASS_DASHBOAR: dashboardPassphrase, PANEL_ORIGIN })).toThrow(
      "PANEL_ORIGIN",
    );
  }
});

test("wildcard panel origins allow HTTPS subdomains only with the configured scheme and port", () => {
  const wildcard = "https://*.mydomain.com";
  const config = readDashboardConfig({
    PASS_DASHBOAR: dashboardPassphrase,
    PANEL_ORIGIN: wildcard,
  });

  expect(config.panelOrigin).toBe(wildcard);
  for (const allowedOrigin of [
    "https://dashboard.mydomain.com",
    "https://album.mydomain.com",
    "https://deep.dashboard.mydomain.com",
  ]) {
    expect(isAllowedPanelOrigin(allowedOrigin, wildcard)).toBe(true);
  }
  for (const rejectedOrigin of [
    "https://mydomain.com",
    "https://mydomain.com.evil.example",
    "https://evildomain.com",
    "https://other.example",
    "http://dashboard.mydomain.com",
    "https://dashboard.mydomain.com:8443",
    "null",
  ]) {
    expect(isAllowedPanelOrigin(rejectedOrigin, wildcard)).toBe(false);
  }

  const wildcardWithPort = "https://*.mydomain.com:8443";
  expect(
    readDashboardConfig({
      PASS_DASHBOAR: dashboardPassphrase,
      PANEL_ORIGIN: wildcardWithPort,
    }).panelOrigin,
  ).toBe(wildcardWithPort);
  expect(isAllowedPanelOrigin("https://dashboard.mydomain.com:8443", wildcardWithPort)).toBe(true);
  expect(isAllowedPanelOrigin("https://dashboard.mydomain.com", wildcardWithPort)).toBe(false);
});

test("album passphrase cannot equal the dashboard passphrase", () => {
  expect(() =>
    readDashboardConfig({
      PASS_DASHBOAR: dashboardPassphrase,
      PASS_ALBUM: dashboardPassphrase,
    }),
  ).toThrow("PASS_ALBUM must differ");
});

test("session authentication uses an opaque token and a secure browser-session cookie", () => {
  const auth = createDashboardSessionService(dashboardPassphrase);
  expect(auth.authenticate(dashboardPassphrase)).toBe(true);
  expect(auth.authenticate("incorrect passphrase")).toBe(false);
  expect(auth.authenticate(undefined)).toBe(false);

  const token = auth.createSession();
  const cookie = dashboardCookie(token);
  const request = new Request("https://panel.example.com/", {
    headers: { Cookie: cookie },
  });

  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).toContain("Path=/");
  expect(cookie).not.toContain("Domain=");
  expect(cookie).not.toContain("Expires=");
  expect(cookie).not.toContain("Max-Age=");
  expect(auth.isAuthorized(request, "dashboard")).toBe(true);
  expect(auth.isAuthorized(request, "album")).toBe(false);
});

test("sign-out revokes the session and clears the browser cookie", () => {
  const auth = createDashboardSessionService(dashboardPassphrase);
  const request = new Request("https://panel.example.com/", {
    headers: { Cookie: dashboardCookie(auth.createSession()) },
  });

  expect(auth.isAuthorized(request)).toBe(true);
  auth.revoke(request);
  expect(auth.isAuthorized(request)).toBe(false);
  expect(clearDashboardCookie()).toContain("Max-Age=0");
  expect(clearDashboardCookie()).toContain("HttpOnly");
  expect(clearDashboardCookie()).toContain("Secure");
  expect(clearDashboardCookie()).toContain("SameSite=Strict");
});

test("restarting the in-memory session service invalidates existing browser cookies", () => {
  const firstProcess = createDashboardSessionService(dashboardPassphrase);
  const request = new Request("https://panel.example.com/", {
    headers: { Cookie: dashboardCookie(firstProcess.createSession()) },
  });

  expect(firstProcess.isAuthorized(request)).toBe(true);
  const restartedProcess = createDashboardSessionService(dashboardPassphrase);
  expect(restartedProcess.isAuthorized(request)).toBe(false);
});

test("album sessions are independently authorized with a distinct secure host-only cookie", () => {
  const albumPassphrase = "synthetic album-only passphrase";
  const sessions = createAlbumSessionService(albumPassphrase);
  const token = sessions.createSession();
  const cookie = albumCookie(token);
  const request = new Request("https://album.example.com/", {
    headers: { Cookie: cookie },
  });

  expect(ALBUM_COOKIE_NAME).toBe("album_session");
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(sessions.authenticate(albumPassphrase)).toBe(true);
  expect(sessions.authenticate("wrong passphrase")).toBe(false);
  expect(sessions.isAuthorized(request, "album")).toBe(true);
  expect(sessions.isAuthorized(request, "dashboard")).toBe(false);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("SameSite=Strict");
  expect(cookie).toContain("Path=/");
  expect(cookie).not.toContain("Domain=");
  expect(cookie).not.toContain("Expires=");
  expect(cookie).not.toContain("Max-Age=");
  expect(clearAlbumCookie()).toContain("Max-Age=0");

  const afterRestart = createAlbumSessionService(albumPassphrase);
  expect(afterRestart.isAuthorized(request, "album")).toBe(false);
});

test("dashboard and album tokens cannot cross capabilities or cookie names", () => {
  const dashboardSessions = createDashboardSessionService(dashboardPassphrase);
  const albumSessions = createAlbumSessionService("synthetic album-only passphrase");
  const dashboardToken = dashboardSessions.createSession();
  const albumToken = albumSessions.createSession();
  const requestWithCookie = (cookie) =>
    new Request("https://surface.example.com/", { headers: { Cookie: cookie } });

  expect(dashboardSessions.isAuthorized(requestWithCookie(dashboardCookie(dashboardToken)))).toBe(
    true,
  );
  expect(albumSessions.isAuthorized(requestWithCookie(albumCookie(albumToken)))).toBe(true);
  expect(
    dashboardSessions.isAuthorized(requestWithCookie(dashboardCookie(albumToken)), "dashboard"),
  ).toBe(false);
  expect(
    dashboardSessions.isAuthorized(requestWithCookie(albumCookie(dashboardToken)), "dashboard"),
  ).toBe(false);
  expect(albumSessions.isAuthorized(requestWithCookie(albumCookie(dashboardToken)), "album")).toBe(
    false,
  );
  expect(albumSessions.isAuthorized(requestWithCookie(dashboardCookie(albumToken)), "album")).toBe(
    false,
  );
});

test("revoking one album session leaves other album sessions valid", () => {
  const sessions = createAlbumSessionService("synthetic album-only passphrase");
  const first = sessions.createSession();
  const second = sessions.createSession();
  const firstRequest = new Request("https://album.example.com/", {
    headers: { Cookie: albumCookie(first) },
  });
  const secondRequest = new Request("https://album.example.com/", {
    headers: { Cookie: albumCookie(second) },
  });

  sessions.revoke(firstRequest);

  expect(sessions.isAuthorized(firstRequest, "album")).toBe(false);
  expect(sessions.isAuthorized(secondRequest, "album")).toBe(true);
});
