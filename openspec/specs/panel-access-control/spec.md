# panel-access-control Specification

## Purpose
Define authentication and authorization boundaries for the private admin dashboard, including server-verified credentials, process-local capability-bound sessions, and secure deployment.

## Requirements
### Requirement: Dashboard passphrase is verified by the server
The system SHALL require a non-empty `PASS_DASHBOAR` server environment value before startup and SHALL fail closed with a diagnostic that does not disclose secret values when it is missing. The system SHALL verify the submitted passphrase on the server and SHALL NOT include the configured or submitted passphrase in client assets, responses, persistent browser storage, or routine logs.

#### Scenario: Dashboard secret is missing
- **WHEN** the application starts without a non-empty `PASS_DASHBOAR`
- **THEN** startup fails and no unauthenticated dashboard or control API is served

#### Scenario: Owner submits the correct passphrase
- **WHEN** the owner submits the configured dashboard passphrase over the configured same-origin HTTPS site
- **THEN** the server creates a dashboard-authorized session and returns an opaque session cookie without returning the passphrase or a bearer token in the response body

#### Scenario: Owner submits an incorrect passphrase
- **WHEN** a client submits an incorrect or empty passphrase
- **THEN** the server denies authentication with a generic failure that does not reveal the configured value or whether the server secret is set

#### Scenario: Authentication request is cross-origin
- **WHEN** a dashboard login or logout request has a missing or non-matching `Origin`
- **THEN** the server rejects the request without creating or revoking a session

### Requirement: Dashboard session protects private routes
The system SHALL require a valid session authorized for the `dashboard` capability before serving the dashboard document or returning dashboard state, live events, saved-image previews, or WhatsApp control actions. The system SHALL check authorization before reading protected state, subscribing to events, opening media, or invoking a control action. Unauthenticated dashboard page navigation SHALL redirect to the login page; unauthenticated API and media requests SHALL return an unauthorized response.

#### Scenario: Unauthenticated browser requests dashboard
- **WHEN** a browser requests the dashboard without a valid dashboard session
- **THEN** the server redirects it to the public login page without returning dashboard HTML

#### Scenario: Unauthenticated client requests private data
- **WHEN** a client without a valid dashboard session requests session state, the event stream, or a saved-image preview
- **THEN** the server returns an unauthorized response and does not expose state, subscribe to events, or return image bytes

#### Scenario: Unauthenticated client submits a control action
- **WHEN** a client without a valid dashboard session submits a state-changing WhatsApp action
- **THEN** the server returns an unauthorized response and performs no WhatsApp action

#### Scenario: Authenticated browser uses dashboard
- **WHEN** a browser presents a valid dashboard session
- **THEN** existing dashboard state, event, image-preview, and control behavior remains available subject to existing same-origin protections

### Requirement: Dashboard session is private and capability-bound
The system SHALL issue an unpredictable opaque session token after successful dashboard authentication, SHALL keep session records only in process memory, and SHALL bind each session to the `dashboard` capability. The session cookie SHALL be `HttpOnly`, `Secure`, `SameSite=Strict`, host-only, and use `Path=/`; it SHALL NOT have a persistent browser expiration. The system SHALL invalidate dashboard sessions on explicit sign-out or process restart and SHALL NOT impose a time-based session expiration.

#### Scenario: Dashboard session cookie is issued
- **WHEN** authentication succeeds
- **THEN** the browser receives a secure, HTTP-only, same-site dashboard cookie and the response is not cacheable

#### Scenario: Owner signs out
- **WHEN** the owner signs out of the dashboard
- **THEN** the presented dashboard session is revoked, its cookie is cleared, and the WhatsApp session continues unchanged

#### Scenario: Application restarts
- **WHEN** the application process restarts
- **THEN** previously issued dashboard cookies no longer authorize access because their in-memory sessions are gone

### Requirement: Album passphrase is verified only for album access
When the album is enabled, the system SHALL verify the configured `PASS_ALBUM` only on the album host's login endpoint. It SHALL require a non-empty album secret distinct from `PASS_DASHBOAR`, compare fixed-length digests in constant time, and never include configured or submitted passphrases in client assets, responses, URLs, browser storage, or routine logs. Invalid submissions SHALL receive generic failure feedback.

#### Scenario: Visitor supplies the correct album passphrase
- **WHEN** a visitor submits the correct album passphrase as same-origin JSON to `POST /api/album/auth/login` on the configured album host
- **THEN** the server issues an album-only session cookie without returning a passphrase or bearer token in the response body

#### Scenario: Visitor supplies an incorrect or malformed submission
- **WHEN** album login receives an empty, incorrect, malformed, or non-string passphrase submission
- **THEN** the server denies authentication with generic feedback and does not issue an authorized session

#### Scenario: Visitor uses the album credential for dashboard login
- **WHEN** a visitor submits only `PASS_ALBUM` to the dashboard login endpoint
- **THEN** dashboard authentication fails

#### Scenario: Visitor uses the dashboard credential for album login
- **WHEN** a visitor submits only `PASS_DASHBOAR` to the album login endpoint
- **THEN** album authentication fails

### Requirement: Album documents require independent album authorization
The system SHALL require a valid session with only the `album` capability before serving album documents, including supported direct document aliases. Unauthenticated album navigation SHALL redirect to the album host's login page without returning album HTML. Dashboard sessions SHALL NOT grant album access; album sessions SHALL NOT grant dashboard access. Authorization SHALL remain enforced when a client manually transplants a cookie token between hosts or cookie names.

#### Scenario: Unauthenticated visitor opens the album
- **WHEN** a visitor without a valid album session requests `/` or `/index.html` on the album host
- **THEN** the server redirects to `/login/` without returning the album document

#### Scenario: Dashboard token is manually submitted as an album token
- **WHEN** a client supplies a valid dashboard token under either cookie name to the album document
- **THEN** the server does not authorize album access

#### Scenario: Album token is manually submitted as a dashboard token
- **WHEN** a client supplies a valid album token under either cookie name to an admin document or API
- **THEN** the server does not authorize dashboard access or invoke dashboard services

#### Scenario: Authenticated album visitor opens the preview
- **WHEN** a visitor presents a valid album session on the configured album host
- **THEN** the server serves only the album surface's protected documents and never grants dashboard permissions

### Requirement: Album sessions are private and independently revocable
Album sessions SHALL use unpredictable opaque tokens with digest-only records held in process memory and an `album_session` cookie set with `HttpOnly`, `Secure`, `SameSite=Strict`, host-only scope, and `Path=/`, without a persistent browser expiration. The system SHALL impose no time-based album session expiration. Explicit album sign-out SHALL revoke only the presented album session and clear its cookie. Process restart SHALL invalidate album sessions. Album HTML, login, and authentication responses SHALL use `Cache-Control: no-store`.

#### Scenario: Album session is issued
- **WHEN** album login succeeds
- **THEN** the response sets the required album cookie attributes and cannot be cached

#### Scenario: Visitor signs out of the album
- **WHEN** a visitor signs out through `POST /api/album/auth/logout` on the album host with a permitted origin
- **THEN** the presented album session is revoked, its cookie is cleared, the browser returns to album login, and dashboard sessions and WhatsApp state remain unchanged

#### Scenario: One album visitor signs out while another remains signed in
- **WHEN** one of two independent album sessions signs out
- **THEN** only that session is revoked and the other remains authorized

#### Scenario: Application restarts
- **WHEN** the application process restarts
- **THEN** previously issued album cookies no longer authorize access and no album sessions are restored from disk

### Requirement: Public dashboard deployment uses a trusted HTTPS origin
The system SHALL keep the Bun listener bound to loopback and SHALL validate state-changing request origins against the explicitly configured public HTTPS origin when deployed behind a reverse proxy. When the album is disabled, `PANEL_ORIGIN` MAY use the canonical wildcard form `https://*.<hostname>` to allow HTTPS subdomains of that hostname, excluding the apex and requiring an exact scheme and port. When the album is enabled, the system SHALL require exact admin and album HTTPS origins and SHALL reject mutations whose `Origin` differs from the selected surface's origin, including sibling subdomain origins. The system SHALL NOT trust arbitrary forwarded-host headers to determine the allowed origin. Deployment guidance SHALL require HTTPS between the browser and Cloudflare and between Cloudflare and the VPS proxy, no public direct access to the Bun port, private-route cache bypass, and a login-endpoint rate limit for each enabled surface.

#### Scenario: Same-origin action through configured HTTPS proxy
- **WHEN** an authenticated browser submits a state-changing request through the configured public HTTPS origin for the selected surface
- **THEN** the server accepts the origin check and applies the existing action-specific validation

#### Scenario: Request uses an untrusted origin or forwarded host
- **WHEN** a state-changing request's `Origin` does not match the selected surface's allowed public origin, even if forwarded-host headers claim otherwise
- **THEN** the server rejects the request before any state-changing action

#### Scenario: Configured wildcard origin receives a subdomain request
- **WHEN** the album is disabled and a state-changing request uses an HTTPS subdomain matching `PANEL_ORIGIN=https://*.example.com` with the same effective port
- **THEN** the server accepts the origin check while continuing to reject origins for the apex, other domains, or mismatched schemes and ports

#### Scenario: Public deployment starts without dashboard secret
- **WHEN** the VPS deployment starts without `PASS_DASHBOAR`
- **THEN** the application does not serve the dashboard or its APIs

#### Scenario: Sibling surface submits an authentication mutation
- **WHEN** a request to one configured host's login or logout endpoint supplies the other configured host's `Origin`, or no `Origin`
- **THEN** the server rejects it without creating or revoking a session, even if the browser considers the two hosts same-site

### Requirement: Browser scripts comply with the strict content security policy
The system SHALL serve executable dashboard and login scripts as external same-origin assets and SHALL NOT require an inline-script exception in the content security policy.

#### Scenario: Browser loads the login handler
- **WHEN** the login page is served with `script-src 'self'`
- **THEN** its form handler loads from a same-origin script asset without inline execution, a nonce, or an unsafe-inline policy
