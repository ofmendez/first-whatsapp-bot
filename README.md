# WhatsApp session control

A local Astro control panel for the existing Bun/Baileys bot. The Astro site is
built as static files; one Bun process serves those files and the same-origin
control API. Starting the application does **not** open WhatsApp. The owner
starts a session from the panel.

## Run locally

```bash
bun install
bun run start
```

`bun run start` builds the static panel and starts the loopback server at
<http://127.0.0.1:3008>. Set `PANEL_PORT` to use another local port. Open this
address in a browser, then choose **Start session**. On first pairing, scan the
transient QR shown in the panel with the account owner's phone. If the selected
port is already in use, the startup message tells you to choose another.

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

## Session and account switching

- Use **Start session** to create the one allowed Baileys socket. Repeated start
  requests reuse the current state; the application does not automatically
  reconnect after a connection loss.
- Use **Cancel pairing** to end an unfinished QR pairing attempt.
- To switch accounts, choose **Log out & switch account** and confirm. The app
  remotely unlinks and waits for the old socket to end before deleting
  `./auth_info/` and allowing another pairing. If logout or local cleanup fails,
  the panel enters operator review and blocks another socket.
- An ordinary process restart is not logout. Local auth stays in `auth_info/`
  so the owner can deliberately start that account again.

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
```

Tests use mocked WhatsApp facilities and synthetic messages. They do not use
live credentials or perform the opt-in account validation.
