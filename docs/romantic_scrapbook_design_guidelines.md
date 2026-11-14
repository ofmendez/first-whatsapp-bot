# Couple Photo Album — Design Guidelines

## Objective
Create a **romantic, mature, elegant** photo-album website inspired by a **beige-and-white paper-cut scrapbook collage**. Photos are the visual priority. The couple's favorite colors, **purple and yellow**, should feel intentional rather than dominant.

## Design Direction
- Mood: intimate, nostalgic, warm, editorial, handcrafted, sophisticated.
- Visual language: layered paper textures, torn/cut-paper edges, overlapping photo mats, slight rotations, subtle shadows, generous whitespace.
- Keep compositions organic but readable; do not sacrifice usability for collage effects.
- Avoid childish motifs, excessive hearts, glitter, neon, saturated colors, or wedding-template clichés.

## Color Tokens
```css
:root {
  --bg: #FAF5EE;            /* warm ivory */
  --paper: #EDE2D3;         /* soft beige */
  --surface: #FFFDF9;       /* off-white */
  --primary: #6A4C7D;       /* dusty plum */
  --primary-soft: #B7A0C9;  /* lavender */
  --accent: #D6B25E;        /* muted gold */
  --accent-soft: #F2E3AE;   /* cream gold */
  --text: #3A2F3F;          /* dark cocoa-plum */
  --text-muted: #7A6F73;    /* warm gray */
  --border: #E6D8CC;        /* paper line */
  --primary-hover: #583A69;
  --accent-hover: #C29E4E;
}
```

**Target balance:** ~70% neutral paper tones / 20% purple / 10% gold. Use purple for headings, navigation and emphasis; gold for key actions, dates and small accents. Do not use light gold as small text on white.

## Components & Layout
- **Hero:** editorial title, short subtitle, layered photo collage, one clear CTA.
- **Gallery:** mixed portrait/landscape photo cards; paper mats, restrained rotation and spacing.
- **Memory sections:** photo clusters, dates, short notes, subtle paper/tape details.
- **Timeline (optional):** significant moments in chronological order.
- **Cards:** off-white/beige surfaces; soft shadows; understated borders.
- **Buttons:** muted-gold primary; plum-outlined secondary; clear focus/hover states.

## Typography & Interaction
- Headings: refined serif. Body/UI: legible sans-serif. Handwritten accent only sparingly.
- Prioritize responsive layouts: reduce overlap/rotation on small screens; preserve image visibility and reading order.
- Keep animations subtle and respect `prefers-reduced-motion`.
- Maintain accessible contrast, keyboard navigation, semantic structure, and meaningful image alt text.

## Design Priority
**Images > storytelling > decorative effects.** Every decoration should reinforce the scrapbook feel without obscuring the photographs or content.

## Reference
@docs/reference.jpg
