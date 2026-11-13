# session-control-panel Specification

## Purpose
TBD - created by archiving change astro-session-control-panel. Update Purpose after archive.
## Requirements
### Requirement: Local owner-only control panel
The system SHALL serve the Astro control panel and its state-changing control API from the same application process and bind them to loopback by default. The API SHALL reject cross-origin state-changing requests and SHALL NOT enable wildcard CORS. Remote VPS operation SHALL use an owner-controlled local tunnel rather than a public listener.

#### Scenario: Owner opens the local panel
- **WHEN** the owner opens the panel through the local interface or an SSH tunnel
- **THEN** the panel can read session state and submit protected control actions to the same application origin

#### Scenario: Remote or cross-origin control request
- **WHEN** a request attempts to control the session from a non-loopback interface or an untrusted origin
- **THEN** the server rejects the request and performs no WhatsApp action

### Requirement: Explicit single-session lifecycle
The control application SHALL start without opening a WhatsApp socket. The system SHALL create at most one socket when the owner explicitly starts a session, SHALL expose the current lifecycle state in the panel, and SHALL NOT automatically create a replacement socket after an unexpected connection closure.

#### Scenario: Explicit session start
- **WHEN** the owner selects Start while no session is active
- **THEN** the system creates one socket using the existing local authentication state and displays a starting or pairing state

#### Scenario: Repeated start action
- **WHEN** the owner selects Start while the session is starting, pairing, connected, or awaiting operator review
- **THEN** the system does not create another socket and returns the current state

#### Scenario: Unexpected connection closure
- **WHEN** the active socket closes without an explicit logout
- **THEN** the panel reports the disconnected state and the system does not automatically create another socket

### Requirement: Transient panel pairing QR
The system SHALL display the pairing QR in the panel only while pairing is pending. It SHALL clear the QR when the session connects, pairing is cancelled, the connection closes, or logout completes. It SHALL NOT write the QR value or rendered QR to routine logs.

#### Scenario: Pairing is pending
- **WHEN** the active socket emits a pairing QR
- **THEN** the local panel displays it and routine server logs contain no QR material

#### Scenario: Pairing state ends
- **WHEN** the session connects, closes, or is cancelled
- **THEN** the panel removes the previous QR from its displayed and in-memory state

### Requirement: Explicit logout and account switching
The system SHALL require an explicit owner action to log out. After remote logout succeeds and the old socket ends, the system SHALL remove the old local authentication state, clear transient session messages, and allow a new pairing to start using the same single-session slot. If remote logout fails, the system SHALL report that logout did not complete, retain the state needed for operator review, and SHALL NOT start another socket.

#### Scenario: Successful logout before switching account
- **WHEN** the owner confirms logout and Baileys completes remote unlinking
- **THEN** the old socket is ended, local authentication and transient message state are removed, and the panel offers a fresh pairing flow

#### Scenario: Logout failure
- **WHEN** remote logout or socket shutdown fails
- **THEN** the panel reports an operator-review state and a new session cannot start

#### Scenario: Ordinary process restart
- **WHEN** the control application restarts without an explicit logout
- **THEN** no message history is restored and the prior local authentication state remains available for a later explicit session start

### Requirement: Live direct-chat message view
The system SHALL display newly emitted direct-chat text message events from the current session, including events marked `fromMe` for the linked account's own “Message yourself” chat. The panel SHALL NOT display group conversations or request historical messages. It SHALL retain displayed message data only in bounded process memory and SHALL clear that data on logout or process exit.

#### Scenario: New message in another direct chat
- **WHEN** Baileys emits a new text message event for a one-to-one chat while the session is connected
- **THEN** the panel shows the new message, its direction, time, and available conversation label without requiring a history fetch

#### Scenario: New message in the account's own chat
- **WHEN** Baileys emits a new `fromMe` text message whose remote JID identifies the linked account's own chat
- **THEN** the panel displays it as a self-chat event without submitting it to automatic command processing

#### Scenario: Group or historical message
- **WHEN** a message belongs to a group or is part of historical synchronization rather than a new live direct-chat event
- **THEN** the panel does not present it as a new direct-chat message

#### Scenario: Message data is cleared
- **WHEN** the owner logs out or the application process exits
- **THEN** the in-memory conversation view is cleared and is not restored from disk after restart

### Requirement: Manual self-chat sending
The panel SHALL allow the owner to send a nonempty text message only to the linked account's own chat. The server SHALL derive the destination from active account state and SHALL reject a client-supplied recipient. A send SHALL require an explicit user action, concurrent or duplicate submissions SHALL be rejected, and failed sends SHALL NOT be retried automatically.

#### Scenario: Send to the linked account's own chat
- **WHEN** the owner submits nonempty text while the session is connected
- **THEN** the server sends it to the account's self-chat JID and reports the result in the panel

#### Scenario: Attempt to select another recipient
- **WHEN** a request supplies a group or other contact as its destination
- **THEN** the server rejects it without sending a message

#### Scenario: Duplicate or concurrent submission
- **WHEN** a second submission is made while the first send is in progress
- **THEN** the server rejects or ignores the duplicate and starts no second send

#### Scenario: Send failure
- **WHEN** the WhatsApp send operation fails
- **THEN** the panel reports failure without exposing raw error or message content in routine logs and performs no automatic retry

### Requirement: Honest account-risk status
The panel SHALL describe the controls as local safeguards against accidental exposure or sending and SHALL NOT claim that Baileys use, a send limit, or any panel feature guarantees avoidance of WhatsApp restrictions.

#### Scenario: Owner views risk information
- **WHEN** the owner views the panel's session or safety information
- **THEN** the panel does not present the unofficial integration as restriction-proof or officially approved

