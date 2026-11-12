## Requirements

### Requirement: Preserve ping responses
The system SHALL respond to eligible text whose trimmed, lowercase value is `!ping` by sending exactly `Pong! Running on Bun 🚀` to the message's original remote JID. The system SHALL extract text from `conversation`, falling back with nullish semantics to `extendedTextMessage.text`. Other commands SHALL produce no reply.

#### Scenario: Plain text ping
- **WHEN** a notify batch contains an incoming non-group message with conversation text `  !PiNg  ` and a remote JID
- **THEN** the system sends exactly one response with the required text to that JID

#### Scenario: Extended text ping
- **WHEN** an otherwise eligible message has no conversation value and has extended text `!ping`
- **THEN** the system sends the same ping response to its remote JID

#### Scenario: Unknown command
- **WHEN** an eligible message contains `!unknown`
- **THEN** the system sends no reply

### Requirement: Preserve message eligibility
The system SHALL process only `notify` upserts and SHALL skip messages marked `fromMe`, messages without a remote JID, messages without nonempty extracted text, and destinations ending in `@g.us`. This requirement describes the existing filtering baseline and SHALL NOT be interpreted as sender authorization or self-chat support.

#### Scenario: Non-notify event
- **WHEN** an upsert has a type other than `notify`
- **THEN** the system sends no replies for that batch

#### Scenario: Own-account traffic
- **WHEN** a message is marked `fromMe`, including an own-account self-chat command
- **THEN** the system sends no reply to that message

#### Scenario: Group or incomplete message
- **WHEN** a message has a group destination, no remote JID, or no nonempty supported text
- **THEN** the system sends no reply to that message

#### Scenario: Conversation takes precedence
- **WHEN** a message has an empty conversation string and extended text `!ping`
- **THEN** the system does not fall back from the empty conversation string and sends no reply

### Requirement: Preserve per-batch sending semantics
The system SHALL await replies sequentially within each upsert batch. A rejected send SHALL reject processing of that batch without retrying or sending subsequent replies in it. This change SHALL NOT add cross-batch ordering guarantees.

#### Scenario: Multiple commands in a batch
- **WHEN** two eligible ping messages occur in one batch
- **THEN** the first send completes before the second send starts, each using its respective destination

#### Scenario: Sending fails
- **WHEN** sending a response rejects
- **THEN** batch processing rejects without an automatic retry or a send for subsequent messages in that batch

### Requirement: Offline-callable processing
The command and message-processing modules SHALL be importable and callable with synthetic events and a supplied send function without opening a WhatsApp connection or accessing authentication files.

#### Scenario: Offline message processing
- **WHEN** a Bun test imports the processing modules and invokes them with a synthetic ping and a fake send function
- **THEN** the fake function receives the expected destination and reply without network access or credential access

### Requirement: Preserve explicit session startup
The system SHALL start a single socket on explicit application startup using the existing `./auth_info` location, silent library logging, and `markOnlineOnConnect: false`. It SHALL register credential persistence, terminal QR generation, connection status reporting, and incoming-message processing. Connection closure SHALL report logout distinctly from other closures without automatically opening another socket.

#### Scenario: Startup wiring
- **WHEN** startup is invoked with mocked Baileys facilities
- **THEN** one socket is created with the existing options and handlers are registered for credentials, connection updates, and messages

#### Scenario: QR and connection updates
- **WHEN** connection updates provide a QR or report an open connection
- **THEN** the system renders the QR in the terminal with small output or reports that WhatsApp connected, respectively

#### Scenario: Disconnection classification
- **WHEN** a connection update reports closure
- **THEN** the system reports `Session logged out` for the logged-out status or `Connection lost` otherwise and does not create a replacement socket

### Requirement: Private routine diagnostics
The system SHALL NOT print message bodies, phone numbers, authentication material, or raw startup error objects in routine application diagnostics. QR output SHALL be confined to the terminal pairing flow. The repository SHALL ignore the root `auth_info/` directory.

#### Scenario: Command diagnostics
- **WHEN** an incoming command or unknown text is processed
- **THEN** routine application output does not expose its content or sender identifier

#### Scenario: Startup failure
- **WHEN** application startup rejects
- **THEN** the entry point reports a generic startup failure without printing the raw error or credential material

#### Scenario: Local authentication files
- **WHEN** untracked credential files exist beneath the root `auth_info/` directory
- **THEN** Git's ignore rules exclude those files from ordinary staging
