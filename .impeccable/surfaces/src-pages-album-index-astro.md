---
version: 1
slug: "src-pages-album-index-astro"
primary_target: "src/pages/album/index.astro"
related_targets: ["src/pages/album/login.astro"]
---

# Private album surface

## Scope

A separate authenticated Spanish-language scrapbook for explicitly approved conversation images. Mode: Experience.

## Audience and task

A visitor with album authorization explores approved photographs and can sign out. The photos lead; message dates and optional attached/corrected captions add no invented story.

## Constraints

The direction is pinned by `docs/romantic_scrapbook_design_guidelines.md` and `docs/reference.jpg`; use the reference's paper mats and layering, not its stickers or childlike decoration. Keep dashboard layout, styles, and behavior separate. Runtime personal media is fetched only from album-host APIs after album authorization; never copy it into public build assets or add an inline executable script. The licensed sample photograph is retained only for the login illustration. Explain consent, private metadata, correction, and restart boundaries in the README.

## Direction contract

**THESIS:** Make explicitly approved photographs feel like the contents of one intimate paper album, not a generic gallery template or a dashboard tab.

**OWN-WORLD:** Warm ivory, beige paper, off-white mats, dusty plum, and muted gold in the supplied 70/20/10 balance; refined locally served serif headlines, readable sans-serif copy, layered paper edges, restrained rotation, and soft real shadows. No childish stickers, glitter, neon, excessive hearts, or wedding-template motifs.

**STORY:** Authorized visitors see a quiet “Recuerdos” heading followed by approved photographs, message dates, and only real optional captions. Loading, empty, retry, end, and unavailable-image states remain calm and clear.

**FIRST VIEWPORT:** A narrow quiet masthead carries “Nuestro álbum”, “Recuerdos”, and “Salir”. Below it, the Spanish “Recuerdos” heading introduces the gallery directly. On mobile, photos and long captions become a single-column sequence with no overlap or horizontal overflow.

**FORM:** The brief-pinned scrapbook spread is the chosen form; its structure and material direction come from the OpenSpec and supplied visual guidelines, so no concept-seed tournament was run. Baseline dashboard/login captures were inspected at 1440px and 390px before album work.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
