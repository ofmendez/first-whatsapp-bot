# Optional live self-chat validation

This procedure is an explicit owner action for an account whose pairing and
restriction risk the owner accepts. **It is not part of `bun test`, CI, app
startup, or any automated verification.** No live validation has been performed
for this change.

## Before starting

- Use the target Bun and installed Baileys versions, and record those versions
  without recording phone numbers or JIDs.
- Run the app on loopback and open `http://127.0.0.1:3008` locally, or use an
  owner-controlled SSH tunnel as described in the README.
- Keep private message content, QR screenshots, and account identifiers out of
  notes and routine logs. Use short, non-sensitive test markers.

## Procedure

1. Choose **Start session** in the panel and pair using the intended account.
   Confirm the QR disappears and the panel reports **Connected**.
2. On the paired phone, open **Message yourself** and send a unique marker.
   Check whether a new outgoing/self-chat event appears in the panel.
3. Send a different unique marker from the panel's **Message yourself** form.
   Check whether it arrives on the phone and whether Baileys emits a matching
   outgoing self-chat event to the panel.
4. Choose **Log out & switch account**, confirm, and wait for the panel to
   report that logout completed. Confirm that a new pairing can then be
   started. If any logout/close/cleanup step fails, stop and leave the app in
   its operator-review state; do not start another socket.
5. Record only the result category, date, Bun version, Baileys version, and a
   non-identifying setup label below. Do not record message bodies, sender
   identifiers, auth material, or QR data.

## Optional live image validation

Image receive and storage validation is also an explicit owner action; it is
not run by tests, CI, or app startup. Use the target Bun/Baileys versions and
only an account whose pairing and restriction risk the owner accepts.

1. Start and connect the account from the loopback panel.
2. From a direct contact, send one supported image with a short caption and a
   second image without a caption. Confirm that both appear as live image rows
   and that the caption is shown only for the first.
3. Send an image to the linked account's own self-chat and confirm the event
   appears with the self-chat label. Do not use groups or history to validate
   the live-image path.
4. Confirm locally that the images are in flat account/chat folders under
   `./received-images/`. Treat folder names as sensitive because they include
   account and chat identifiers; do not copy them into notes, logs, or issue
   reports.
5. Log out and restart the process. Confirm the stored files remain while the
   prior activity rows are not restored. This manual check does not establish
   historical completeness or guarantee that all images are delivered.
6. Remove test images manually when they are no longer needed. The application
   has no automatic cleanup, expiry, or per-image size cap; storage grows until
   files or the root directory are manually deleted.

## Result and UI disclosure

Default result: **NOT RUN**. After the manual procedure, set
`WHATSAPP_SELF_CHAT_VALIDATION` when launching the app:

- `not-run` (default): no claim of verified self-chat event visibility.
- `passed`: both directions were observed in this manual check. The UI still
  states that this does not guarantee delivery or historical completeness.
- `phone-message-not-visible`: the phone-authored self-chat event was not
  emitted to the panel.
- `panel-message-not-visible`: the panel-authored self-chat event was not
  emitted to the panel.
- `both-directions-not-visible`: neither direction was emitted to the panel.

For example, after a successful manual check:

```bash
WHATSAPP_SELF_CHAT_VALIDATION=passed bun run start
```

If an expected event is absent, select its limitation value and keep the
corresponding UI disclosure. Do not describe self-chat visibility as reliable
for that setup. A later successful check may update the result, but still does
not establish delivery guarantees or historical completeness.

## Validation record

| Date | Result | Bun version | Baileys version | Non-identifying setup label |
| --- | --- | --- | --- | --- |
| Not run | `not-run` | — | — | — |
