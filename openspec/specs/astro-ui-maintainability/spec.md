# astro-ui-maintainability Specification

## Purpose
TBD - created by archiving change astro-ui-tooling-refactor. Update Purpose after archive.
## Requirements
### Requirement: Astro control panel has focused source boundaries
The static control panel SHALL compose its major page responsibilities from focused Astro components and SHALL keep browser-side interaction code in a separately bundled client module. Component extraction SHALL preserve the page's existing DOM hooks and same-origin API usage and SHALL NOT add a client-side UI framework or alter control-panel behavior.

#### Scenario: Build the componentized control panel
- **WHEN** the production Astro build runs
- **THEN** it emits the control panel as static assets with its browser module bundled for the existing Bun server

#### Scenario: Preserve frontend integration hooks
- **WHEN** the extracted browser module initializes against the componentized page
- **THEN** it can locate the existing session, QR, activity, image-preview, and self-chat controls and continues using the existing same-origin endpoints

### Requirement: Tailwind styling preserves the established interface contract
The Astro control panel SHALL use Tailwind CSS 4 within the existing static Astro build and SHALL express the existing design tokens and responsive layout through the shared stylesheet and focused component styles. The production UI SHALL preserve existing semantic status presentation, accessibility states, and desktop/mobile layout behavior.

#### Scenario: Build Tailwind styles for the static panel
- **WHEN** the production Astro build processes the panel stylesheet
- **THEN** the output contains the Tailwind utilities and bespoke state styles used by the control panel without requiring an additional runtime

#### Scenario: Render responsive and session states
- **WHEN** the panel is viewed at wide and narrow viewport widths in stopped, pairing, connected, and review-required states
- **THEN** the established layout hierarchy, state text/indicators, and controls remain readable and usable

#### Scenario: Render live activity styles
- **WHEN** the browser creates text and image activity rows at runtime
- **THEN** production styles are available for incoming/outgoing metadata, newest-event highlighting, image previews, and unavailable-image states

### Requirement: Oxlint provides a repeatable application lint command
The project SHALL provide a Bun-invokable Oxlint command for maintained application JavaScript, JavaScript embedded in Astro script blocks, and test code. The command SHALL return a failing status when it reports lint errors and SHALL exclude generated output, dependencies, local credentials/media, and unrelated tool workspaces. Astro template markup and CSS coverage SHALL NOT be represented as Oxlint coverage.

#### Scenario: Lint maintained application code
- **WHEN** the developer runs the project's lint command on code with no enabled Oxlint violations
- **THEN** the command completes successfully for the configured application and test sources

#### Scenario: Report an application lint violation
- **WHEN** configured application code contains an enabled Oxlint violation
- **THEN** the lint command reports the violation and exits unsuccessfully

#### Scenario: Exclude generated and private local files
- **WHEN** the lint command scans the repository
- **THEN** it does not scan generated build output, installed dependencies, local authentication/media data, or unrelated tool workspaces

### Requirement: Oxfmt provides repeatable formatting and check commands
The project SHALL provide Bun-invokable Oxfmt commands to format and check maintained application source, tests, and relevant project configuration, including `.astro`, JavaScript, and CSS files. Astro formatting SHALL be enabled with its required compiler support, and Tailwind class sorting SHALL be enabled for supported UI markup. The check command SHALL report unformatted files without modifying them.

#### Scenario: Format maintained Astro and application source
- **WHEN** the developer runs the project's format command
- **THEN** Oxfmt formats configured maintained source, including Astro files and their supported embedded code, and sorts Tailwind classes where supported

#### Scenario: Check formatting without changing files
- **WHEN** the developer runs the project's format-check command on unformatted maintained source
- **THEN** the command reports the files that need formatting, exits unsuccessfully, and leaves those files unchanged

#### Scenario: Check already formatted source
- **WHEN** the developer runs the format-check command after formatting the configured source
- **THEN** the command completes successfully without modifying files

