# WhatsApp session control

A local Astro control panel for the existing Bun/Baileys bot. The Astro site is
built as static files; one Bun process serves those files and the same-origin
control API. Starting the application does **not** open WhatsApp. The owner
starts a session from the panel.

## Run locally

Create a private environment file before starting the application:

```bash
cp .env.example .env
chmod 600 .env
```

Set `PASS_DASHBOAR` in `.env` to a long, unique passphrase. The spelling is
intentional and exact. Leave both origins empty for dashboard-only loopback
access. `PASS_ALBUM` by itself enables nothing; configure `ALBUM_ORIGIN` and a
different, non-empty album passphrase to enable the second surface.

```bash
bun install
bun run start
```

`bun run start` builds the static panel and starts the loopback server at
<http://127.0.0.1:3008>. Set `PANEL_PORT` to use another local port. Open this
address in a browser and sign in with the dashboard passphrase. Starting the
application does not open WhatsApp; choose **Start session** only when you
intend to connect it.

The `dist/` directory is build output. Do not open `dist/index.html` using a
`file://` URL or serve the repository root with the page under `/dist/`; its
stylesheet and scripts use root-relative `/_astro/` asset paths. Use
`bun run start`, or serve the contents of `dist/` as the web root.

The server binds to `127.0.0.1` and rejects state-changing requests from other
origins. For a VPS, keep the service private and open an owner-controlled SSH
tunnel from the local computer:

```bash
ssh -L 3008:127.0.0.1:3008 <user>@<vps-host>
```

Then open <http://127.0.0.1:3008> locally. Do not expose the control port on a
public interface.

## Local HTTPS preview for both surfaces

The album preview uses the same Bun process as the dashboard. For realistic
dual-host testing—including host selection, exact origins, and `Secure`
cookies—use the included Bun-only local TLS proxy. It binds only to loopback,
listens on separate ports, and forwards the original public `Host` authority to
the app over HTTP. No Caddy install or new package is required.

Create a local certificate whose SAN covers both `.localhost` names:

```bash
mkdir -p .local
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 365 \
  -keyout .local/album-preview-key.pem \
  -out .local/album-preview-cert.pem \
  -subj "/CN=admin.localhost" \
  -addext "subjectAltName=DNS:admin.localhost,DNS:album.localhost"
chmod 600 .local/album-preview-key.pem
```

Trust `.local/album-preview-cert.pem` in the local operating-system/browser
certificate store for a warning-free preview. It is a self-signed development
certificate; never use it for production.

Use distinct synthetic passphrases in your private `.env`:

```dotenv
PASS_DASHBOAR=<long-local-admin-passphrase>
PASS_ALBUM=<different-long-local-album-passphrase>
PANEL_ORIGIN=https://admin.localhost:8443
ALBUM_ORIGIN=https://album.localhost:8444
PANEL_PORT=3008
```

In one terminal, start the application:

```bash
bun run start
```

In another, start the local proxy:

```bash
bun run preview:local
```

Open <https://admin.localhost:8443/> and
<https://album.localhost:8444/>. The `.localhost` names resolve to loopback on
modern systems; no public DNS or firewall changes are needed. If you change
`LOCAL_ADMIN_PORT`, `LOCAL_ALBUM_PORT`, or `PANEL_PORT`, update the origins or
proxy upstream to match. Do not click **Start session** unless you intend to
connect WhatsApp.

## Public VPS behind Cloudflare

Use this only when the panel must be reachable through a public hostname. A
proxied DNS record alone does not protect the VPS origin or rate-limit login.

- Store each enabled passphrase in a private environment file managed by the
  service, not in a unit file, command-line argument, or repository. On the VPS, make
  the file readable only by the service account (for example, owner-only
  permissions such as mode `600`). Use long, unique values. When enabled,
  `PASS_ALBUM` must be non-empty and different from `PASS_DASHBOAR`.
- `ALBUM_ORIGIN` enables the album. In dual-surface mode, set exact canonical
  HTTPS origins with different hostnames, for example
  `PANEL_ORIGIN=https://admin.mydomain.com` and
  `ALBUM_ORIGIN=https://album.mydomain.com` (no paths or trailing slashes).
  Explicit non-default ports are allowed. `PASS_ALBUM` alone enables no route.
  If `ALBUM_ORIGIN` is absent, dashboard-only operation, including local
  loopback and the existing `https://*.mydomain.com` wildcard policy, remains
  available.
- Create separate proxied Cloudflare DNS records for the admin and album
  hostnames, both pointing to the intended VPS proxy. Configure distinct HTTPS
  virtual hosts for both names, preserve the original `Host` authority
  (including any non-default public port) when forwarding to Bun, and do not
  configure a default vhost that routes unknown hosts to the dashboard. The app
  ignores `Forwarded` and `X-Forwarded-*` claims for surface selection. Set
  Cloudflare SSL/TLS to **Full (strict)** and install a valid origin certificate
  on the VPS proxy so TLS is used from the browser to Cloudflare and from
  Cloudflare to the VPS.
- Keep Bun bound to `127.0.0.1`; configure both HTTPS virtual hosts to forward
  to `http://127.0.0.1:3008` (or the configured local `PANEL_PORT`). Do not bind
  Bun to a public interface or expose its port through the firewall.
- In Google Cloud ingress rules, allow the proxy's public HTTPS traffic only
  from Cloudflare's currently published IPv4 and IPv6 proxy address ranges.
  Restrict administrative access separately, and do not allow direct internet
  ingress to the Bun port. Keep the Cloudflare range list current.
- Add a Cloudflare cache-bypass rule for `/`, `/index.html`, `/login*`, and
  `/api/*` on both hostnames. HTML, login, authentication, dashboard API, and
  album responses are private; only fingerprinted public assets may be cached.
- Add login rate limits for `POST /api/auth/login` on the admin hostname and
  `POST /api/album/auth/login` on the album hostname. Choose thresholds and
  mitigation periods appropriate to the account's available Cloudflare
  features, and verify both rules before publishing the DNS records. Proxied
  DNS by itself is not brute-force protection.
- The only album demo photograph is the licensed, non-personal login
  illustration, which is a public fingerprinted build asset. Real album photos
  are never copied into `dist/`: they are read from the private runtime store
  only after album login and a valid conversation opt-in.
- Roll back the album by removing `ALBUM_ORIGIN` and restarting the process.
  This disables album-host routing but does not revoke saved conversation
  approvals or delete private images; the dashboard and its independent
  authentication remain available.

## Session and account switching

- Use **Start session** to create the one allowed Baileys socket. Repeated start
  requests reuse the current state; the application does not automatically
  reconnect after a connection loss.
- Use **Cancel pairing** to end an unfinished QR pairing attempt.
- To switch accounts, choose **Log out & switch account** and confirm. The app
  remotely unlinks and waits for the old socket to end before deleting
  `./auth_info/` and allowing another pairing. If logout or local cleanup fails,
  the panel enters operator review and blocks another socket.
- **Sign out** revokes only the browser's dashboard session. It does not stop or
  log out the linked WhatsApp account.
- An ordinary process restart is not logout. Local auth stays in `auth_info/`
  so the owner can deliberately start that account again.

### Diagnosing failed pairing

Run `bun run start` in a terminal after stopping the existing app/service, then
choose **Start session** in the panel. If running under a service manager, view
that service's logs instead of launching a second instance.

Routine `[whatsapp]` diagnostics contain only fixed lifecycle labels and a
sanitized numeric disconnect code. QR values, credentials, account identifiers,
message content, and raw library errors are never included. The QR remains
available only in the panel. Useful events:

- `qr-issued` / `qr-refreshed`: a code was offered, not proof of a successful scan.
- `pairing-accepted`: the library reported a new login; this is not yet a
  connected session or confirmation that credentials were saved successfully.
- `connection-open`: the session connected.
- `connection-close`: includes the last observed stage, `statusCode`, and a
  fixed reason. `515` means a connection restart is required; this app does not
  reconnect automatically, so choose **Start session** again to resume using
  saved credentials. `401` means logged out or rejected, not QR expiration.
  `408` means connection loss or timeout. Unknown codes do not imply a cause.
- `credentials-save-failed`: at least one credential write failed. Stop the
  app and check service-account write permissions and available disk space
  before retrying. Do not share files from `auth_info/`.
- `session-start-failed`: local auth loading or socket creation failed; no raw
  error is logged.

Share only the `[whatsapp]` diagnostic sequence when investigating a failed
attempt. These events cannot by themselves prove an upstream protocol bug.
Do not repeatedly delete credentials or extend QR lifetimes as a substitute
for identifying the failure.

## Live messages and sending

The panel displays new direct-chat text events emitted during the current
session, including `fromMe` self-chat events. It also displays supported new
image messages from direct chats, including the linked account's self-chat.
Group, history-sync, and non-image attachment events are excluded. The app does
not fetch past messages or promise complete delivery. At most the latest 200
text and image activity events are held in process memory; the feed clears on
logout and process exit and is never restored from disk.

Image originals are streamed into `./received-images/` in flat folders keyed by
the linked-account and chat IDs, with a sanitized contact-name suffix. Each
folder contains image files directly, without date or media-type subfolders.
The opaque preview route serves saved images to this local panel without
putting image bytes or filesystem paths in its event stream. Saved files remain
after logout, account switching, and process restart, until manually deleted.
There is no automatic expiry or per-image size limit, so disk use grows with
received images. To clean up, stop the application and manually remove selected
files or the `received-images/` directory. This local storage root is ignored by
Git.

The manual send form derives the linked account's own chat destination on the
server. It rejects client-selected recipients, empty messages, and concurrent
sends. A failed send is not retried automatically.

## Private album opt-in

The album is separately enabled by `ALBUM_ORIGIN`, protected by its own
passphrase, and still requires a contact-by-contact opt-in. An incoming direct
contact must send the exact text `inicia album`. Case, Unicode compatibility
forms, leading/trailing whitespace, and repeated internal whitespace are
normalized; extra words or punctuation do not match. Only new plain or extended
text messages qualify—self-chat, outgoing messages, groups, history, captions,
and quoted text do not.

After the approval record is durably written, the bot attempts this reply once:

> Álbum iniciado. Las imágenes de esta conversación se incluirán en el álbum.

The attempt is reserved before sending to avoid duplicate replies. A crash
between reservation and send, or a failed send, can therefore leave the
conversation approved without a delivered confirmation. It is at most one
automatic attempt, not an exactly-once delivery guarantee; there is no automatic
retry. Approval itself does not expire on logout or restart.

Opt-in includes the whole retained account/chat folder: supported images saved
before approval and supported images received afterward are eligible. Approved
folders from previously linked accounts are included too, even when that
account is not currently connected. Display names do not determine membership.
No WhatsApp history is fetched. The album can load persisted approvals and
images after an application restart without starting a WhatsApp session;
dashboard live activity is different and remains in-memory only, capped at 200
events and cleared on logout or process exit.

Album dates come from the WhatsApp message timestamp stored with each image,
not its EXIF/camera capture date or file modification time. Dates are displayed
as Spanish calendar dates using UTC. A legacy image without metadata gets its
date from the generated filename and has no invented caption.

Images and metadata stay under the Git-ignored `./received-images/` runtime
directory and are served only from the independently authenticated album host.
The dashboard's **Albumed only** checkbox is a presentation filter for its
currently retained live activity; it does not change collection, approval,
storage, or album contents. With the filter off, all retained eligible events
remain visible.

### Correcting a private caption

Image sidecars are private JSON files beside their originals, not public build
assets. For a manual correction, stop the application first, edit only the
sidecar's `captionOverride`, save valid JSON, then restart. Do not edit
`album.json`, rename an original, or copy private files into `src/` or `dist/`.
For example, a sidecar may contain:

```json
{
  "version": 1,
  "id": "d34db33f-1a2b-4c3d-8e9f-0123456789ab",
  "filename": "image-1800000000-a1b2c3d4e5f607182930.jpg",
  "timestamp": "2026-11-12T12:00:00.000Z",
  "mimeType": "image/jpeg",
  "caption": "Synthetic original caption",
  "captionOverride": "Synthetic corrected caption"
}
```

The original attached caption is retained. Set `captionOverride` to `""` to
hide the caption, or to `null` to use the original again. A new album load
refreshes private metadata; no rebuild or WhatsApp connection is required.
Manual filesystem edits are safest while intake is stopped.

Self-chat visibility has **not been live-validated by the automated test suite**.
Follow the explicitly opt-in procedure in
[`docs/live-session-validation.md`](docs/live-session-validation.md) before
describing it as verified for a particular setup. A successful manual check is
not a delivery guarantee or historical-completeness claim.

## Safeguards and limitations

The local panel reduces accidental exposure and sending; it cannot guarantee
that unofficial Baileys use avoids WhatsApp restrictions. There is no send
threshold or panel feature that provides such a guarantee.

The existing `!ping` handler still has no sender allowlist and may reply to any
otherwise eligible direct sender. This change does not add owner authorization
to automatic command replies; the local panel must not be described as solving
that gap.

The pairing QR, message bodies, sender identifiers, filesystem paths, media
bytes, and raw errors are not written to routine application diagnostics. The
QR is rendered in the local panel only. Root `auth_info/` and
`received-images/` are ignored by Git.

## Verification

```bash
bun run build
bun test
bun run typecheck
bun run lint
bun run format:check
openspec validate load-real-album-images --strict
```

Tests use mocked WhatsApp facilities and synthetic messages. They do not use
live credentials, scan personal image files, start a WhatsApp session, or
perform the opt-in account validation.
