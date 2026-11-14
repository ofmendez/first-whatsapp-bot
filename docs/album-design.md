# Private album design

## Direction

The album is a separate, authenticated Experience surface: a mature Spanish scrapbook whose approved photographs lead and whose interface recedes. It follows `docs/romantic_scrapbook_design_guidelines.md` and borrows the reference collage's layered mats, paper edges, and quiet rotation—not its stickers, childish motifs, or hand-drawn hearts. The gallery does not invent stories, descriptions, or captions. The one licensed demo photograph remains only on the album login screen; it is not album content.

## Layout and reading order

- A quiet masthead identifies “Nuestro álbum” and provides the “Recuerdos” anchor and “Salir” action.
- The real album begins with the “Recuerdos” heading and a responsive scrapbook gallery; it has no demo opening/closing story, sample labels, invented captions, or sample-content disclosure.
- Photos use alternating four-item placements, paper mats, gentle rotation, and generous whitespace. Each photo shows its Spanish UTC calendar date from the WhatsApp message timestamp, then an optional effective caption as plain text.
- Empty, loading, retry, and end states are quiet and announced. A keyboard-operable “Cargar más” control complements bounded automatic pagination. Missing/broken media retains its mat and displays a neutral Spanish alternative. “Volver al inicio” targets the real album masthead.

## Palette and materials

Use the supplied palette and approximate balance of 70% neutral paper, 20% plum, and 10% gold:

| Token                | Value     | Use                                                                              |
| -------------------- | --------- | -------------------------------------------------------------------------------- |
| Warm ivory           | `#FAF5EE` | Page ground                                                                      |
| Soft beige paper     | `#EDE2D3` | Paper mats and secondary surfaces                                                |
| Off-white            | `#FFFDF9` | Photo borders and quiet surfaces                                                 |
| Dusty plum           | `#6A4C7D` | Headings, navigation, emphasis                                                   |
| Lavender             | `#B7A0C9` | Restrained secondary details                                                     |
| Muted gold           | `#D6B25E` | Primary action and small accents                                                 |
| Cream gold           | `#F2E3AE` | Large, quiet gold surfaces only                                                  |
| Cocoa-plum           | `#3A2F3F` | Main text and readable gold-action text                                          |
| Warm gray            | `#7A6F73` | Supplied reference token; small copy uses the darker contrast-safe variant below |
| Accessible warm gray | `#70666A` | Muted text on ivory and paper surfaces (5.10:1 against `#FAF5EE`)                |
| Paper border         | `#E6D8CC` | Mats and dividers                                                                |
| Plum hover           | `#583A69` | Plum interaction state                                                           |
| Gold hover           | `#C29E4E` | Gold interaction state                                                           |

Headings use locally served Literata under SIL OFL 1.1; body and controls use a readable system sans-serif. Paper mats use restrained borders and soft offset shadows. Gold is never used as small text on a light surface. The supplied warm gray `#7A6F73` measures 4.45:1 on ivory, so the page uses `#70666A` for small muted text.

## Responsive and accessible behavior

At narrow widths, use one clear reading column, reduce rotation, keep captions and image frames within the viewport, and preserve reading order. One image is centered and generous; larger collections repeat the four placements. Use semantic landmarks, Spanish document language and neutral alt text, visible keyboard focus, readable contrast, explicit login feedback, and a labeled sign-out action. Announce gallery status without stealing focus. Hide purely decorative details from assistive technology and respect reduced-motion preferences.

## Surface isolation and content boundary

The album has its own Astro layout, page components, stylesheet, login script, and one local licensed login illustration. Its protected list/media APIs are available only on the configured album host and require the independent album session. Runtime originals and JSON sidecars remain under the Git-ignored `received-images/` directory; personal media is not built into public assets. The dashboard's prefixed styles and control hooks remain separate.

## Consent and retained content

- Only an incoming direct-contact text that normalizes exactly to `inicia album` opts in. The normalization accepts case, Unicode compatibility forms, and whitespace variations, but not extra words or punctuation. Self-chat, outgoing messages, groups, history, captions, and quoted text are excluded.
- Approval applies to the whole retained account/chat folder, including supported images saved before approval and future supported images. Approved folders from retained accounts remain included when another account is active. Approval survives logout, account switching, and process restart; it is never inferred from a display name.
- The bot attempts the specified Spanish confirmation only after durable approval. The single attempt is reserved first; a crash or send failure may mean no confirmation is delivered, and automatic retry is intentionally absent.
- The date is the WhatsApp message timestamp, not EXIF/camera date or file modification time. Legacy images recover a date from their generated filename; captions are never guessed.
- Sidecars support owner-only `captionOverride` edits. Missing or `null` uses the original attached caption, an empty string hides it, and a nonempty string replaces it. Stop image intake before manually editing valid sidecar JSON; the next album load refreshes the correction.
- The dashboard-only “Albumed only” filter changes presentation of retained live events, not ingestion or album membership. Its default is off. Dashboard activity remains limited to the latest 200 in-memory events and is cleared on logout/process exit; saved approvals and images persist separately.

## Baseline

Before album implementation, `bun run build` passed and `bun test` passed 51 tests with 302 expectations. The unchanged dashboard and login were inspected at 1440px desktop and 390px mobile; WhatsApp remained stopped.

## Verification and deployment boundary

- The historical preview implementation was built and reviewed with licensed sample content. The current root page instead fetches real approved records through album-host-only APIs; no private media is part of the static build.
- Production proxy, Cloudflare cache/rate-limit rules, firewall policy, and origin TLS remain deployment-owner responsibilities and are not verified by local tests.
- The login illustration's Pexels provenance and the locally served Literata font license are recorded in `docs/album-demo-assets.md` and `docs/licenses/`.
- Current headless Chromium review used a local synthetic API stub (not the application listener) at 1440px and 390px. It exhausted 120 synthetic records in five bounded pages and checked date-only, captioned, long-caption, portrait/landscape, missing-dimension fallback, failed-media, empty, single-image, failed-network/retry, reduced-motion, keyboard loading, login feedback, and album sign-out states. The dashboard and both login surfaces were also reviewed at desktop/mobile; the dashboard filter toggled 2 retained mock events to 1 and back. No horizontal overflow was measured at 390px.
- Build, API, and storage tests provide the separate server/privacy boundary checks. The browser pass used no live credentials or personal image files, did not start WhatsApp, and did not send a message.

The dashboard contract remains the existing “Local Session Board” documented in `DESIGN.md`; album styles and the separate surface brief document this additional surface without re-skinning the dashboard. See the README for deployment, opt-in, private metadata, and correction procedures.
