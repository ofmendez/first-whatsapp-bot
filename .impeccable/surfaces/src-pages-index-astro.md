---
version: 1
slug: "src-pages-index-astro"
primary_target: "src/pages/index.astro"
related_targets: []
---

# Session control panel surface

## Scope

Single-page local web interface for an owner operating one WhatsApp session. Mode: Operate.

## Audience and task

The account owner starts or ends a session, scans a transient QR, checks newly emitted direct-chat text, and optionally sends a message to their own chat. Session state and safety boundaries take priority over message browsing.

## Constraints

The UI is served as static Astro output by the same loopback-bound Bun process as its control API. WhatsApp does not connect until an explicit start action. Messages are bounded and memory-only; the panel cannot select an arbitrary recipient. Live self-chat event visibility is unverified until an owner runs the opt-in procedure.

## Direction contract

**THESIS:** Make one account's live connection state and deliberate switching unmistakable; refuse a general-purpose messaging dashboard.

**OWN-WORLD:** Use the visual grammar of a departure board only for type, tabular time and direction, a tightly reserved alert color, and one signature move: the latest connection state and new event remain highlighted in place until the next update replaces them. Keep navigation, controls, and work areas as familiar web UI.

**STORY:** The owner can immediately read whether a session is stopped, pairing, connected, disconnected, or awaiting review; they can see what happened in this process and know what a logout or send will do.

**FIRST VIEWPORT:** A dark local-only masthead sits above a large WhatsApp title and live connection readout. Below, the session controls and pairing state occupy a compact left column; the bounded event timeline and self-chat form occupy the wider right column. A concise safety and retention summary stays beside session controls on narrow screens; the full-width safety statement and retention note follow the work area.

**FORM:** The user selected the departure-board direction, a fusion of `vernacular-ephemera-boarding-pass-and-gate-board`, in response to seed `f82815ba`. The world's palette and type serve state legibility; they do not turn the panel into a picture of an airport screen.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
