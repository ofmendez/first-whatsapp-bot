import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const DASHBOARD_COOKIE_NAME = "dashboard_session";
export const ALBUM_COOKIE_NAME = "album_session";
const WILDCARD_PANEL_ORIGIN_PREFIX = "https://*.";

export class DashboardConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DashboardConfigurationError";
  }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseWildcardPanelOrigin(value) {
  if (typeof value !== "string" || !value.startsWith(WILDCARD_PANEL_ORIGIN_PREFIX)) {
    return undefined;
  }

  const authority = value.slice(WILDCARD_PANEL_ORIGIN_PREFIX.length);
  if (!authority || /[*\/?#@]/.test(authority)) return undefined;

  try {
    const base = new URL(`https://${authority}`);
    if (
      base.protocol !== "https:" ||
      base.origin !== `https://${authority}` ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash ||
      base.hostname.endsWith(".") ||
      base.hostname.split(".").length < 2 ||
      isIP(base.hostname) !== 0
    ) {
      return undefined;
    }
    return { hostname: base.hostname, port: base.port };
  } catch {
    return undefined;
  }
}

function parseExactHttpsOrigin(value) {
  if (typeof value !== "string" || value.includes("*")) return undefined;

  try {
    const origin = new URL(value);
    if (
      origin.protocol !== "https:" ||
      origin.origin !== value ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.hostname.endsWith(".")
    ) {
      return undefined;
    }
    return origin;
  } catch {
    return undefined;
  }
}

export function readDashboardConfig(environment = process.env) {
  const dashboardPassphrase = environment.PASS_DASHBOAR;
  const albumPassphrase = environment.PASS_ALBUM;
  const configuredOrigin = environment.PANEL_ORIGIN;
  const configuredAlbumOrigin = environment.ALBUM_ORIGIN;

  if (typeof dashboardPassphrase !== "string" || dashboardPassphrase.length === 0) {
    throw new DashboardConfigurationError(
      "Required dashboard configuration is missing: PASS_DASHBOAR.",
    );
  }
  if (albumPassphrase !== undefined && typeof albumPassphrase !== "string") {
    throw new DashboardConfigurationError("Invalid reserved configuration: PASS_ALBUM.");
  }
  if (albumPassphrase && albumPassphrase === dashboardPassphrase) {
    throw new DashboardConfigurationError("PASS_ALBUM must differ from PASS_DASHBOAR.");
  }
  if (configuredAlbumOrigin !== undefined && typeof configuredAlbumOrigin !== "string") {
    throw new DashboardConfigurationError("Invalid album origin configuration: ALBUM_ORIGIN.");
  }

  let panelOrigin;
  let exactPanelOrigin;
  let wildcardPanelOrigin = false;
  if (configuredOrigin !== undefined && configuredOrigin !== "") {
    if (configuredOrigin.startsWith(WILDCARD_PANEL_ORIGIN_PREFIX)) {
      if (!parseWildcardPanelOrigin(configuredOrigin)) {
        throw new DashboardConfigurationError(
          "PANEL_ORIGIN must be a canonical HTTPS origin or an HTTPS subdomain wildcard without a path.",
        );
      }
      panelOrigin = configuredOrigin;
      wildcardPanelOrigin = true;
    } else {
      exactPanelOrigin = parseExactHttpsOrigin(configuredOrigin);
      if (!exactPanelOrigin) {
        throw new DashboardConfigurationError(
          "PANEL_ORIGIN must be a canonical HTTPS origin or an HTTPS subdomain wildcard without a path.",
        );
      }
      panelOrigin = exactPanelOrigin.origin;
    }
  }

  let albumOrigin;
  if (configuredAlbumOrigin) {
    const exactAlbumOrigin = parseExactHttpsOrigin(configuredAlbumOrigin);
    if (!exactAlbumOrigin) {
      throw new DashboardConfigurationError(
        "ALBUM_ORIGIN must be a canonical exact HTTPS origin without a path.",
      );
    }
    if (wildcardPanelOrigin || !exactPanelOrigin) {
      throw new DashboardConfigurationError(
        "PANEL_ORIGIN must be a canonical exact HTTPS origin when ALBUM_ORIGIN is enabled.",
      );
    }
    if (exactPanelOrigin.hostname === exactAlbumOrigin.hostname) {
      throw new DashboardConfigurationError(
        "PANEL_ORIGIN and ALBUM_ORIGIN must use distinct hostnames.",
      );
    }
    if (typeof albumPassphrase !== "string" || albumPassphrase.length === 0) {
      throw new DashboardConfigurationError("Required album configuration is missing: PASS_ALBUM.");
    }
    if (albumPassphrase === dashboardPassphrase) {
      throw new DashboardConfigurationError("PASS_ALBUM must differ from PASS_DASHBOAR.");
    }
    albumOrigin = exactAlbumOrigin.origin;
  }

  return { dashboardPassphrase, albumPassphrase, panelOrigin, albumOrigin };
}

export function isAllowedPanelOrigin(requestOrigin, configuredOrigin) {
  if (typeof requestOrigin !== "string" || typeof configuredOrigin !== "string") return false;
  const wildcard = parseWildcardPanelOrigin(configuredOrigin);
  if (!wildcard) return requestOrigin === configuredOrigin;

  try {
    const parsedOrigin = new URL(requestOrigin);
    return (
      parsedOrigin.origin === requestOrigin &&
      parsedOrigin.protocol === "https:" &&
      parsedOrigin.port === wildcard.port &&
      parsedOrigin.hostname !== wildcard.hostname &&
      parsedOrigin.hostname.endsWith(`.${wildcard.hostname}`)
    );
  } catch {
    return false;
  }
}

export function readDashboardCookie(request) {
  return readSessionCookie(request, DASHBOARD_COOKIE_NAME);
}

export function readAlbumCookie(request) {
  return readSessionCookie(request, ALBUM_COOKIE_NAME);
}

function readSessionCookie(request, cookieName) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;

  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== cookieName) continue;
    const token = cookie.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  }
  return undefined;
}

export function dashboardCookie(token) {
  return `${DASHBOARD_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function albumCookie(token) {
  return `${ALBUM_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function clearDashboardCookie() {
  return `${DASHBOARD_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function clearAlbumCookie() {
  return `${ALBUM_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function createSessionService(passphrase, capability, cookieName) {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new Error(`A ${capability} passphrase is required.`);
  }

  const passphraseDigest = Buffer.from(digest(passphrase), "hex");
  const sessions = new Map();

  return {
    authenticate(candidate) {
      const candidateDigest = Buffer.from(
        digest(typeof candidate === "string" ? candidate : ""),
        "hex",
      );
      return timingSafeEqual(candidateDigest, passphraseDigest);
    },
    createSession() {
      const token = randomBytes(32).toString("base64url");
      sessions.set(digest(token), { capabilities: new Set([capability]) });
      return token;
    },
    isAuthorized(request, requiredCapability = capability) {
      const token = readSessionCookie(request, cookieName);
      if (!token) return false;
      return sessions.get(digest(token))?.capabilities.has(requiredCapability) ?? false;
    },
    revoke(request) {
      const token = readSessionCookie(request, cookieName);
      if (token) sessions.delete(digest(token));
    },
  };
}

export function createDashboardSessionService(passphrase) {
  return createSessionService(passphrase, "dashboard", DASHBOARD_COOKIE_NAME);
}

export function createAlbumSessionService(passphrase) {
  return createSessionService(passphrase, "album", ALBUM_COOKIE_NAME);
}
