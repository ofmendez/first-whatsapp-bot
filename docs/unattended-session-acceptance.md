# Unattended WhatsApp session acceptance checklist

This is an **owner-run, opt-in** checklist for the target VPS, Bun version, and
installed Baileys version. It is not part of `bun test`, CI, application
startup, or deployment automation. Automated tests use synthetic auth and
messages and never contact WhatsApp.

Unattended use carries the normal risks of an unofficial WhatsApp integration.
Run real-account checks only if the account owner explicitly accepts those
risks. Do not record phone numbers, JIDs, message bodies, QR images, auth
material, or private filesystem paths.

## Before any real-account check

- [ ] The account owner explicitly approved this real-account validation and
  accepts the account-restriction risk.
- [ ] `WHATSAPP_AUTOSTART=true` is set in the service account's private `.env`;
  the PM2 process was restarted with updated environment.
- [ ] PM2 is configured for one forked instance with watching disabled, the Bun
  listener is loopback-only, and `auth_info/` remains private to the service
  account.
- [ ] The linked account is already registered. First-time pairing is performed
  explicitly from the dashboard, never by unattended startup.
- [ ] A non-identifying test contact is available for the existing eligible
  command and consent-approved image check. `!ping` has no sender allowlist;
  only use a contact the owner has chosen for this test.

If a prerequisite is not met, stop and record the check as **NOT RUN**. Do not
delete authentication or try to force a pairing/recovery attempt.

## Checks

1. **Saved-account process restart**
   - [ ] Close every dashboard tab.
   - [ ] Restart the application through PM2 with updated environment.
   - [ ] Verify PM2 remains online and the loopback dashboard service is
     available, without opening the dashboard.
   - [ ] Confirm the account resumes only from saved registered auth; no
     background QR or pairing is initiated.

2. **Processing with the dashboard closed**
   - [ ] Close every dashboard tab and stop using the local computer. Keep the
     VPS online and power off the local computer.
   - [ ] From the owner-selected direct contact, send one eligible `!ping`
     command and verify the expected existing reply.
   - [ ] For a conversation with existing explicit album consent, send one
     supported image and verify it is saved by the VPS service.
   - [ ] Do not use groups, historical messages, or a new unapproved
     conversation for this check.

3. **VPS reboot persistence**
   - [ ] Confirm `pm2 save` was run as the service account and the service
     account's PM2 startup unit was installed.
   - [ ] Reboot the VPS.
   - [ ] Verify the service account's `pm2-<service-user>` unit, `pm2 status`,
     loopback listener, and saved-account resume after boot.
   - [ ] Repeat one owner-approved command and consent-approved image check
     while all dashboard tabs remain closed.

4. **Controlled transient recovery**
   - [ ] Perform this only with explicit owner approval and only if a safe,
     controlled transient disconnect can be produced without repeated pairing,
     message sending, or account-risk escalation.
   - [ ] Verify supported transient recovery uses the finite 2, 4, 8, 16, and
     30 second delays, with no more than five replacement attempts in one
     cycle.
   - [ ] Verify recovery stops for terminal/unknown failures, credential-save
     failures, or uncertain socket closure and leaves the process/dashboard
     available for owner review.
   - [ ] If no safe transient check is available, record **NOT RUN**; do not
     manufacture an account failure to satisfy this item.

5. **Manual fallback and rollback**
   - [ ] With unattended mode disabled, verify the dashboard remains
     manual-only and explicit **Start session** is available for pairing.
   - [ ] If rolling back, set `WHATSAPP_AUTOSTART=false`, restart PM2 with
     updated environment, and verify credentials remain in place and no
     automatic socket is started.

## Validation record

Record only the result category, date, software versions, and a
non-identifying setup label. Use **NOT RUN** for any check not performed.

| Check | Result (`PASS` / `FAIL` / `NOT RUN`) | Date | Bun / Baileys / PM2 | Non-identifying notes |
| --- | --- | --- | --- | --- |
| Saved-account process restart | NOT RUN | — | — | — |
| Dashboard-closed command and image processing | NOT RUN | — | — | — |
| VPS reboot persistence | NOT RUN | — | — | — |
| Controlled transient recovery | NOT RUN | — | — | — |
| Manual fallback and rollback | NOT RUN | — | — | — |

Do not change these defaults to `PASS` until the owner has performed and
recorded each applicable check on the target deployment.
