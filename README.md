# whatsapp-bot

To install dependencies:

```bash
bun install
```

To start from the repository root:

```bash
bun run start
```

On first startup, scan the terminal QR code to pair WhatsApp. Session credentials
stay in `./auth_info/`, which is ignored by Git. Connection closures are reported;
the bot does not automatically reconnect.

## Layout

- `index.js`: invokes startup and reports a generic startup failure.
- `src/whatsapp.js`: explicit session startup, authentication, socket options,
  credential persistence, terminal QR output, and event wiring.
- `src/messages.js`: message filtering, text extraction, and sequential replies
  through a supplied send function.
- `src/commands.js`: pure command-to-reply decisions.

Eligible `!ping` messages (trimmed and case-insensitive) receive exactly
`Pong! Running on Bun 🚀`. Text comes from `conversation`, falling back to
`extendedTextMessage.text` only when the conversation value is nullish.

The preserved filtering baseline handles only `notify` batches and skips
own-account messages, group destinations, missing destinations, and empty text.
This is not owner authorization: there is no sender allowlist, and own-account
self-chat commands are skipped. Authorization and self-chat support are future,
separate changes.

## Offline verification

Run the focused test suite:

```bash
bun test
```

Tests use synthetic messages, fake sends, and mocked WhatsApp startup facilities.
They cover filtering, exact responses, send order and rejection propagation,
startup wiring, private routine diagnostics, and the credential ignore rule.
They require neither live credentials nor network access and do not establish
live account behavior. Live WhatsApp checks require explicit opt-in.

This project was created using `bun init` in bun v1.4.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
