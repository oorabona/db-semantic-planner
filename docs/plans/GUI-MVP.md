---
doc-meta:
  status: draft
  scope: gui
  type: specification
  created: 2026-02-12
  updated: 2026-02-12
  review: multi-llm (codex+gemini+copilot) 2026-02-12
---

# GUI-MVP — Desktop Database Explorer Specification

## Overview

Tauri v2 desktop application for db-semantic-planner. 9 MVP features in 9 implementation blocks.

**Refs:** [Brief](../briefs/gui-explorer.md) | [Architecture](gui-overview.md) | [Scope Index](../scopes/docs-gui-index.md)

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Desktop framework | Tauri v2 |
| Frontend | React 19 + ShadCN/UI + Tailwind CSS |
| State management | Zustand |
| Data table | TanStack Table |
| Code editor | @monaco-editor/react |
| Layout | react-resizable-panels |
| Backend bridge | Node.js SEA sidecar |
| IPC protocol | JSON-RPC over stdin/stdout |
| Password storage | tauri-plugin-stronghold |
| Connection profiles | App-level (with secrets) + project override (no secrets) |
| NQL standalone | Introspection → auto ModelIR |
| NQL TextMate grammar | Generated from Chevrotain lexer tokens |
| Result export | CSV only (MVP) |
| Test strategy | Vitest (stores/hooks/IPC) + Playwright (E2E) |
| Release hosting | GitHub Releases + Tauri updater |
| IPC transport | Transport-agnostic abstraction (stdin for desktop, HTTP/WS for future web) |
| IPC framing | Newline-delimited JSON (JSON Lines), logs to stderr only |
| Query safety | maxRows default 10,000 + timeoutMs default 30,000 + cancel method |
| SSL/TLS | sslMode enum (disable/allow/prefer/require/verify-full), default: prefer |
| Credential handling | Individual fields in connect (no URL), redaction in logs/errors |
| CI build strategy | Per-OS matrix (ubuntu/windows/macos runners) for SEA + Tauri |
| Connection scoping | connectionId returned by connect, required on all subsequent calls |
| Result pagination | Server-side cursors via cursorId + fetchMore method (60s inactivity timeout) |
| Input validation | Valibot (NOT Zod) for JSON-RPC parameter validation in sidecar |

## Block Dependency Graph

```
Block 1 (Scaffold)
    └──→ Block 2 (Sidecar IPC) ─────────────────────────────────┐
            └──→ Block 3 (Connection Manager)                    │
                    └──→ Block 4 (Schema Treeview)               │
                            ├──→ Block 5 (SQL Editor) ──┐        │
                            └──→ Block 6 (NQL Editor) ──┼──→ Block 7 (Results Table)
                                        │                         │
                                        └──→ Block 8 (Plan Inspector)
                                                                  │
                                                         Block 9 (Distribution)
```

**Dependencies:**
- Block 8 (Plan Inspector) depends on Block 6 (NQL) + Block 7 (Results) — plans are NQL-only, displayed in results panel.
- Block 9 (Distribution) depends on Block 2 (sidecar packaging) + Block 7 (Results) — must bundle sidecar binary.
- **Critical path:** 1 → 2 → 3 → 4 → 6 → 7 → 8 → 9
- **Parallel:** Blocks 5 and 6 can be developed in parallel after Block 4.
- **Fail-fast recommendation:** Validate SEA binary build (skeleton) in Block 2 to detect cross-platform packaging issues early.

---

## Block 1 — Scaffold (GUI-001)

### Goal
Create `packages/gui` with Tauri v2 + React 19 + ShadCN/UI. The app launches with a 3-panel layout skeleton.

### Files to create
```
packages/gui/
├── src-tauri/
│   ├── src/main.rs              # Tauri bootstrap
│   ├── src/lib.rs               # Tauri command stubs
│   ├── Cargo.toml               # Tauri v2 deps
│   ├── tauri.conf.json          # Window config, bundle settings
│   └── capabilities/default.json # Tauri v2 capabilities
├── src/
│   ├── main.tsx                 # React entry
│   ├── App.tsx                  # Root layout with resizable panels
│   ├── App.css                  # Global styles
│   ├── components/
│   │   └── layout/
│   │       ├── Sidebar.tsx      # Left panel placeholder
│   │       ├── EditorPanel.tsx  # Top-right panel placeholder
│   │       └── ResultsPanel.tsx # Bottom-right panel placeholder
│   └── lib/
│       └── utils.ts             # ShadCN cn() helper
├── index.html
├── package.json                 # @dbsp/gui
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── tailwind.config.ts
├── postcss.config.js
└── components.json              # ShadCN config
```

### BDD Scenarios

```gherkin
Scenario: Scaffold creates runnable Tauri app
  Given packages/gui does not exist
  When I run the scaffold commands
  Then pnpm -C packages/gui tauri dev launches a window
  And the window shows a 3-panel layout (sidebar + editor + results)

Scenario: Resizable panels persist sizes
  Given the app is running
  When I drag the panel divider to resize
  Then the panel sizes update
  And the sizes persist on reload (localStorage)

Scenario: ShadCN components available
  Given the scaffold is complete
  When I import a ShadCN component (Button, Tabs, etc.)
  Then it renders with Tailwind styling
```

### Exit Criteria
- [ ] `pnpm -C packages/gui tauri dev` opens a Tauri window
- [ ] 3-panel layout visible with placeholder content
- [ ] Panel resize works with react-resizable-panels
- [ ] ShadCN/UI configured (at least Button, Tabs, Input available)
- [ ] Tailwind CSS working
- [ ] `pnpm -C packages/gui test` runs vitest (even if 0 tests)

---

## Block 2 — Sidecar IPC (GUI-002)

### Goal
Node.js sidecar entry point with JSON-RPC protocol. Tauri Rust commands manage the sidecar lifecycle.

### Files to create/modify
```
packages/gui/
├── src-tauri/
│   ├── src/lib.rs               # Add sidecar commands
│   ├── src/sidecar.rs           # Sidecar lifecycle (spawn, restart, heartbeat)
│   └── src/ipc.rs               # JSON-RPC request/response codec
├── sidecar/
│   ├── index.ts                 # Sidecar entry point (stdin/stdout JSON-RPC)
│   ├── router.ts                # Method dispatch
│   ├── protocol.ts              # JSON-RPC types + version handshake
│   └── tsconfig.json
├── src/
│   └── lib/
│       ├── ipc.ts               # Frontend: typed invoke wrappers
│       └── ipc-transport.ts     # Transport abstraction (stdin today, HTTP/WS future)
```

### JSON-RPC Protocol

**Framing:** Newline-delimited JSON (JSON Lines). Each message is a single line terminated by `\n`. The sidecar MUST NOT write anything to stdout except JSON-RPC messages. All logging MUST go to stderr. The sidecar entry point monkey-patches `console.log/warn/info/debug` to write to stderr on startup.

```typescript
// Request (one JSON object per line, terminated by \n)
{"jsonrpc":"2.0","id":1,"method":"introspect","params":{"schema":"public"}}\n

// Response (success)
{"jsonrpc":"2.0","id":1,"result":{"tables":[...]}}\n

// Response (error)
{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Connection refused"}}\n

// Handshake (first message after spawn)
{"jsonrpc":"2.0","id":0,"method":"handshake","params":{"version":"1.0.0"}}\n

// Heartbeat (periodic notification, no id)
{"jsonrpc":"2.0","method":"heartbeat"}\n
```

**Cross-platform:** The JSON-RPC codec MUST normalize `\r\n` → `\n` before parsing (Windows line endings). Both sides treat `\n` as the message delimiter.

**Security:** Connection URLs MUST be redacted in all error messages, logs, and crash reports. Passwords never appear in JSON-RPC responses.

### Sidecar Methods

| Method | Params | Returns | Source API |
|--------|--------|---------|------------|
| `handshake` | `{ version }` | `{ version, capabilities }` | — |
| `connect` | `{ host, port, database, user, password, schema?, sslMode? }` | `{ ok, connectionId, tables: number }` | `new Pool()` |
| `disconnect` | `{ connectionId }` | `{ ok }` | `pool.end()` |
| `introspect` | `{ connectionId, schema?, exclude?, include? }` | `IntrospectedModelIR` | `introspect()` |
| `executeSQL` | `{ connectionId, sql, params?, maxRows?, timeoutMs? }` | `{ rows, columns, rowCount, timeMs, truncated, cursorId? }` | `pool.query()` |
| `compileNQL` | `{ connectionId, nql }` | `{ sql, params, plan?, warnings }` | `compileNqlToSql()` |
| `executeNQL` | `{ connectionId, nql, maxRows?, timeoutMs? }` | `{ rows, columns, rowCount, timeMs, plan, truncated, cursorId? }` | compile + execute |
| `fetchMore` | `{ cursorId, maxRows? }` | `{ rows, columns, rowCount, timeMs, truncated, cursorId? }` | cursor fetch |
| `cancel` | `{ requestId }` | `{ ok }` | `pg_cancel_backend()` |
| `getCompletions` | `{ text, position, language, connectionId }` | `{ items: CompletionItem[] }` | `CompletionProvider` |

**Parameters:**
- `connectionId`: Opaque string returned by `connect`. MUST be passed to all subsequent calls to prevent race conditions when switching connections (a late response from an old connection must not update UI state for a new connection).
- `maxRows`: Default 10,000. Prevents OOM on large result sets. Response `truncated: true` if limit hit.
- `timeoutMs`: Default 30,000ms. Sets PostgreSQL `statement_timeout` for the query. 0 = no timeout.
- `cancel`: Cancels an in-flight query by its JSON-RPC request id.
- `connect`: Receives individual fields (NOT a URL) to prevent credential leakage. `sslMode` enum: `disable | allow | prefer | require | verify-full` (default: `prefer`).
- `cursorId`: Returned in executeSQL/executeNQL when `truncated: true`. Pass to `fetchMore` to retrieve next batch. Cursor expires after 60s of inactivity or on disconnect.
- `fetchMore`: Retrieves the next batch of rows for a truncated result. Uses server-side cursor. Inherits `maxRows` from original query if not overridden.

**Serialization rules:**
- `BigInt` values (e.g. `count(*)`, `bigint` columns) → serialized as strings in JSON (custom `JSON.stringify` replacer in sidecar).
- `bytea` columns → Base64-encoded strings.
- `null` → JSON `null` (not absent key).
- Line endings: the JSON-RPC codec MUST normalize CRLF → LF before parsing (Windows compatibility).

### Sidecar Lifecycle State Machine

```
STOPPED → SPAWNING → HANDSHAKING → READY → RESTARTING → HANDSHAKING → READY
                                      ↑                       │
                                      └───────────────────────┘
```

- **STOPPED/SPAWNING/HANDSHAKING:** All IPC calls are queued (not rejected).
- **READY:** Normal operation, calls dispatched immediately.
- **RESTARTING:** All pending requests are rejected with error code -32001 ("Engine restarting"). New calls are queued until READY.
- Frontend `IpcClient` exposes `status: SidecarStatus` for UI indicators.

### BDD Scenarios

```gherkin
Scenario: Sidecar starts on app launch
  Given the app is starting
  When Tauri initializes
  Then the sidecar process is spawned
  And a version handshake succeeds within 5 seconds

Scenario: Sidecar auto-restarts on crash
  Given the sidecar is running
  When the sidecar process crashes
  Then Tauri detects the crash within 3 seconds
  And spawns a new sidecar process
  And shows a notification "Engine restarted"

Scenario: JSON-RPC request/response
  Given the sidecar is running
  When the frontend sends { method: "introspect", params: {} }
  Then the sidecar responds with the schema data
  And the response includes a matching id

Scenario: Cancel long-running query
  Given a query is executing (e.g., SELECT pg_sleep(60))
  When the user clicks "Cancel" (or presses Escape)
  Then a cancel request is sent with the original request id
  And the query is cancelled via pg_cancel_backend()
  And the results panel shows "Query cancelled"

Scenario: Sidecar restart invalidates pending requests
  Given the sidecar crashes while a query is in-flight
  When the sidecar restarts and completes handshake
  Then the pending query promise is rejected with "Engine restarting"
  And the UI shows a notification "Engine restarted"
  And the connection state is preserved (auto-reconnect)

Scenario: Console output does not corrupt protocol
  Given a dependency logs to console.log
  When the sidecar processes a request
  Then only JSON-RPC messages appear on stdout
  And console output is redirected to stderr
```

### Exit Criteria
- [ ] Sidecar spawns on app start, handshake succeeds
- [ ] `invoke("sidecar_call", { method, params })` works from React
- [ ] Sidecar auto-restarts after simulated crash, pending requests rejected
- [ ] Transport abstraction: `IpcClient.call(method, params)` returns typed result
- [ ] Sidecar state machine: STOPPED → SPAWNING → HANDSHAKING → READY → RESTARTING
- [ ] console.log/warn/info monkey-patched to stderr in sidecar entry
- [ ] Newline-delimited JSON framing (no raw stdout pollution)
- [ ] CRLF normalization in JSON-RPC codec (Windows compat)
- [ ] `connectionId` returned by `connect`, validated on all subsequent calls
- [ ] `cancel` method implemented (sends pg_cancel_backend)
- [ ] BigInt custom serializer (bigint → string in JSON)
- [ ] Vitest: protocol codec tests (serialize/deserialize/error/framing/CRLF)
- [ ] Vitest: transport abstraction tests (mock sidecar)
- [ ] Vitest: state machine transition tests

---

## Block 3 — Connection Manager (GUI-003)

### Goal
Connect to PostgreSQL databases. Save/switch connection profiles. Encrypted password storage.

### Files to create/modify
```
packages/gui/
├── src-tauri/
│   ├── src/lib.rs               # Add stronghold commands
│   └── Cargo.toml               # Add tauri-plugin-stronghold
├── src/
│   ├── components/
│   │   └── connection/
│   │       ├── ConnectionDialog.tsx    # New connection form
│   │       ├── ConnectionList.tsx      # Saved connections sidebar
│   │       └── ConnectionStatus.tsx    # Status bar indicator
│   ├── stores/
│   │   └── connection-store.ts         # Zustand: profiles, active connection
│   └── hooks/
│       └── useConnection.ts            # Connect/disconnect/test logic
```

### Connection Profile Schema

```typescript
type SslMode = 'disable' | 'allow' | 'prefer' | 'require' | 'verify-full';

// App-level (with password in stronghold)
type ConnectionProfile = {
  id: string;           // uuid
  name: string;         // "My Dev DB"
  host: string;
  port: number;         // default 5432
  database: string;
  user: string;
  // password stored separately in stronghold, keyed by id
  // Stronghold MUST use OS keychain integration (macOS Keychain, Windows Hello)
  // for encryption key derivation — NOT a generated key stored on disk (obfuscation ≠ encryption)
  schema: string;       // default "public"
  sslMode: SslMode;     // default "prefer"
  color?: string;       // accent color for visual distinction
};

// Project-level (.dbsp/connections.json — NO passwords)
type ProjectConnection = {
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  schema: string;
  sslMode: SslMode;
};
```

### BDD Scenarios

```gherkin
Scenario: Connect to PostgreSQL
  Given I open the connection dialog
  When I enter a valid connection URL and click "Connect"
  Then the sidecar connects to PostgreSQL
  And the connection status shows "Connected to mydb@localhost"
  And the schema treeview populates

Scenario: Save connection profile
  Given I have a working connection
  When I click "Save Profile"
  Then the profile is stored in app data
  And the password is encrypted in stronghold
  And the profile appears in the connection list

Scenario: Connection failure
  Given I enter an invalid connection URL
  When I click "Connect"
  Then an error toast appears with the PostgreSQL error message
  And the connection status stays "Disconnected"

Scenario: Reconnect from saved profile
  Given I have saved connection profiles
  When I launch the app
  Then the connection list shows my saved profiles
  When I click on a profile
  Then it connects using the stored credentials

Scenario: Project connection override
  Given a .dbsp/connections.json exists in the open folder
  When I view the connection list
  Then project connections appear in a separate section
  And they prompt for password (not stored in project file)

Scenario: Test connection
  Given I fill the connection form
  When I click "Test Connection"
  Then it attempts to connect and shows success/failure
  And does not save the profile

Scenario: Connection drops at runtime
  Given I am connected and working
  When the network drops (VPN disconnect, server restart)
  Then the connection status changes to "Disconnected"
  And a notification "Connection lost" appears
  And in-flight queries are rejected with a clear error
  And a "Reconnect" button is shown
```

### Exit Criteria
- [ ] Connection dialog with host/port/db/user/password/schema/ssl fields
- [ ] Successful connection populates schema (via sidecar `connect` + `introspect`)
- [ ] Failed connection shows error toast
- [ ] Profiles saved to app data, passwords in stronghold (OS keychain-backed encryption)
- [ ] Profile list with connect/edit/delete
- [ ] Project connections loaded from `.dbsp/connections.json` (no password stored)
- [ ] Runtime connection drop detection + "Reconnect" button
- [ ] Vitest: connection store tests
- [ ] Playwright: connect + save profile flow + connection drop recovery

---

## Block 4 — Schema Treeview (GUI-004)

### Goal
Display introspected schema as a navigable tree. Tables → columns (type, PK, FK, nullable) → indexes → constraints.

### Files to create/modify
```
packages/gui/src/
├── components/
│   └── schema/
│       ├── SchemaTree.tsx         # Main tree component
│       ├── TableNode.tsx          # Expandable table item
│       ├── ColumnNode.tsx         # Column with type badge
│       ├── IndexNode.tsx          # Index info
│       ├── SchemaSearch.tsx       # Filter/search input
│       └── icons.tsx              # Type icons (PK, FK, text, int, etc.)
├── stores/
│   └── schema-store.ts           # Zustand: schema data, expanded state
└── hooks/
    └── useSchema.ts              # Introspection trigger + caching
```

### BDD Scenarios

```gherkin
Scenario: Schema loads on connection
  Given I connect to a PostgreSQL database
  When the connection succeeds
  Then the sidebar shows all tables as expandable nodes
  And table count badge shows "N tables"

Scenario: Expand table shows columns
  Given the schema tree is loaded
  When I expand a table node
  Then I see all columns with name, type, and badges (PK, FK, NOT NULL)

Scenario: Search filters tables
  Given the schema tree has 50 tables
  When I type "user" in the search box
  Then only tables matching "user" are shown (users, user_roles, etc.)

Scenario: Large schema performance
  Given a database with 500+ tables
  When the schema tree loads
  Then it renders within 1 second
  And scrolling is smooth (virtual scroll if needed)

Scenario: Auto-generate ModelIR for NQL
  Given the introspection returns IntrospectedModelIR
  When the schema loads
  Then a ModelIR is available for NQL compilation
  And NQL queries can use introspected table/column names
```

### Exit Criteria
- [ ] TreeView shows tables → columns → indexes after introspection
- [ ] Column badges: PK (key icon), FK (link icon), type, nullable
- [ ] Search/filter input
- [ ] Expand/collapse state persisted
- [ ] ModelIR cached in Zustand for NQL compilation
- [ ] Vitest: schema store tests
- [ ] Playwright: tree expand + search flow

---

## Block 5 — Monaco SQL Editor (GUI-005)

### Goal
Monaco editor with PostgreSQL syntax highlighting, tab management, and table/column autocomplete.

### Files to create/modify
```
packages/gui/src/
├── components/
│   ├── editor/
│   │   ├── EditorTabs.tsx         # Tab bar with close/add
│   │   ├── MonacoWrapper.tsx      # Monaco setup + configuration
│   │   ├── SqlEditor.tsx          # SQL-specific editor
│   │   └── EditorToolbar.tsx      # Run button, file actions
│   └── layout/
│       └── EditorPanel.tsx        # Updated: real editor
├── stores/
│   └── editor-store.ts           # Zustand: tabs, active tab, content
├── hooks/
│   ├── useEditor.ts              # Editor lifecycle
│   └── useAutocomplete.ts        # Schema-aware completions
└── lib/
    └── sql-completions.ts         # Completion provider for SQL
```

### BDD Scenarios

```gherkin
Scenario: Open SQL tab and write query
  Given the app is running with a connection
  When I click [+] to create a new tab
  Then a new SQL tab opens with an empty editor
  And PostgreSQL syntax highlighting is active

Scenario: Execute SQL with Cmd+Enter
  Given I have SQL in the editor: SELECT * FROM users LIMIT 10
  When I press Cmd+Enter (or click Run)
  Then the query executes via the sidecar
  And results appear in the results panel below

Scenario: Table/column autocomplete
  Given a schema is loaded with table "users" (id, name, email)
  When I type "SELECT * FROM us" and trigger autocomplete
  Then "users" appears in the suggestion list
  When I accept and type "WHERE users."
  Then column suggestions appear (id, name, email)

Scenario: Open file from filesystem
  Given a .sql file exists at /path/to/query.sql
  When I drag the file onto the editor area (or use File > Open)
  Then a new tab opens with the file content
  And the tab title shows the filename

Scenario: Multiple tabs
  Given I have 3 tabs open
  When I click a tab
  Then its content is displayed
  When I click the X on a tab
  Then it closes (with save prompt if modified)
```

### Exit Criteria
- [ ] Monaco editor renders with PostgreSQL syntax highlighting
- [ ] Tab management: create, close, switch, rename
- [ ] Cmd/Ctrl+Enter executes query via sidecar `executeSQL`
- [ ] Table/column autocomplete from schema store
- [ ] File open via dialog + drag-and-drop
- [ ] Vitest: editor store, autocomplete provider
- [ ] Playwright: write query + execute + see results

---

## Block 6 — Monaco NQL Editor (GUI-006)

### Goal
NQL syntax highlighting via generated TextMate grammar. .dbsp file support with pipe-aware highlighting.

### Files to create/modify
```
packages/gui/
├── scripts/
│   └── generate-nql-grammar.ts    # Chevrotain tokens → .tmLanguage.json
├── src/
│   ├── components/
│   │   └── editor/
│   │       └── NqlEditor.tsx      # NQL-specific editor
│   └── lib/
│       ├── nql-grammar/
│       │   └── nql.tmLanguage.json  # Generated TextMate grammar
│       └── nql-completions.ts       # NQL-specific completions (pipes, keywords)
```

### TextMate Grammar Generation

```
Input: packages/nql/src/lexer.ts (Chevrotain token definitions)
  ↓ scripts/generate-nql-grammar.ts
Output: src/lib/nql-grammar/nql.tmLanguage.json

Token mapping:
  Keywords (Select, Where, Insert, etc.) → keyword.control.nql
  Operators (=, !=, >, <, etc.) → keyword.operator.nql
  Pipe (|) → keyword.operator.pipe.nql
  StringLiteral ('...') → string.quoted.single.nql
  NumberLiteral → constant.numeric.nql
  Identifier → variable.other.nql
  Comments (// or /* */) → comment.nql
```

**Known risks:**
- Chevrotain `longer_alt`/priority semantics don't translate to TextMate — keywords may be swallowed by Identifier. Emit keywords BEFORE Identifier in grammar precedence.
- Some Chevrotain token regexes (lookbehind, unicode classes, custom matchers) may not be Oniguruma-compatible. Maintain a manual override list for incompatible tokens.
- Test: ensure each keyword token highlights distinctly from identifiers.

**Fallback alternative:** If TextMate grammar generation proves too brittle, switch to Monaco's native **Monarch** tokenizer API — simpler to generate from a lexer, no WASM adapter needed, and avoids Oniguruma compatibility issues entirely.

### BDD Scenarios

```gherkin
Scenario: NQL syntax highlighting
  Given I open a .dbsp file
  When I type: users | where status = 'active' | limit 10
  Then keywords (where, limit) are highlighted
  And the pipe operator is visually distinct
  And string 'active' is highlighted as string literal
  And numbers (10) are highlighted as constants

Scenario: NQL compilation on Cmd+Enter
  Given I have NQL in the editor
  When I press Cmd+Enter
  Then the NQL compiles via sidecar `compileNQL`
  And the SQL tab in results shows the compiled SQL
  And the Plan tab shows the PlanReport
  And the Results tab shows query results

Scenario: NQL error highlighting
  Given I type invalid NQL: users | where
  When the editor validates (debounced)
  Then a red squiggly underline appears under "where" (incomplete)
  And the error panel shows "Expected expression after 'where'"

Scenario: .dbsp file association
  Given I open a file with .dbsp extension
  Then the NQL editor activates (not SQL)
  And NQL-specific syntax highlighting is applied
```

### Exit Criteria
- [ ] `generate-nql-grammar.ts` script generates valid .tmLanguage.json
- [ ] Monaco registers NQL language with the generated grammar
- [ ] .dbsp files auto-detected as NQL
- [ ] Cmd/Ctrl+Enter compiles + executes NQL via sidecar
- [ ] Error markers shown for invalid NQL
- [ ] Vitest: grammar generation tests
- [ ] Vitest: NQL completion provider

---

## Block 7 — Results Table (GUI-007)

### Goal
Virtual-scrolling data table for query results with column sort, type-aware display, and CSV export.

### Files to create/modify
```
packages/gui/src/
├── components/
│   └── results/
│       ├── ResultsPanel.tsx       # Updated: real results
│       ├── DataTable.tsx          # TanStack Table wrapper
│       ├── ResultsTabs.tsx        # Results | SQL | Plan | Params tabs
│       ├── CellRenderer.tsx       # Type-aware cell display
│       ├── StatusBar.tsx          # Row count + timing + export
│       └── EmptyState.tsx         # "Run a query to see results"
├── stores/
│   └── results-store.ts          # Zustand: results, active tab, history
├── hooks/
│   └── useResults.ts             # Result management
└── lib/
    └── csv-export.ts             # Export to CSV
```

### Type-Aware Display

| PostgreSQL Type | Display | Notes |
|----------------|---------|-------|
| text, varchar | Plain text (HTML-escaped) | **XSS protection:** all string content MUST be rendered via React text nodes (never raw HTML injection). Database content can contain malicious scripts (stored XSS). |
| integer | Right-aligned number | |
| bigint | Right-aligned string | Serialized as string by sidecar (BigInt breaks `JSON.stringify`). Display as-is, right-aligned. |
| boolean | Checkbox icon | |
| timestamp, date | Formatted date | |
| json, jsonb | Truncated + expandable (escaped) | JSON viewer must also escape all string values before display. |
| bytea | Base64 badge + copy button | Displayed as `[binary N bytes]` with copy-as-Base64 action. |
| null | Grey italic "NULL" | |
| uuid | Monospace, truncated | |
| array types | Formatted array | e.g. `{1,2,3}` → `[1, 2, 3]` |

### BDD Scenarios

```gherkin
Scenario: Display query results
  Given I execute a SQL query
  When the results arrive
  Then the data table shows columns and rows
  And the status bar shows "N rows · X.Xms"

Scenario: Virtual scroll for large results
  Given a query returns 50,000 rows
  When the results display
  Then only visible rows are rendered (virtual scroll)
  And scrolling is smooth at 60fps

Scenario: Column sort
  Given results are displayed
  When I click a column header
  Then rows sort ascending by that column
  When I click again
  Then rows sort descending

Scenario: CSV export
  Given results are displayed
  When I click "Export CSV"
  Then a save dialog opens
  And the CSV file contains all rows with headers

Scenario: Empty state
  Given no query has been executed
  When I look at the results panel
  Then I see "Run a query to see results" placeholder

Scenario: SQL tab shows compiled SQL
  Given I executed an NQL query
  When I click the "SQL" tab in results
  Then I see the compiled SQL with syntax highlighting

Scenario: Large result set truncated
  Given a query would return 100,000 rows
  When the query executes with default maxRows (10,000)
  Then the table shows 10,000 rows
  And the status bar shows "10,000 of 100,000+ rows (truncated)"
  And a "Fetch more" button is visible

Scenario: Fetch more rows via cursor
  Given the previous query was truncated (cursorId returned)
  When I click "Fetch more"
  Then fetchMore is called with the cursorId
  And the next batch of rows is appended to the table
  And the status bar updates with the new row count
  And if all rows are fetched, "Fetch more" disappears

Scenario: Query timeout
  Given a slow query exceeds the timeout (30s default)
  When the timeout triggers
  Then the query is cancelled server-side
  And the results panel shows "Query timed out after 30s"
  And the user can adjust timeout in settings
```

### Exit Criteria
- [ ] TanStack Table renders with virtual scroll
- [ ] Columns sortable (click header)
- [ ] Type-aware cell rendering (dates, booleans, JSON, NULL, bigint-as-string, bytea-as-Base64)
- [ ] XSS-safe rendering: all cell content rendered via React text nodes, no raw HTML injection
- [ ] Status bar: row count + timing + truncation indicator
- [ ] "Fetch more" button when results are truncated (uses cursorId from sidecar)
- [ ] CSV export via save dialog
- [ ] Results/SQL/Plan/Params tab switching
- [ ] Vitest: CSV export, cell renderer, BigInt display, bytea display, XSS escape
- [ ] Playwright: execute query + sort column + export CSV + fetch more

---

## Block 8 — Plan Inspector (GUI-008)

### Goal
Visual PlanReport display: decisions (strategy + reasoning), warnings, CTEs, timing metadata.

### Files to create/modify
```
packages/gui/src/
├── components/
│   └── results/
│       ├── PlanInspector.tsx       # Main plan view
│       ├── DecisionCard.tsx        # Single decision with strategy/reasoning
│       ├── WarningCard.tsx         # Warning with suggestion
│       ├── CteList.tsx            # CTE extraction summary
│       └── PlanMetadata.tsx       # Timing, relations analyzed, root table
```

### PlanReport Visual Mapping

```
PlanReport
├── rootTable → Header: "Plan for: users"
├── metadata
│   ├── planningTimeMs → "Planned in 2.3ms"
│   └── relationsAnalyzed → "4 relations analyzed"
├── decisions[] → Decision Cards
│   ├── type → Badge (filter-strategy, include-strategy, etc.)
│   ├── choice → Primary text (e.g., "EXISTS subquery")
│   ├── reasoning → Secondary text
│   ├── context.sourceTable → Breadcrumb
│   └── alternatives → Collapsed "Also considered: JOIN, CTE"
├── warnings[] → Warning Cards
│   ├── message → Warning text
│   └── suggestion → "Consider: ..."
└── ctes[] → CTE List
    ├── name → CTE name
    └── (count) → "3 CTEs extracted"
```

### BDD Scenarios

```gherkin
Scenario: Display plan for NQL query
  Given I execute an NQL query
  When I click the "Plan" tab
  Then I see the root table name
  And decision cards for each planner decision
  And each card shows strategy, reasoning, and alternatives

Scenario: Warnings displayed prominently
  Given the plan has warnings
  When I view the plan
  Then warnings appear in yellow/orange cards at the top
  And each warning has a suggestion

Scenario: CTE extraction visible
  Given the plan extracted CTEs
  When I view the plan
  Then I see "N CTEs extracted" with their names

Scenario: No plan for raw SQL
  Given I execute a raw SQL query (not NQL)
  When I click the "Plan" tab
  Then I see "Plan only available for NQL queries"
```

### Exit Criteria
- [ ] PlanReport renders with decision cards
- [ ] Each decision shows type badge, choice, reasoning, alternatives
- [ ] Warnings display with message + suggestion
- [ ] CTE list with names
- [ ] Metadata: planning time, relations analyzed, root table
- [ ] Graceful fallback for raw SQL (no plan)
- [ ] Vitest: plan inspector component tests

---

## Block 9 — Distribution (GUI-009)

### Goal
Build and package the app for Windows/macOS/Linux. CI pipeline with GitHub Actions.

### Files to create/modify
```
packages/gui/
├── src-tauri/
│   └── tauri.conf.json          # Update: bundle config, signing, updater
├── .github/
│   └── workflows/
│       └── gui-release.yml      # CI: build + publish on tag
└── scripts/
    └── build-sidecar.sh         # Build Node.js SEA for all platforms
```

### Build Pipeline

```
1. Build sidecar (Node.js SEA) — PER-OS (matrix strategy)
   └── esbuild bundle → single .cjs
   └── node --experimental-sea-config → sidecar binary
   └── Each OS runner builds its own binary:
       ├── ubuntu-latest  → dbsp-sidecar (Linux x86_64)
       ├── windows-latest → dbsp-sidecar.exe (Windows x86_64)
       └── macos-latest   → dbsp-sidecar (macOS aarch64)
   └── macOS: sidecar must be code-signed before bundling (Gatekeeper)
   └── Windows: sidecar must be signed (antivirus false positives)

2. Build GUI (Tauri) — PER-OS (same matrix)
   └── pnpm -C packages/gui build (Vite → dist/)
   └── cargo tauri build (Rust + webview + sidecar bundle)
   └── Outputs: .msi (Windows), .dmg (macOS), .deb/.AppImage (Linux)

3. Publish (GitHub Actions)
   └── Create GitHub Release
   └── Upload all platform artifacts
   └── Tauri updater endpoint (signature-verified)
```

**Cross-platform notes:**
- Node.js SEA requires the target platform's Node binary — cannot cross-compile from Linux
- GitHub Actions matrix: `[ubuntu-latest, windows-latest, macos-latest]`
- macOS hardened runtime entitlements must allow child process execution
- macOS: sidecar must be code-signed and notarized as part of the app bundle, or Gatekeeper blocks execution. SEA blob injection must happen BEFORE signing.
- Windows: unsigned SEA binaries often trigger antivirus false positives — signing is mandatory for distribution.
- Linux: build on oldest supported glibc for broad compatibility (AppImage recommended).
- **Fail-fast:** Validate a skeleton SEA build in Block 2 (sidecar) to detect cross-platform packaging issues early, before investing in UI blocks.

### BDD Scenarios

```gherkin
Scenario: Build produces installer
  Given the source code is clean
  When I run the build script
  Then platform-appropriate installer is produced
  And the installer includes the sidecar binary
  And the installed app launches without requiring Node.js

Scenario: Auto-update check
  Given the app is installed
  When a new version is available on GitHub Releases
  Then the app shows an update notification
  And the user can update in-place
```

### Exit Criteria
- [ ] `pnpm -C packages/gui tauri build` produces installer
- [ ] Installer includes sidecar binary (no Node.js required on user machine)
- [ ] GitHub Actions workflow builds for Windows/macOS/Linux
- [ ] Auto-updater configured with GitHub Releases endpoint
- [ ] Pin Node.js version for reproducible SEA builds

---

## Test Strategy

### Unit Tests (Vitest)

| Scope | Files | What to test |
|-------|-------|-------------|
| Stores | `*-store.test.ts` | Zustand state logic, actions, selectors |
| Hooks | `use*.test.ts` | IPC calls, connection logic, schema loading |
| IPC | `ipc.test.ts`, `protocol.test.ts` | JSON-RPC codec, transport abstraction |
| Components | `*.test.tsx` | Cell renderer, plan inspector, CSV export |
| Grammar | `generate-nql-grammar.test.ts` | Token → scope mapping |

### E2E Tests (Playwright)

| Flow | What to test |
|------|-------------|
| Connect + Explore | Open app → connect → expand schema tree → verify tables |
| SQL Query | Connect → write SQL → execute → verify results |
| NQL Query | Connect → write NQL → execute → verify plan + results |
| File Open | Drag .dbsp file → verify content + syntax highlighting |
| Connection Profiles | Save → close → reopen → reconnect |

---

## Glossary

| Term | Definition |
|------|------------|
| SEA | Single Executable Application (Node.js) |
| Sidecar | External process managed by Tauri, communicates via JSON-RPC |
| Stronghold | Tauri plugin for encrypted secret storage |
| ModelIR | Internal schema representation used by the planner |
| PlanReport | Query plan output with decisions, warnings, CTEs |
| TextMate grammar | Syntax highlighting definition for Monaco Editor |
