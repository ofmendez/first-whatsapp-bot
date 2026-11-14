import { isIP } from "node:net";

function parseAuthority(value) {
  if (typeof value !== "string" || value.length === 0 || /[\s,/@?#\\*]/.test(value)) {
    return undefined;
  }

  try {
    const url = new URL(`https://${value}`);
    if (
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.hostname.endsWith(".")
    ) {
      return undefined;
    }
    return { origin: url.origin, hostname: url.hostname };
  } catch {
    return undefined;
  }
}

function parseConfiguredOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("*")) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.origin !== value ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.hostname.endsWith(".")
    ) {
      return undefined;
    }
    return { origin: url.origin, hostname: url.hostname };
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost") return true;
  const address =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  if (isIP(address) === 4) return address.startsWith("127.");
  return isIP(address) === 6 && address === "::1";
}

/**
 * Selects a dual-surface capability by its public Host authority, not by the
 * upstream transport scheme or forwarded-header claims.
 */
export function selectSurfaceFromRequestAuthority(request, { panelOrigin, albumOrigin } = {}) {
  const admin = parseConfiguredOrigin(panelOrigin);
  const album = parseConfiguredOrigin(albumOrigin);
  if (!admin || !album || admin.hostname === album.hostname) return undefined;

  let requestUrl;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return undefined;
  }

  const urlAuthority = parseAuthority(requestUrl.host);
  const hostHeader = request.headers.get("host");
  let requestAuthority = urlAuthority;

  if (hostHeader !== null) {
    requestAuthority = parseAuthority(hostHeader);
    if (!requestAuthority) return undefined;

    if (
      urlAuthority &&
      requestAuthority.origin !== urlAuthority.origin &&
      !isLoopbackHostname(requestUrl.hostname)
    ) {
      return undefined;
    }
  }

  if (!requestAuthority) return undefined;
  if (requestAuthority.origin === admin.origin) {
    return { name: "admin", origin: admin.origin };
  }
  if (requestAuthority.origin === album.origin) {
    return { name: "album", origin: album.origin };
  }
  return undefined;
}
