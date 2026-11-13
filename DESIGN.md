---
name: WhatsApp Session Control
description: A local, owner-operated panel for one live WhatsApp session.
colors:
  primary: "#14566c"
  primary-hover: "#0e4457"
  white: "#fff"
  page-canvas: "#e9eef0"
  ink: "#102b3a"
  panel: "#fbfcfb"
  status-panel: "#f8faf9"
  form-panel: "#f4f7f7"
  secondary-control: "#f3f7f7"
  masthead-text: "#f3f7f8"
  text-muted: "#526771"
  border: "#cad5d8"
  divider: "#d8e0e2"
  secondary-text: "#163746"
  secondary-border: "#a8bac1"
  disabled-field: "#e9eeee"
  field-border: "#aebdc1"
  danger-bg: "#fff7f5"
  danger-text: "#7c2a22"
  danger-border: "#d7a6a0"
  state-idle: "#647781"
  state-connected: "#167143"
  state-pending: "#a74d00"
  state-review: "#a02f26"
  local-indicator: "#8fe0b0"
  status-halo-idle: "#e2e8e9"
  status-halo-connected: "#d9efe2"
  status-halo-pending: "#f9e5d2"
  status-halo-review: "#f5ddda"
  alert-bg: "#fff8e6"
  alert-border: "#d6c18b"
  alert-text: "#493b21"
  alert-heading: "#3f3219"
  alert-copy: "#4d4128"
  alert-icon: "#7d4500"
  alert-icon-border: "#9b5a0b"
  event-new-bg: "#fff5d6"
  event-new-label-bg: "#f5df9e"
  event-new-label-text: "#714000"
  connection-update-text: "#754000"
  brand-mark: "#ffcf58"
  selection: "#ffe08a"
typography:
  display:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(38px, 5vw, 58px)"
    fontWeight: 720
    lineHeight: 1.05
    letterSpacing: "-.045em"
  title:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "21px"
    lineHeight: 1.2
    letterSpacing: "-.025em"
  body:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "15px"
    lineHeight: 1.5
  label:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "11px"
    fontWeight: 700
    letterSpacing: ".1em"
  code:
    fontFamily: 'ui-monospace, "Cascadia Mono", monospace'
    fontSize: ".95em"
rounded:
  micro: "3px"
  field: "6px"
  button: "7px"
  review: "8px"
  callout: "9px"
  readout: "10px"
  panel: "12px"
  circle: "50%"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.white}"
    rounded: "{rounded.button}"
    padding: "11px 16px"
    width: "100%"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.secondary-control}"
    textColor: "{colors.secondary-text}"
    rounded: "{rounded.button}"
    padding: "11px 16px"
    width: "100%"
  button-danger:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger-text}"
    rounded: "{rounded.button}"
    padding: "11px 16px"
    width: "100%"
  button-send:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.white}"
    rounded: "{rounded.button}"
    padding: "11px 16px"
  input-textarea:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "11px 12px"
  card-session:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.panel}"
    padding: "25px"
  card-status:
    backgroundColor: "{colors.status-panel}"
    rounded: "{rounded.readout}"
    padding: "16px 18px"
  activity-new-row:
    backgroundColor: "{colors.event-new-bg}"
    padding: "15px 24px"
  chip-new:
    backgroundColor: "{colors.event-new-label-bg}"
    textColor: "{colors.event-new-label-text}"
    rounded: "{rounded.micro}"
    padding: "2px 5px"
  callout-safety:
    backgroundColor: "{colors.alert-bg}"
    rounded: "{rounded.callout}"
    padding: "17px 20px"
---

# Design System: WhatsApp Session Control

## Overview

**Creative North Star: “The Local Session Board”**

The panel borrows departure-board discipline only in compact status typography, tabular date/time/counts, state colors, and the in-place `UPDATED` and `NEW` markers. Its masthead, buttons, fields, bordered work areas, and responsive stacking remain familiar web UI. A cool light canvas and dark blue-green ink keep the single-session controls and live events easy to scan.

**Key Characteristics:**
- Cool neutral surfaces, dark blue-green ink, and a restrained teal action color.
- System sans-serif hierarchy with tabular numerals for time and counts.
- Semantic state color and persistent update markers; no airport-screen decoration.

## Colors

The palette is built around cool blue-gray neutrals, with teal for deliberate actions and amber, green, and red reserved for focus, state, and caution cues.

### Primary
- **Control Teal** (`{colors.primary}`): Primary session and send actions; the darker hover is `{colors.primary-hover}`.

### Secondary
- **Local Indicator Green** (`{colors.local-indicator}`): The masthead’s local-only dot; connected status uses `{colors.state-connected}`.
- **Wordmark Gold** (`{colors.brand-mark}`): Limited to the masthead glyph.

### Tertiary
- **Pending Amber** (`{colors.state-pending}`): Pairing/starting state and the shared keyboard-focus outline.
- **Review Red** (`{colors.state-review}`): Disconnected and operator-review state indicators.
- **Update Gold** (`{colors.event-new-bg}`): Newest-event row emphasis; the `NEW` badge uses `{colors.event-new-label-bg}`.
- **Caution Paper** (`{colors.alert-bg}`): Retention and safety callouts, edged with `{colors.alert-border}`.

### Neutral
- **Blue-Gray Ink** (`{colors.ink}`): Main text and the dark masthead background.
- **Cool Canvas** (`{colors.page-canvas}`): Page background.
- **Panel White** (`{colors.panel}`): Session and activity work surfaces.
- **Readout White** (`{colors.status-panel}`): Connection status surface.
- **Composer Gray** (`{colors.form-panel}`): Message composer footer.
- **Quiet Copy** (`{colors.text-muted}`): Repeated supporting text and metadata.
- **Structural Border** (`{colors.border}`) and **Divider** (`{colors.divider}`): Panel edges and internal separators.

## Typography

**Display Font:** System UI stack (`typography.display`).  
**Body Font:** The same system UI stack (`typography.body`).  
**Label/Mono Font:** Compact uppercase labels use the body stack; inline code uses `typography.code`.

**Character:** Direct, compact sans-serif typography carries the interface. Date, event time, event count, and numbered safeguards use tabular numerals; compact uppercase sent/received labels and other metadata provide the limited board-like cue.

### Hierarchy
- **Display** (`typography.display`): The page title.
- **Title** (`typography.title`): Section headings.
- **Body** (`typography.body`): Explanatory and event text.
- **Label** (`typography.label`): Date, readout, and compact metadata labels; individual labels may use the nearby sizes and tracking visible in the CSS.

## Layout

The centered content is capped at `1440px`, with side gutters `clamp(20px, 5vw, 76px)`. Desktop work areas use a narrower session column beside the wider activity panel (`minmax(260px, .72fr)` / `minmax(0, 1.55fr)`, `20px` gap); the activity panel’s minimum height steps from `540px` to `480px`, then relaxes on the narrow layout. At `850px` and below columns stack; at `560px` and below the title holds at `42px`, the concise safety/retention note stays in the session panel, the empty state shortens, composer controls and retention footer stack, and page gutters become `16px`. The full-width safety callout follows the work areas. Spacing is contextual rather than a fixed scale; use the component padding values above where the same component recurs.

## Elevation & Depth

Work surfaces are flat, separated by cool borders and tonal backgrounds; there are no surface-lifting shadows. Small outer halos around the local and connection indicators communicate status. New event rows enter with a short upward fade; reduced-motion settings remove that animation and smooth scrolling, and disable button transitions.

## Shapes

Controls and panels use gently rounded corners from the observed `rounded` tokens: fields, buttons, review/callout surfaces, readout, and work panels each retain their own radius. Status lights, numbered fact marks, and the safety symbol are circular. Borders are thin and cool-toned; QR content sits in a white bordered frame.

## Components

### Buttons
- **Shape:** Compact rounded controls (`{rounded.button}`), with a `46px` minimum height and `11px 16px` padding.
- **Primary:** Teal fill with white text for starting and sending; the send control has a `150px` minimum width and fills the row on narrow screens.
- **Hover / Focus:** Primary and send actions darken on hover; all buttons lift `1px`. Keyboard focus uses the shared `3px` amber outline with `3px` offset. Disabled buttons use reduced opacity and a not-allowed cursor.
- **Secondary / Danger:** Bordered pale controls distinguish cancel from the pale red logout action.

### Cards / Containers
- **Corner Style:** Session and activity panels share the larger panel radius.
- **Background:** White-toned panels sit on the cool page canvas; the composer has a subtly darker fill.
- **Shadow Strategy:** Flat; borders and tonal surfaces define the panels.
- **Internal Padding:** The session panel uses `25px`; the activity heading, rows, and composer use their own inset values.

### Inputs / Fields
- **Style:** White textarea, thin blue-gray stroke, and a compact field radius; it can resize vertically.
- **Focus:** Shared visible keyboard outline.
- **Disabled:** Muted field fill while the session is not connected.

### Signature Components
- **Connection readout:** A bordered status card pairs a textual state with a state-colored light and a matching halo. `UPDATED · <STATE>` appears after a status transition and persists until a later transition replaces it.
- **Activity row:** Metadata aligns sender/direction, a tabular time, and a `NEW` badge. The newest row remains tinted until a newer event takes its place.
- **Session boundary note:** The session controls carry a compact amber summary of the 200-event memory cap, clearing behavior, and restriction limitation; the expanded safety statement follows the work areas.
- **Safety callout:** A pale amber bordered panel pairs a circular exclamation mark with the caution text.

## Do's and Don'ts

### Do:
- **Do** keep controls and work areas in familiar web patterns; reserve the board influence for type, tabular data, state color, and persistent update cues.
- **Do** use the state-colored light alongside the written connection status.
- **Do** keep date, event time, counts, and numbered facts tabular.
- **Do** retain the cool borders, flat surfaces, and compact status labels.

### Don't:
- **Don't** turn the panel into an airport-screen illustration or use board styling for navigation and controls.
- **Don't** use state colors as general decoration or replace the written state with color alone.
- **Don't** add surface shadows, gradients, or a new spacing/radius scale absent from the shipped CSS.
