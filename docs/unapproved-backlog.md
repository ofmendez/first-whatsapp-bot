# Private WhatsApp bot — discovery backlog

This is an unapproved inventory of possible independent future `opsx-explore -> opsx-propose -> opsx-apply` changes, grounded in `openspec/config.yaml`, the current repository, and the installed Baileys source. The seven initial candidates are retained: the existing single-file prototype gives no practical reason to expand or consolidate them. Dependencies below describe prerequisites, not a committed roadmap.

The intended scope is a small, self-hosted Linux VPS application using Bun, JavaScript ESM, and an ordinary personal WhatsApp account, initially for the owner. Controls here limit accidental misuse, exposure, and repeated automated activity; unofficial access remains a continuing policy and account-availability risk. No message limit or configuration makes Baileys restriction-proof. An official integration would require a distinct future evaluation of its account, product, and cost requirements; it is not assumed compatible with the current personal-account scope.

## F01 — Runtime and account-topology feasibility

- **User-visible purpose:** Establish whether the owner can use one account's self-chat for useful two-way interaction, or needs a second ordinary account to see the bot as an independent contact. 
- **Dependencies or ordering constraints:** First feasibility gate for F02–F05 and F07; the owner's acceptance of possible account restriction is also a prerequisite to real-account validation.
- **Main unanswered question or risk:** Installed and locked Baileys is `7.0.0-rc14`; an offline import under Bun `1.4.3` succeeds, but its package declares Node.js `>=20`, not verified Bun support. Can pairing, text exchange, self-chat event delivery, and authentication reuse work reliably on the target Linux runtime? `index.js` drops every `fromMe` message, and the installed decoder marks own-account traffic as `fromMe`; self-chat command/reply distinction and phone notification behavior remain unverified. Linking a device does not create another account identity; an independent bot contact requires a separate account.

## F02 — Single-session pairing and durable authentication

- **User-visible purpose:** Let the owner link the bot once and resume a valid session after a VPS restart, with only one active bot session using its authentication state. Require deliberate operator action when authentication cannot safely resume.
- **Dependencies or ordering constraints:** F01 establishes runtime and account choice; coordinate credential protection with F06 before relying on persisted authentication. F05 owns ongoing disconnected-message recovery, while F07 owns process startup on the VPS.
- **Main unanswered question or risk:** Does the existing QR flow and `useMultiFileAuthState("./auth_info")` provide adequate durability and recoverability for this deployment, including interrupted credential/key updates, corrupt state, and competing processes? The helper is not proof of production suitability or cross-process exclusion; neither crash recovery nor restart reuse has been verified. The repository contains `auth_info/`, currently untracked and absent from `.gitignore`; its presence does not prove successful pairing.

## F03 — Owner-only two-way text and allowlist

- **User-visible purpose:** Process private text only from the owner and send only to explicitly approved recipients, rejecting other senders and destinations by default. Prevent the bot's own messages from triggering reply loops; authorizing a consenting family member remains a separately approved later scope decision.
- **Dependencies or ordering constraints:** F01 determines owner-versus-bot identity and self-chat semantics; F02 provides the authenticated session. Coordinate all outbound paths with F04 and later retries with F05.
- **Main unanswered question or risk:** How can the selected topology reliably identify the owner across phone-number and LID identifiers and distinguish an owner command from bot output? Currently `index.js` accepts qualifying non-group text from any sender, logs it, and answers `!ping` without an allowlist; skipping `fromMe` alone does not establish usable self-chat or complete authorization.

## F04 — Outbound notification volume controls

- **User-visible purpose:** Prevent accidental notification floods through configurable rate limits, a daily local budget, and burst coalescing. Make rejection or deferral visible when the local budget is exhausted, without suggesting that any numeric threshold prevents WhatsApp restrictions.
- **Dependencies or ordering constraints:** F01 and F03 establish account scope and authorized outbound messages. F05 must honor the same controls for replay and retries; F07 must preserve their intended behavior across process restarts.
- **Main unanswered question or risk:** What actual notification patterns and acceptable delays should determine the local budget, coalescing semantics, and reject-versus-defer behavior? No controls exist in the prototype; overlapping event handlers, restart resets, or reconnect backlogs could defeat an otherwise plausible budget. Thresholds and persistence choices remain undecided.

## F05 — Delivery discipline and bounded recovery

- **User-visible purpose:** Keep a minimal pending-message mechanism, suppress duplicates, and retry transient failures only finitely with exponential backoff. Make disconnected or uncertain delivery visible and stop for operator review on logout, account restriction, or unrecoverable authentication failure, without automatic restriction-bypass attempts.
- **Dependencies or ordering constraints:** F02 supplies session lifecycle, F03 enforces recipients, and F04 governs every send attempt. Coordinate review-required status with F06 and restart behavior with F07.
- **Main unanswered question or risk:** Which installed-release events distinguish temporary disconnects, logout, possible restriction, and uncertain delivery, and what loss/duplicate tradeoff is acceptable after a crash or missing acknowledgement? Current connection handling only logs closure and distinguishes logout; it has no application pending-message mechanism, deduplication, bounded retry policy, or explicit restriction review state. Library-internal retry behavior must also be understood; exactly-once delivery and reliable restriction detection are unverified.

## F06 — Privacy, security, and operational visibility

- **User-visible purpose:** Protect linked-account credentials and private text, restrict operational interfaces, and give the owner minimal redacted health information. Clearly indicate when pairing or account review needs operator action without exposing message bodies, phone numbers, keys, or linking secrets.
- **Dependencies or ordering constraints:** Credential and log protection can be explored immediately and should precede real-account operation. Coordinate auth-state boundaries with F02, review states with F05, and filesystem/network exposure with F07; no network API is presumed necessary.
- **Main unanswered question or risk:** What is the smallest useful health/status surface and operator-access model that preserves privacy? `index.js` prints incoming text, displays QR linking material, and forwards top-level errors to the console despite silencing the library logger; authentication is not Git-ignored. Filesystem permissions, error redaction, retention, and exposure through terminal or service logs remain unverified.

## F07 — Small-VPS deployment and continuity

- **User-visible purpose:** Keep one Bun application process operable on a small AWS EC2 or Google Compute Engine Linux VPS, with controlled environment/secrets handling, durable state, resource use, and restart behavior. Determine whether missed notifications justify a separately approved fallback channel, excluded from the MVP by default.
- **Dependencies or ordering constraints:** F01 validates the runtime on the target platform; operational deployment depends on F02–F06 establishing session, authorization, volume, recovery, and privacy behavior. Process restarts must respect review-required stops rather than restart around them.
- **Main unanswered question or risk:** What resource footprint, working-directory/state durability, and restart policy support this prototype without session duplication, replay floods, or repeated pairing attempts? No deployment lifecycle is documented; `README.md` points to `index.ts` although the application is `index.js`, and its stated Bun version differs from the installed runtime. Acceptable downtime and whether WhatsApp failure must be reported outside WhatsApp remain unknown; no process manager, fallback service, or infrastructure is selected.

## Open Questions

1. **One-number self-chat or separate bot number?** Must the owner see an independent contact, or is interacting with their own self-chat acceptable? The installed decoder and current `fromMe` exclusion establish a concrete handling conflict, not proof that self-chat is impossible. Receipt of phone-authored self-chat events, distinguishing bot output, and useful phone notifications need explicitly opted-in validation. A second ordinary account supplies a distinct identity but does not eliminate unofficial-access risk.
2. **Actual Bun/Baileys compatibility?** The lockfile and installed package agree on Baileys `7.0.0-rc14`; Bun reports `1.4.3`. An offline dynamic import verified the socket factory, auth helper, and JID normalizer exports without creating a socket or accessing live authentication. Pairing, encryption/decryption, key persistence, reconnect behavior, and target-VPS dependencies remain **unverified**. The upstream README warns of v7 breaking changes; its examples are context, not evidence that this exact combination works.
3. **Unacceptable consequences of primary-account restriction?** Would temporary or permanent loss of the owner's normal WhatsApp access, contacts' ability to reach them, or notification delivery be unacceptable? No tolerance is recorded. This decision must precede live validation or choosing the primary account; low-volume, owner-only traffic is not a guarantee of account availability. If the risk is unacceptable, pause the Baileys path and evaluate alternatives separately.
4. **Notification importance and later scope?** Which notifications are expected, what delay/loss/duplicate behavior is tolerable, and how would the owner notice an outage? These answers determine local controls and whether an independent fallback deserves its own change. Family-member consent and authorization remain a later decision, not an initial requirement.

Evidence: `index.js`, `package.json`, `bun.lock`, `.gitignore`, `README.md`, `openspec/config.yaml`, installed Baileys `package.json` and its `lib/Utils/{decode-wa-message,use-multi-file-auth-state}.js`, the offline import described above, and the [upstream Baileys README](https://github.com/WhiskeySockets/Baileys/blob/master/README.md) for unofficial-access, linking, and v7 context. No live account connection or message exchange was performed, and authentication contents were not inspected. OpenSpec reports no active changes.
