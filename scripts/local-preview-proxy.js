import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const LOOPBACK = "127.0.0.1";
const FORWARDED_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
];
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function configuredPort(value, fallback, name) {
  const port = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a valid TCP port.`);
  }
  return port;
}

function withoutHopByHopHeaders(source) {
  const headers = { ...source };
  const connectionTokens = String(headers.connection ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  for (const name of [...HOP_BY_HOP_HEADERS, ...connectionTokens]) {
    delete headers[name];
  }
  return headers;
}

function misdirected(outgoing) {
  outgoing.writeHead(421, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  outgoing.end("Unknown local preview authority.");
}

function badRequest(outgoing) {
  outgoing.writeHead(400, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  outgoing.end("Invalid local preview request.");
}

function createLocalSurfaceProxy({ hostname, port, upstreamPort, cert, key }) {
  const authority = `${hostname}:${port}`;
  const server = createHttpsServer({ cert, key, minVersion: "TLSv1.2" }, (incoming, outgoing) => {
    const serverName = incoming.socket.servername?.toLowerCase();
    if (incoming.headers.host !== authority || (serverName && serverName !== hostname)) {
      misdirected(outgoing);
      return;
    }
    if (
      typeof incoming.url !== "string" ||
      !incoming.url.startsWith("/") ||
      incoming.url.startsWith("//")
    ) {
      badRequest(outgoing);
      return;
    }

    const requestHeaders = withoutHopByHopHeaders(incoming.headers);
    for (const header of FORWARDED_HEADERS) delete requestHeaders[header];
    requestHeaders.host = authority;

    const upstream = httpRequest(
      {
        hostname: LOOPBACK,
        port: upstreamPort,
        method: incoming.method,
        path: incoming.url,
        headers: requestHeaders,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, withoutHopByHopHeaders(response.headers));
        response.pipe(outgoing);
      },
    );

    upstream.on("error", () => {
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      outgoing.writeHead(502, {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      outgoing.end("The local panel server is unavailable.");
    });
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => {
      if (!outgoing.writableFinished) upstream.destroy();
    });
    incoming.pipe(upstream);
  });

  return { server, hostname, port };
}

async function listen(proxy) {
  await new Promise((resolveListen, rejectListen) => {
    proxy.server.once("error", rejectListen);
    proxy.server.listen(proxy.port, LOOPBACK, resolveListen);
  });
  console.log(`Local HTTPS preview for ${proxy.hostname}: https://${proxy.hostname}:${proxy.port}`);
}

async function startLocalPreviewProxy() {
  const upstreamPort = configuredPort(process.env.PANEL_PORT, 3008, "PANEL_PORT");
  const adminPort = configuredPort(process.env.LOCAL_ADMIN_PORT, 8443, "LOCAL_ADMIN_PORT");
  const albumPort = configuredPort(process.env.LOCAL_ALBUM_PORT, 8444, "LOCAL_ALBUM_PORT");
  if (adminPort === albumPort) {
    throw new Error("LOCAL_ADMIN_PORT and LOCAL_ALBUM_PORT must differ.");
  }

  const certPath = resolve(process.env.LOCAL_TLS_CERT || ".local/album-preview-cert.pem");
  const keyPath = resolve(process.env.LOCAL_TLS_KEY || ".local/album-preview-key.pem");
  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  const proxies = [
    createLocalSurfaceProxy({
      hostname: "admin.localhost",
      port: adminPort,
      upstreamPort,
      cert,
      key,
    }),
    createLocalSurfaceProxy({
      hostname: "album.localhost",
      port: albumPort,
      upstreamPort,
      cert,
      key,
    }),
  ];

  try {
    for (const proxy of proxies) await listen(proxy);
  } catch (error) {
    for (const proxy of proxies) proxy.server.close();
    throw error;
  }

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const proxy of proxies) proxy.server.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (import.meta.main) {
  startLocalPreviewProxy().catch(() => {
    console.error(
      "Local HTTPS preview proxy failed to start. Check the local certificate files, ports, and Bun panel process.",
    );
    process.exitCode = 1;
  });
}
