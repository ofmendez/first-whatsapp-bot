import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  albumCookie,
  clearAlbumCookie,
  clearDashboardCookie,
  dashboardCookie,
  isAllowedPanelOrigin,
} from "./dashboard-auth.js";
import { AlbumPaginationError } from "./album-catalog.js";
import {
  AlbumVisibilityConflictError,
  AlbumVisibilityValidationError,
} from "./received-image-store.js";
import { selectSurfaceFromRequestAuthority } from "./surface-routing.js";

const ALBUM_LOGIN_PATH = "/api/album/auth/login";
const ALBUM_SIGN_OUT_PATH = "/api/album/auth/logout";
const ALBUM_IMAGES_PATH = "/api/album/images";
const ALBUM_CONVERSATIONS_PATH = "/api/album/conversations";
const ALBUM_VISIBILITY_PATH = "/api/album/visibility";
const ALBUM_AUTH_PATHS = new Set([ALBUM_LOGIN_PATH, ALBUM_SIGN_OUT_PATH]);
const CONVERSATION_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_HIDDEN_CONVERSATIONS = 12_000;
const ADMIN_DOCUMENTS = new Map([
  ["/", { file: "index.html", capability: "dashboard" }],
  ["/index.html", { file: "index.html", capability: "dashboard" }],
  ["/login", { file: "login/index.html", capability: "public" }],
  ["/login/", { file: "login/index.html", capability: "public" }],
  ["/login/index.html", { file: "login/index.html", capability: "public" }],
]);
const ALBUM_DOCUMENTS = new Map([
  ["/", { file: "album/index.html", capability: "album" }],
  ["/index.html", { file: "album/index.html", capability: "album" }],
  ["/login", { file: "album/login/index.html", capability: "public" }],
  ["/login/", { file: "album/login/index.html", capability: "public" }],
  ["/login/index.html", { file: "album/login/index.html", capability: "public" }],
]);
const DOCUMENTS_BY_SURFACE = {
  admin: ADMIN_DOCUMENTS,
  album: ALBUM_DOCUMENTS,
};
const ADMIN_API_METHODS = new Map([
  ["/api/auth/login", new Set(["POST"])],
  ["/api/auth/logout", new Set(["POST"])],
  ["/api/state", new Set(["GET"])],
  ["/api/events", new Set(["GET"])],
  ["/api/media", new Set(["GET"])],
  ["/api/session/start", new Set(["POST"])],
  ["/api/session/cancel", new Set(["POST"])],
  ["/api/session/logout", new Set(["POST"])],
  ["/api/messages/send", new Set(["POST"])],
  [ALBUM_CONVERSATIONS_PATH, new Set(["GET"])],
  [ALBUM_VISIBILITY_PATH, new Set(["POST"])],
]);
const ALBUM_API_METHODS = new Map([
  [ALBUM_LOGIN_PATH, new Set(["POST"])],
  [ALBUM_SIGN_OUT_PATH, new Set(["POST"])],
  [ALBUM_IMAGES_PATH, new Set(["GET"])],
]);
const ASSET_EXTENSIONS = new Set([
  "avif",
  "css",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "js",
  "mjs",
  "otf",
  "png",
  "svg",
  "ttf",
  "webp",
  "woff",
  "woff2",
]);
const MUTATING_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  ALBUM_LOGIN_PATH,
  ALBUM_SIGN_OUT_PATH,
  "/api/session/start",
  "/api/session/cancel",
  "/api/session/logout",
  "/api/messages/send",
  ALBUM_VISIBILITY_PATH,
]);
const LOGIN_PATH = "/api/auth/login";
const SIGN_OUT_PATH = "/api/auth/logout";
const MEDIA_PATH = /^\/api\/media\/([^/]+)$/;
const ALBUM_MEDIA_PATH =
  /^\/api\/album\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

function errorResponse(message, status) {
  return jsonResponse({ error: message }, status);
}

function redirectResponse(location) {
  return new Response(null, {
    status: 302,
    headers: {
      ...SECURITY_HEADERS,
      "Cache-Control": "no-store",
      Location: location,
    },
  });
}

function apiMethodsFor(surfaceName, pathname) {
  const surfaceMethods = surfaceName === "album" ? ALBUM_API_METHODS : ADMIN_API_METHODS;
  const explicitMethods = surfaceMethods.get(pathname);
  if (explicitMethods) return explicitMethods;
  if (surfaceName === "admin" && MEDIA_PATH.test(pathname)) return new Set(["GET"]);
  if (surfaceName === "album" && ALBUM_MEDIA_PATH.test(pathname)) return new Set(["GET"]);
  return undefined;
}

function rawRequestPathname(requestUrl) {
  const schemeSeparator = requestUrl.indexOf("://");
  if (schemeSeparator < 0) return undefined;
  const pathStart = requestUrl.indexOf("/", schemeSeparator + 3);
  if (pathStart < 0) return "/";
  const remainder = requestUrl.slice(pathStart);
  const suffixStart = remainder.search(/[?#]/);
  return suffixStart < 0 ? remainder : remainder.slice(0, suffixStart);
}

function hasSafeCanonicalPath(request, pathname) {
  const rawPathname = rawRequestPathname(request.url);
  return (
    rawPathname === pathname &&
    !rawPathname.includes("%") &&
    !rawPathname.includes("\\") &&
    !rawPathname.includes("\0") &&
    !rawPathname.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function isFingerprintedAssetPath(pathname) {
  if (!pathname.startsWith("/_astro/")) return false;
  const fileName = pathname.slice("/_astro/".length);
  if (!fileName || fileName.includes("/") || fileName.includes("\\")) return false;

  const extension = fileName.split(".").at(-1)?.toLowerCase();
  return (
    ASSET_EXTENSIONS.has(extension) && /(?:^|\.)[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(fileName)
  );
}

async function resolveContainedFile(distRoot, relativePath) {
  const candidate = resolve(distRoot, relativePath);
  if (candidate !== distRoot && !candidate.startsWith(`${distRoot}${sep}`)) {
    return undefined;
  }

  try {
    const [realRoot, realCandidate] = await Promise.all([realpath(distRoot), realpath(candidate)]);
    if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${sep}`)) {
      return undefined;
    }
    return realCandidate;
  } catch {
    return undefined;
  }
}

function createEventResponse(request, manager) {
  const encoder = new TextEncoder();
  let closeStream = () => {};
  const stream = new ReadableStream({
    start(controller) {
      let active = true;
      let heartbeat;
      const send = (update) => {
        if (!active) return;
        try {
          controller.enqueue(encoder.encode(`event: update\ndata: ${JSON.stringify(update)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const unsubscribe = manager.subscribe(send);
      const cleanup = () => {
        if (!active) return;
        active = false;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      };
      closeStream = cleanup;
      send({ type: "state", state: manager.getSnapshot() });
      heartbeat = setInterval(() => {
        if (active) {
          try {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          } catch {
            cleanup();
          }
        }
      }, 15_000);
      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      closeStream();
    },
  });

  return new Response(stream, {
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function parseBody(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("Send a same-origin JSON request."), { status: 415 });
  }
  try {
    return await request.json();
  } catch {
    throw Object.assign(new Error("The request body must be valid JSON."), { status: 400 });
  }
}

export function createControlHandler({
  manager,
  mediaStore,
  albumCatalog,
  albumVisibilityStore,
  dashboardAuth,
  albumAuth,
  distDirectory = "./dist",
  expectedOrigin,
  panelOrigin,
  albumOrigin,
}) {
  if (!dashboardAuth) throw new Error("Dashboard authentication is required.");
  if (albumOrigin && !albumAuth) {
    throw new Error("Album authentication is required when ALBUM_ORIGIN is enabled.");
  }
  const distRoot = resolve(distDirectory);
  const origin = typeof expectedOrigin === "function" ? expectedOrigin : () => expectedOrigin;
  const dualSurface = Boolean(albumOrigin);

  return async function handle(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse("Not found.", 404);
    }

    const surface = dualSurface
      ? selectSurfaceFromRequestAuthority(request, { panelOrigin, albumOrigin })
      : { name: "admin", origin: panelOrigin };
    if (dualSurface && !surface) return errorResponse("Not found.", 404);

    const pathname = url.pathname;
    if (!hasSafeCanonicalPath(request, pathname)) return errorResponse("Not found.", 404);

    const document = DOCUMENTS_BY_SURFACE[surface.name].get(pathname);
    const isAssetNamespace = pathname.startsWith("/_astro/");
    const assetIsFingerprinted = isFingerprintedAssetPath(pathname);
    const apiMethods = apiMethodsFor(surface.name, pathname);
    const isKnownApi = Boolean(apiMethods);

    if (isAssetNamespace) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return errorResponse("Method not allowed.", 405);
      }
      if (!assetIsFingerprinted) return errorResponse("Not found.", 404);
    } else if (document) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return errorResponse("Method not allowed.", 405);
      }
    } else if (isKnownApi) {
      if (!apiMethods.has(request.method)) return errorResponse("Method not allowed.", 405);
    } else {
      return errorResponse("Not found.", 404);
    }

    if (MUTATING_PATHS.has(pathname)) {
      const trustedOrigin = origin();
      const requestOrigin = request.headers.get("origin");
      const fetchSite = request.headers.get("sec-fetch-site");
      const selectedOrigin = dualSurface ? surface.origin : trustedOrigin;
      const originAllowed = dualSurface
        ? requestOrigin === selectedOrigin
        : panelOrigin
          ? isAllowedPanelOrigin(requestOrigin, panelOrigin)
          : requestOrigin === trustedOrigin && url.origin === trustedOrigin;
      if (
        !selectedOrigin ||
        !originAllowed ||
        (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
      ) {
        return errorResponse(
          pathname === ALBUM_LOGIN_PATH
            ? "No se pudo iniciar sesión."
            : pathname === ALBUM_SIGN_OUT_PATH
              ? "No se pudo cerrar sesión."
              : pathname === LOGIN_PATH
                ? "Authentication failed."
                : "Request origin is not allowed.",
          403,
        );
      }
    }

    if (request.method === "POST" && pathname === ALBUM_LOGIN_PATH) {
      try {
        const body = await parseBody(request);
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          typeof body.passphrase !== "string" ||
          !albumAuth.authenticate(body.passphrase)
        ) {
          return errorResponse("No se pudo iniciar sesión.", 401);
        }
      } catch {
        return errorResponse("No se pudo iniciar sesión.", 401);
      }

      const token = albumAuth.createSession();
      return jsonResponse({ ok: true }, 200, { "Set-Cookie": albumCookie(token) });
    }

    if (request.method === "POST" && pathname === ALBUM_SIGN_OUT_PATH) {
      albumAuth.revoke(request);
      return jsonResponse({ ok: true }, 200, { "Set-Cookie": clearAlbumCookie() });
    }

    if (request.method === "POST" && pathname === LOGIN_PATH) {
      try {
        const body = await parseBody(request);
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          typeof body.passphrase !== "string" ||
          !dashboardAuth.authenticate(body.passphrase)
        ) {
          return errorResponse("Authentication failed.", 401);
        }
      } catch {
        return errorResponse("Authentication failed.", 401);
      }

      const token = dashboardAuth.createSession();
      return jsonResponse({ ok: true }, 200, { "Set-Cookie": dashboardCookie(token) });
    }

    if (request.method === "POST" && pathname === SIGN_OUT_PATH) {
      dashboardAuth.revoke(request);
      return jsonResponse({ ok: true }, 200, { "Set-Cookie": clearDashboardCookie() });
    }

    const isPublicDocument = document?.capability === "public";
    const isAuthenticationEndpoint =
      pathname === LOGIN_PATH || pathname === SIGN_OUT_PATH || ALBUM_AUTH_PATHS.has(pathname);
    const isAuthorized =
      surface.name === "album"
        ? albumAuth.isAuthorized(request, "album")
        : dashboardAuth.isAuthorized(request, "dashboard");
    if (!isPublicDocument && !isAssetNamespace && !isAuthenticationEndpoint && !isAuthorized) {
      if (isKnownApi) {
        return errorResponse("Authentication required.", 401);
      }
      return redirectResponse("/login/");
    }

    if (pathname === "/api/state") {
      return jsonResponse({ state: manager.getSnapshot() });
    }
    if (pathname === "/api/events") {
      return createEventResponse(request, manager);
    }

    if (request.method === "GET" && pathname === ALBUM_CONVERSATIONS_PATH) {
      if (
        typeof albumVisibilityStore?.getAlbumVisibility !== "function" ||
        typeof albumVisibilityStore?.listApprovedConversations !== "function"
      ) {
        return errorResponse("Album visibility is unavailable.", 500);
      }
      try {
        const [visibility, conversations] = await Promise.all([
          albumVisibilityStore.getAlbumVisibility(),
          albumVisibilityStore.listApprovedConversations(),
        ]);
        const hiddenConversationIds = new Set(visibility.hiddenConversationIds);
        return jsonResponse({
          revision: visibility.revision,
          conversations: conversations.map((conversation) => ({
            ...conversation,
            visible: !hiddenConversationIds.has(conversation.conversationId),
          })),
        });
      } catch {
        return errorResponse("Album visibility is unavailable.", 500);
      }
    }

    if (request.method === "GET" && pathname === ALBUM_IMAGES_PATH) {
      if (typeof albumCatalog?.listPage !== "function") return errorResponse("Not found.", 404);
      try {
        const limits = url.searchParams.getAll("limit");
        const cursors = url.searchParams.getAll("cursor");
        if (limits.length > 1 || cursors.length > 1) throw new AlbumPaginationError();
        return jsonResponse(
          await albumCatalog.listPage({
            limit: limits.length ? limits[0] : null,
            cursor: cursors.length ? cursors[0] : null,
          }),
        );
      } catch (error) {
        if (error instanceof AlbumPaginationError) {
          return errorResponse("Invalid album pagination.", 400);
        }
        return errorResponse("Album images are unavailable.", 500);
      }
    }

    const albumMediaMatch = ALBUM_MEDIA_PATH.exec(pathname);
    if (request.method === "GET" && albumMediaMatch) {
      if (typeof albumCatalog?.openMedia !== "function") return errorResponse("Not found.", 404);
      let media;
      try {
        media = await albumCatalog.openMedia(albumMediaMatch[1]);
      } catch {
        return errorResponse("Not found.", 404);
      }
      if (!media || !IMAGE_CONTENT_TYPES.has(media.contentType)) {
        return errorResponse("Not found.", 404);
      }
      const file = Bun.file(media.path);
      if (!(await file.exists())) return errorResponse("Not found.", 404);

      return new Response(file, {
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": media.contentType,
          "Cache-Control": "no-store",
        },
      });
    }

    if (request.method === "POST" && pathname === ALBUM_VISIBILITY_PATH) {
      if (
        typeof albumVisibilityStore?.saveAlbumVisibility !== "function" ||
        typeof albumVisibilityStore?.listApprovedConversations !== "function"
      ) {
        return errorResponse("Album visibility is unavailable.", 500);
      }

      let body;
      try {
        body = await parseBody(request);
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 400;
        return errorResponse(
          status === 415 ? "Send a same-origin JSON request." : error.message,
          status,
        );
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        !Object.hasOwn(body, "revision") ||
        !Object.hasOwn(body, "hiddenConversationIds") ||
        !Number.isSafeInteger(body.revision) ||
        body.revision < 0 ||
        !Array.isArray(body.hiddenConversationIds) ||
        body.hiddenConversationIds.length > MAX_HIDDEN_CONVERSATIONS ||
        body.hiddenConversationIds.some(
          (id) => typeof id !== "string" || !CONVERSATION_ID_PATTERN.test(id),
        ) ||
        new Set(body.hiddenConversationIds).size !== body.hiddenConversationIds.length
      ) {
        return errorResponse("The album visibility selection is invalid.", 400);
      }

      try {
        const conversations = await albumVisibilityStore.listApprovedConversations();
        const approvedConversationIds = new Set(
          conversations.map(({ conversationId }) => conversationId),
        );
        if (body.hiddenConversationIds.some((id) => !approvedConversationIds.has(id))) {
          return errorResponse("The album visibility selection is invalid.", 400);
        }
        const result = await albumVisibilityStore.saveAlbumVisibility(body);
        return jsonResponse({ ok: true, revision: result.revision });
      } catch (error) {
        if (error instanceof AlbumVisibilityConflictError) {
          return errorResponse("Album visibility changed in another dashboard tab.", 409);
        }
        if (error instanceof AlbumVisibilityValidationError) {
          return errorResponse("The album visibility selection is invalid.", 400);
        }
        return errorResponse("Album visibility could not be saved.", 500);
      }
    }

    if (pathname === "/api/media" || pathname.startsWith("/api/media/")) {
      const match = MEDIA_PATH.exec(pathname);
      if (!match) return errorResponse("Not found.", 404);
      const media = await mediaStore?.openMedia(match[1]);
      if (!media || !IMAGE_CONTENT_TYPES.has(media.contentType))
        return errorResponse("Not found.", 404);
      const file = Bun.file(media.path);
      if (!(await file.exists())) return errorResponse("Not found.", 404);

      return new Response(file, {
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": media.contentType,
          "Cache-Control": "no-store",
        },
      });
    }

    if (request.method === "POST" && MUTATING_PATHS.has(pathname)) {
      try {
        const body = await parseBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return errorResponse("The request body must be a JSON object.", 400);
        }

        if (pathname === "/api/session/start") {
          return jsonResponse({ state: await manager.start() });
        }
        if (pathname === "/api/session/cancel") {
          return jsonResponse({ state: await manager.cancel() });
        }
        if (pathname === "/api/session/logout") {
          return jsonResponse({ state: await manager.logout() });
        }
        if (pathname === "/api/messages/send") {
          if (Object.keys(body).some((key) => key !== "text")) {
            return errorResponse(
              "Only message text is accepted; the destination is fixed to your own chat.",
              400,
            );
          }
          const result = await manager.sendSelf(body.text);
          return jsonResponse(result);
        }
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500;
        const message =
          typeof error?.message === "string" && status !== 500
            ? error.message
            : "The control action could not be completed. Review the session state.";
        return errorResponse(message, status);
      }
    }

    const relativePath = isAssetNamespace ? pathname.slice(1) : document.file;
    const filePath = await resolveContainedFile(distRoot, relativePath);
    if (!filePath) return errorResponse("Not found.", 404);

    const file = Bun.file(filePath);
    if (!(await file.exists())) return errorResponse("Not found.", 404);

    return new Response(request.method === "HEAD" ? null : file, {
      headers: {
        ...SECURITY_HEADERS,
        "Content-Type": file.type || "application/octet-stream",
        "Cache-Control": isAssetNamespace ? "public, max-age=31536000, immutable" : "no-store",
      },
    });
  };
}
