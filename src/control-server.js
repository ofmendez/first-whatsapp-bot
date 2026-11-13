import { resolve, sep } from "node:path";

const MUTATING_PATHS = new Set([
  "/api/session/start",
  "/api/session/cancel",
  "/api/session/logout",
  "/api/messages/send",
]);
const MEDIA_PATH = /^\/api\/media\/([^/]+)$/;
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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function errorResponse(message, status) {
  return jsonResponse({ error: message }, status);
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
  distDirectory = "./dist",
  expectedOrigin,
}) {
  const distRoot = resolve(distDirectory);
  const origin = typeof expectedOrigin === "function" ? expectedOrigin : () => expectedOrigin;

  return async function handle(request) {
    const url = new URL(request.url);

    if (MUTATING_PATHS.has(url.pathname) && request.method === "POST") {
      const trustedOrigin = origin();
      const fetchSite = request.headers.get("sec-fetch-site");
      if (
        !trustedOrigin ||
        request.headers.get("origin") !== trustedOrigin ||
        url.origin !== trustedOrigin ||
        (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
      ) {
        return errorResponse("Control actions are allowed only from the local panel origin.", 403);
      }
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      return jsonResponse({ state: manager.getSnapshot() });
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      return createEventResponse(request, manager);
    }

    if (url.pathname === "/api/media" || url.pathname.startsWith("/api/media/")) {
      if (request.method !== "GET") return errorResponse("Method not allowed.", 405);
      const match = MEDIA_PATH.exec(url.pathname);
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

    if (request.method === "POST" && MUTATING_PATHS.has(url.pathname)) {
      try {
        const body = await parseBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return errorResponse("The request body must be a JSON object.", 400);
        }

        if (url.pathname === "/api/session/start") {
          return jsonResponse({ state: await manager.start() });
        }
        if (url.pathname === "/api/session/cancel") {
          return jsonResponse({ state: await manager.cancel() });
        }
        if (url.pathname === "/api/session/logout") {
          return jsonResponse({ state: await manager.logout() });
        }
        if (url.pathname === "/api/messages/send") {
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

    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse("Method not allowed.", 405);
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return errorResponse("Not found.", 404);
    }
    if (pathname.split("/").some((segment) => segment === "..")) {
      return errorResponse("Not found.", 404);
    }

    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = resolve(distRoot, relativePath);
    if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${sep}`)) {
      return errorResponse("Not found.", 404);
    }

    const file = Bun.file(filePath);
    if (!(await file.exists())) return errorResponse("Not found.", 404);

    return new Response(request.method === "HEAD" ? null : file, {
      headers: {
        ...SECURITY_HEADERS,
        "Content-Type": file.type || "application/octet-stream",
        "Cache-Control":
          pathname.endsWith(".html") || pathname === "/"
            ? "no-store"
            : "public, max-age=31536000, immutable",
      },
    });
  };
}
