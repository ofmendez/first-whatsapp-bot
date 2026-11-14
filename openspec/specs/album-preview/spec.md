# album-preview Specification

## Purpose
Define the authenticated Spanish scrapbook demo preview, including its content, accessibility, responsive behavior, performance, security policy, and visual isolation from the dashboard.

## Requirements
### Requirement: Album presents a Spanish romantic scrapbook preview
The authenticated album SHALL present Spanish navigation, headings, captions, and authentication feedback. It SHALL follow `docs/romantic_scrapbook_design_guidelines.md`: neutral ivory/beige paper materials, restrained plum and gold accents, refined serif headings, legible sans-serif body text, layered photo mats, subtle shadows, and restrained rotation. Photographs SHALL remain the visual priority; decoration SHALL NOT obscure meaningful photo content or introduce childish stickers, glitter, neon, excessive hearts, or wedding-template motifs.

#### Scenario: Visitor opens the authenticated album
- **WHEN** a visitor with album authorization opens the album root
- **THEN** the page displays a Spanish editorial title and short subtitle, a layered photo opening, a mixed portrait/landscape gallery, a closing memory cluster, and a visible sample-content disclosure

#### Scenario: Visitor explores the gallery
- **WHEN** the visitor activates “Explorar recuerdos”
- **THEN** the page navigates to the gallery section using an accessible in-page anchor without requiring a folder reader or requesting dashboard data

### Requirement: Album content is bundled demonstration material only
The preview SHALL use approximately 6–8 locally bundled, licensed demo photographs and clearly identified sample notes rather than personal image storage. Asset provenance, licenses, and required attribution SHALL be recorded. The page SHALL visibly disclose “Fotografías y textos de muestra” or equivalent Spanish wording and SHALL NOT present invented couple names, dates, or milestones as authentic facts. The preview SHALL NOT scan `received-images/`, apply image-loading conditions, subscribe to message events, or fetch existing dashboard media.

#### Scenario: Demo album loads without personal media
- **WHEN** an authenticated visitor loads the album with no received-image folders or WhatsApp connection
- **THEN** the complete static preview renders from its bundled demo content without contacting the received-image store or dashboard APIs

#### Scenario: Visitor encounters sample storytelling
- **WHEN** a visitor reads captions or notes accompanying the demo photos
- **THEN** visible disclosure identifies the photos and storytelling as demonstration content rather than the owner's real memories

#### Scenario: Demo bytes are requested directly
- **WHEN** an unauthenticated client requests a public fingerprinted demo image asset
- **THEN** it can receive only bundled non-personal demo bytes, and project documentation explicitly states this is not a private-media delivery mechanism

### Requirement: Album remains usable across viewports and input methods
The album and its login SHALL use semantic structure, Spanish document language, meaningful photo alt text, accessible form labels and status feedback, visible keyboard focus, and readable text/control contrast. Narrow viewports SHALL reduce overlap and rotation, preserve image visibility and logical reading order, and avoid horizontal overflow. Nonessential motion and smooth scrolling SHALL respect `prefers-reduced-motion`.

#### Scenario: Visitor uses a narrow screen
- **WHEN** the album is viewed at a 390-pixel-wide viewport
- **THEN** images, captions, navigation, login, and sign-out remain visible and usable without horizontal scrolling or decorative overlap hiding content

#### Scenario: Visitor uses only a keyboard
- **WHEN** the visitor tabs through album login, navigation, the gallery anchor, and sign-out
- **THEN** every interactive element is operable in a logical order with visible focus and understandable labels

#### Scenario: Visitor prefers reduced motion
- **WHEN** the browser reports `prefers-reduced-motion: reduce`
- **THEN** the page removes nonessential animation and smooth scrolling without hiding content

#### Scenario: A demo photograph fails to load
- **WHEN** a bundled photograph cannot be loaded
- **THEN** its reserved layout space and meaningful alternative text preserve comprehension without obscuring adjacent content

### Requirement: Album assets are efficient and comply with existing security policy
The album SHALL load photographs, fonts, textures, styles, and executable scripts from the same origin. It SHALL preserve the existing script CSP without inline executable exceptions, provide image dimensions and responsive sizing, and defer below-the-fold images while prioritizing the lead photograph. No client-side UI framework or third-party runtime asset service SHALL be required.

#### Scenario: Browser loads the built preview under CSP
- **WHEN** the production album and login are served under the existing security headers
- **THEN** their images, fonts, styles, and external authentication scripts load without third-party requests or weakening `script-src 'self'`

#### Scenario: Browser loads the opening composition
- **WHEN** the visitor initially opens the album
- **THEN** the lead photograph is prioritized, lower-page images can load lazily, and declared dimensions limit image-induced layout movement

### Requirement: Album styling does not change the dashboard
The album SHALL use a separate layout and scoped visual system rather than replacing the dashboard's styles, content, DOM integration hooks, or behavior. Design documentation SHALL distinguish the album's scrapbook world from the existing operational dashboard.

#### Scenario: Owner returns to the admin host
- **WHEN** the dashboard is rendered after the album is added
- **THEN** its existing masthead, controls, states, activity layout, authentication, and responsive behavior remain intact without album typography or paper styling leaking into it
