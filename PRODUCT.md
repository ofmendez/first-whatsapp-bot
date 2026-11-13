# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing Bun ESM application with a statically built Astro panel served by the same Bun process.

## Users

The WhatsApp account owner operating one linked account at a time.

## Product Purpose

Provide a local control surface for deliberately starting and ending a WhatsApp session, observing its connection state and newly emitted direct-chat text and image events, persistently saving supported image originals by account and conversation, and sending a manual message to the linked account's own chat. Success means the owner can tell what state the session is in and switch accounts only after logout completes.

## Positioning

The panel runs alongside the bot in one local process. Session controls and live activity remain transient, while received image originals persist locally until the owner deletes them; this is not a searchable chat archive.

## Operating Context

The owner runs the Bun application locally or on a VPS accessed through an owner-controlled SSH tunnel. A session is started explicitly from the panel. Account switching requires explicit logout before pairing another account.

## Capabilities and Constraints

- Only one Baileys socket may be active; the application does not automatically connect or reconnect.
- The interface and state-changing API bind to loopback by default and reject cross-origin state changes.
- The panel displays newly emitted direct-chat text events in bounded process memory, excludes groups and history sync, and clears the buffer on logout or process exit.
- Supported direct-chat image events, including linked-account self-chat images, have bounded live previews; saved originals remain under the Git-ignored `./received-images/` root across logout and restart. There is no automatic expiry or per-image size limit.
- Manual panel messages are limited to the linked account's own chat. The panel does not select arbitrary recipients or automatically retry sends.
- Message-self-chat event delivery with the installed Bun/Baileys combination remains unverified until an explicitly opted-in live validation is completed; do not claim reliable visibility beforehand.
- The interface must keep local access, transient retention, and the absence of any anti-restriction guarantee clear.
- The existing `!ping` sender-authorization gap is outside this panel's scope.

## Product Principles

- Make session state and account-switching steps explicit.
- Keep sensitive session and message data local and ephemeral.
- Separate passive message visibility from automatic command processing.
- Constrain panel sending to a deliberate self-chat action.
- Describe limitations honestly; local safeguards do not guarantee account outcomes.
