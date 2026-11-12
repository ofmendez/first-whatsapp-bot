#  Initial feature inventory for a private Bun + Baileys bot

Act as a high-criteria OpenSpec exploration agent. Read `openspec/config.yaml` and inspect the actual repository before drawing conclusions. The project is intended to be a small, self-hosted Bun + JavaScript ESM + Baileys application on a Linux VPS. It should send and receive private WhatsApp text messages for the owner, with the option to authorize one family member later. It uses an ordinary personal WhatsApp account, not WhatsApp Business or a paid messaging gateway.

## Your task

Explore the feasibility and boundaries of the following **candidate features**, then create or update **one inventory file**: `docs/feature-backlog.md`. **Do not implement anything.** Each feature should be a possible, independent future `opsx-explore -> opsx-propose -> opsx-apply` change. Include mainly the features that focus on reduce the WhatsApp restrict automated account risks. This is a discovery backlog, not an approved roadmap.

### Candidate features (keep the initial set small)

1. **Runtime and account-topology feasibility** — Verify the installed Baileys version under Bun; investigate whether one linked personal account can meaningfully send messages to and receive replies from the owner's own WhatsApp self-chat, or whether a second ordinary account is required for an independent bot contact.
2. **Single-session pairing and durable authentication** — Initial QR/linking, safely persisted credentials, single active session, and predictable startup after a VPS restart.
3. **Private two-way text messaging and allowlist** — Accept incoming messages only from the owner; send only to approved recipient(s); handle the optional family-member authorization as a separate, later scope decision. Avoid self-message feedback loops.
4. **Outbound notification volume controls** — Configurable rate limits, a per-day budget, burst coalescing, and rejection or deferral when the local safety budget is exceeded. No claim that a numeric limit prevents account restrictions.
5. **Delivery discipline and bounded recovery** — A minimal pending-message mechanism, deduplication, finite retries with exponential backoff, explicit disconnected/restricted/logout handling, and no automatic attempts to bypass a restriction.
6. **Privacy, security, and operational visibility** — Protection of authentication state, restrictive interfaces, redacted logs, minimal useful health information, and explicit operator action when pairing or account review is required.
7. **Small-VPS deployment and operational continuity** — Bun process lifecycle, environment/secrets handling, durable storage, resource constraints, and restart behavior for AWS EC2 or Google Compute Engine. Evaluate whether a separate fallback notification channel is necessary; do not include it in the MVP by default.

### Required inventory format

For each candidate feature in `docs/feature-backlog.md`, provide only:
- A short **feature ID and title**.
- Its **user-visible purpose**, in one or two sentences.
- **Dependencies or ordering constraints**, if any.
- The **main unanswered question or risk** that its own future `opsx-explore` command should investigate.

Also add a brief **Open Questions** section, prioritizing (a) one-number self-chat versus separate bot number, (b) actual Bun/Baileys compatibility, and (c) unacceptable consequences if the primary account is restricted. Mark assumptions as unverified where appropriate.

### Boundaries

- Do **not** create OpenSpec change directories, proposals, specs, design documents, task lists, code, tests, Docker files, or dependencies in this pass.
- Do **not** choose specific storage, queue, database, API framework, retry numbers, or message rate thresholds now. Those belong to future, separately approved atomic changes.
- No bulk/group messaging, user discovery, anti-ban techniques, fingerprint spoofing, proxy rotation, or enforcement evasion.
- Do not overengineer. Consolidate or split features only when the repository shows a practical reason, and explain any change to the candidate inventory briefly.
- Treat unofficial WhatsApp access as a continuing policy and account-availability risk; keep a future official-integration option distinct rather than claiming Baileys can be made risk-free.

**Deliverable:** only `docs/feature-backlog.md` plus a concise summary of findings and unresolved questions. Stop before `opsx-propose` command.
