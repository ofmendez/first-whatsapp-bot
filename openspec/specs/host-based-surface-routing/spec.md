# host-based-surface-routing Specification

## Purpose
Define validated dual-host configuration, request-authority-based surface selection, route isolation, and deployment requirements for serving the admin dashboard and album from one application.

## Requirements
### Requirement: Dual-surface configuration is explicit and validated
The system SHALL enable the album only when a non-empty canonical HTTPS `ALBUM_ORIGIN` is configured. Dual-surface mode SHALL require an exact canonical HTTPS `PANEL_ORIGIN`, distinct admin and album hostnames, and non-empty, distinct `PASS_DASHBOAR` and `PASS_ALBUM` values. Invalid dual-surface configuration SHALL prevent startup with diagnostics that do not disclose secrets. With no `ALBUM_ORIGIN`, existing dashboard-only configuration and local operation SHALL remain supported.

#### Scenario: Both surfaces are configured
- **WHEN** valid distinct admin and album HTTPS origins and distinct non-empty passphrases are configured
- **THEN** the same loopback-bound application enables the two independently routed surfaces

#### Scenario: Album configuration is incomplete or ambiguous
- **WHEN** `ALBUM_ORIGIN` is set but the album secret is missing, the secrets match, the origins use the same hostname, either required origin is invalid, or `PANEL_ORIGIN` is a wildcard
- **THEN** startup fails without serving either surface or printing secret values

#### Scenario: Album is not enabled
- **WHEN** `ALBUM_ORIGIN` is absent or empty
- **THEN** existing dashboard-only operation remains available and setting `PASS_ALBUM` alone exposes no album route

### Requirement: Request authority selects the surface before dispatch
In dual-surface mode, the system SHALL select a surface only by matching the canonical request authority to one of the configured origin authorities, including its effective public port. The system SHALL reject malformed, conflicting, or unrecognized authorities before serving documents, authenticating, reading state or media, subscribing to events, or invoking actions. The system SHALL NOT use arbitrary forwarded headers to select the surface or expand origin trust.

#### Scenario: Admin host requests its root document
- **WHEN** a request uses the configured admin authority and requests `/`
- **THEN** the request enters the dashboard route and authentication policy

#### Scenario: Album host requests its root document
- **WHEN** a request uses the configured album authority and requests `/`
- **THEN** the request enters the album route and authentication policy rather than the dashboard policy

#### Scenario: Unknown host attempts access
- **WHEN** a request uses an authority not configured for either surface, even with a valid session cookie
- **THEN** the server returns a non-success response without disclosing either surface's HTML or invoking protected services

#### Scenario: Forwarded headers claim a different surface
- **WHEN** an unknown host supplies forwarded headers naming the admin or album host
- **THEN** the request remains rejected and the headers do not authorize access

#### Scenario: HTTPS proxy uses an HTTP upstream
- **WHEN** the HTTPS proxy forwards a request over loopback HTTP while preserving the configured public Host authority
- **THEN** the application selects the correct surface without treating the internal HTTP scheme as the allowed browser origin

### Requirement: Routes and build documents are isolated by surface
The system SHALL allow only the selected surface's public document map, authentication endpoints, permitted APIs, and non-secret build assets. The album host SHALL NOT expose dashboard documents, authentication endpoints, state, event streams, saved-image APIs, or WhatsApp control actions, even when a dashboard cookie is manually supplied. Internal Astro build paths and arbitrary files within `dist/` SHALL NOT be alternative public document routes. Unknown and cross-surface routes SHALL return 404; unsupported methods on known routes SHALL return 405 without dispatch.

#### Scenario: Album client requests dashboard data or actions
- **WHEN** a client on the album host requests `/api/state`, `/api/events`, `/api/media/*`, `/api/session/*`, `/api/messages/send`, or dashboard authentication endpoints
- **THEN** the server returns 404 without reading dashboard state, subscribing to events, opening media, creating dashboard sessions, or performing WhatsApp actions

#### Scenario: Admin client requests an album API
- **WHEN** a client on the admin host requests `/api/album/auth/login` or `/api/album/auth/logout`
- **THEN** the server returns 404 without creating or revoking an album session

#### Scenario: Client requests internal build paths
- **WHEN** a client requests `/album/`, `/album/index.html`, `/album/login/index.html`, or an encoded alias outside the selected surface's public document map
- **THEN** the server does not serve internal documents or bypass authentication

#### Scenario: Client requests a traversal path or unsupported method
- **WHEN** a request attempts static path traversal or an unsupported method on a known document or asset route
- **THEN** the server rejects it without reading files outside the allowed asset root or invoking any protected operation

#### Scenario: Browser requests mapped documents and public assets
- **WHEN** a browser requests `/`, `/index.html`, a supported `/login` alias, or a permitted fingerprinted `/_astro/` asset on a recognized host
- **THEN** the server applies the selected document's access policy, serves HTML with `no-store`, and permits public non-secret assets without granting either capability

### Requirement: Dual-surface deployment preserves the routing boundary
Deployment guidance SHALL describe two DNS hostnames, HTTPS proxy virtual hosts preserving the public Host authority, a loopback-only Bun upstream, private-route cache bypass, and login rate limiting for both authentication endpoints. Local dual-surface preview guidance SHALL retain HTTPS and secure-cookie behavior rather than adding an authentication bypass.

#### Scenario: Owner follows deployment guidance
- **WHEN** the owner configures the documented dual-surface deployment
- **THEN** both hosts reach the same private Bun process through HTTPS, unknown hosts are not routed to a default dashboard, and private/authentication responses are not cached

#### Scenario: Owner previews locally
- **WHEN** the owner follows the documented two-host local preview setup
- **THEN** each surface uses a matching explicit HTTPS origin and its own secure cookie without disabling authentication
