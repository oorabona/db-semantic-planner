---
doc-meta:
  status: canonical
  scope: gui
  type: architecture
  created: 2026-02-26
  updated: 2026-02-26
---

# GUI Persistence Architecture

Reference document for all data storage in the DBSP desktop application.

## Overview

The app uses a 5-layer persistence model. Each layer serves a different scope and lifecycle.

```
dbsp.settings.json              ← Project config (checked into VCS)
~/.config/dbsp/
├── app.sqlite                  ← App-wide (recent projects, app logs)
└── projects/{folderName}/
    └── data.sqlite             ← Per-project (profiles, history, IPC logs)
log-db (data.sqlite logs table) ← Verbose app logging
localStorage                    ← User preferences (theme, editor, retention)
```

## Layer 1: Project Settings (`dbsp.settings.json`)

**Location:** `$PROJECT_ROOT/dbsp.settings.json`
**Lifecycle:** Created by New Project Wizard, updated by file add/remove/rename operations.
**VCS:** Intended to be committed (no secrets — passwords use URI references).

### Schema

```typescript
interface DbspSettings {
  readonly $schema?: string;
  readonly version: 1;                              // SEC-04: required, gates future migrations
  readonly connections?: readonly DbspConnectionRef[];
  readonly defaultConnection?: string;              // ID of the default connection
  readonly project?: DbspProjectSettings;
  readonly editor?: DbspEditorSettings;
}

interface DbspConnectionRef {
  readonly name: string;
  readonly profile: string;       // URI: file://.env.local, env://PG_URL, store://keychain
  readonly defaultSchema?: string;
  readonly readOnly?: boolean;
}

interface DbspProjectSettings {
  readonly name?: string;
  readonly schemaPath?: string | 'auto';  // Path to schema.ts, or 'auto' for auto-detection
  readonly files?: readonly string[];     // Explicit file list (GUI-025: replaces include/exclude)
  readonly roots?: readonly string[];     // Multi-root workspace directories
}

interface DbspEditorSettings {
  readonly tabSize?: number;
  readonly formatOnSave?: boolean;
  readonly maxResults?: number;
}
```

### Operations

| Function | File | Description |
|----------|------|-------------|
| `readSettings(folderPath)` | `src/lib/settings.ts` | Parse + validate from disk, returns `null` if missing |
| `writeSettings(folderPath, settings)` | `src/lib/settings.ts` | JSON.stringify with 2-space indent |
| `validateSettings(raw)` | `src/lib/settings.ts` | Version gate + type validation |
| `mergeConnectionIntoSettings()` | `src/lib/settings.ts` | Add connection ref to existing settings |
| `removeConnectionFromSettings()` | `src/lib/settings.ts` | Remove connection ref by name |

### Connection Profile URIs

| Scheme | Example | Resolution |
|--------|---------|------------|
| `file://` | `file://.env.local` | Read password from dotenv file relative to project root |
| `env://` | `env://PG_PASSWORD` | Read from environment variable |
| `store://` | `store://keychain` | (Planned) OS keychain via Tauri plugin-store |

### Validation Rules

- `version` field is **required** and must equal `1`
- Unknown fields are tolerated (forward compatibility)
- `connections[].profile` must match a known URI scheme
- `project.files[]` paths are relative to project root

---

## Layer 2: App-level SQLite (`app.sqlite`)

**Location:** `$APPCONFIG/app.sqlite` (Linux: `~/.config/dbsp/`, macOS: `~/Library/Application Support/`)
**Lifecycle:** Created at first app launch, persists across all projects.
**Source:** `src/lib/app-db.ts`

### Tables

#### `_meta`

Schema versioning for the app database.

```sql
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
```

#### `recent_projects`

Project history for the "Open Recent" menu.

```sql
CREATE TABLE IF NOT EXISTS recent_projects (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  last_opened_at INTEGER NOT NULL,   -- Unix timestamp ms
  created_at INTEGER NOT NULL        -- Unix timestamp ms
)
```

#### `app_logs`

Application-level logs (startup, sidecar lifecycle, errors).

```sql
CREATE TABLE IF NOT EXISTS app_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  level TEXT NOT NULL,          -- 'debug' | 'info' | 'warn' | 'error'
  source TEXT NOT NULL,         -- e.g. 'app', 'sidecar'
  message TEXT NOT NULL,
  duration_ms INTEGER
)
CREATE INDEX IF NOT EXISTS idx_app_logs_ts ON app_logs(timestamp)
```

### Key Operations

| Function | Description |
|----------|-------------|
| `initAppDb()` | Create tables, run migrations |
| `addRecentProject(path, name, folderName)` | Upsert into recent_projects |
| `getRecentProjects(limit)` | List recent projects ordered by last_opened_at DESC |
| `removeRecentProject(path)` | Delete from recent_projects |
| `insertAppLog(level, source, message)` | Append log entry |
| `queryAppLogs(opts)` | Paginated query with level/source filter |
| `clearAppLogs()` | Delete all app logs |
| `rotateAppLogs(retentionDays)` | Delete logs older than retention threshold |

---

## Layer 3: Project-level SQLite (`data.sqlite`)

**Location:** `$APPCONFIG/projects/{folderName}/data.sqlite` (project mode) or `$APPCONFIG/default/data.sqlite` (standalone mode)
**Lifecycle:** Created when a project folder is opened or on standalone app startup.
**Source:** `src/lib/project-db.ts`

### Tables

#### `_meta`

Per-project schema versioning.

```sql
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)
```

#### `connection_profiles`

Saved database connection configurations (no plaintext passwords).

```sql
CREATE TABLE IF NOT EXISTS connection_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  environment TEXT,                    -- 'dev' | 'staging' | 'prod' | custom
  type TEXT NOT NULL DEFAULT 'postgresql',  -- DatabaseType
  config TEXT NOT NULL,                -- JSON blob: host, port, database, user, schema, sslMode
  color TEXT,                          -- Profile color tag
  created_at INTEGER NOT NULL,         -- Unix timestamp ms
  last_used_at INTEGER                 -- Unix timestamp ms, nullable
)
```

**Note:** The `config` JSON blob contains connection parameters **without passwords**. Passwords are resolved at connect-time via the profile URI in `dbsp.settings.json`.

#### `query_history`

Execution history for SQL and NQL queries.

```sql
CREATE TABLE IF NOT EXISTS query_history (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  language TEXT NOT NULL,             -- 'sql' | 'nql'
  database TEXT,
  connection_id TEXT,
  timestamp INTEGER NOT NULL,        -- Unix timestamp ms
  duration_ms INTEGER,
  row_count INTEGER,
  success INTEGER NOT NULL DEFAULT 1,
  error TEXT
)
CREATE INDEX IF NOT EXISTS idx_history_ts ON query_history(timestamp)
CREATE INDEX IF NOT EXISTS idx_history_lang ON query_history(language, timestamp)
```

**Retention:** 90 days by default (configurable via `historyRetentionDays` in user settings). Rotation runs on `initDb()`.

#### `ipc_logs`

JSON-RPC communication logs between GUI and sidecar engine.

```sql
CREATE TABLE IF NOT EXISTS ipc_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,           -- 'gui→sidecar' | 'sidecar→gui'
  message TEXT NOT NULL,          -- Auto-redacted: password/secret/token/credential/auth patterns
  duration_ms INTEGER,
  method TEXT,                    -- JSON-RPC method name
  connection_id TEXT
)
CREATE INDEX IF NOT EXISTS idx_ipc_ts ON ipc_logs(timestamp)
```

**Retention:** 7 days by default. Rotation runs on `initDb()`.
**Security:** Passwords in IPC messages are automatically redacted before storage.

### Key Operations

| Function | Description |
|----------|-------------|
| `openProjectDb(folderName)` | Open or create project database |
| `addProfile(profile)` | Insert connection profile |
| `updateProfile(id, partial)` | Update profile fields |
| `removeProfile(id)` | Delete profile by ID |
| `getProfiles()` | List all profiles |
| `addHistoryEntry(entry)` | Insert query execution record |
| `queryHistory(opts)` | Paginated, filterable history query |
| `insertIpcLog(entry)` | Append IPC log (fire-and-forget) |
| `rotateHistory(retentionDays)` | Delete entries older than threshold |
| `rotateIpcLogs(retentionDays)` | Delete IPC logs older than threshold |

---

## Layer 4: User Preferences (localStorage)

**Storage key:** `dbsp-user-settings` (via Zustand `persist` middleware)
**Lifecycle:** Created on first app launch with defaults, updated immediately on change.
**Source:** `src/stores/user-settings-store.ts`

### Persisted Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `language` | `'en' \| 'fr'` | `'en'` | UI language |
| `theme` | `'system' \| 'light' \| 'dark'` | `'system'` | Color theme |
| `autoUpdates` | `boolean` | `true` | Auto-check for updates |
| `tabSize` | `number` | `2` | Editor tab size (project settings override) |
| `formatOnSave` | `boolean` | `false` | Auto-format (project settings override) |
| `maxResults` | `number` | `500` | Max result rows (project settings override) |
| `logRetentionDays` | `number` | `30` | App/IPC log retention |
| `historyRetentionDays` | `number` | `90` | Query history retention |
| `fileWatcherMode` | `'auto' \| 'prompt'` | `'auto'` | File watcher behavior |

### Non-persisted (UI state only)

| Field | Type | Description |
|-------|------|-------------|
| `activeSection` | `PreferencesSection` | Active tab in preferences dialog |
| `dialogOpen` | `boolean` | Whether preferences dialog is open |

### Settings Precedence

```
Defaults → dbsp.settings.json (project) → User settings (global)
```

Project-level `editor.*` overrides take priority for `tabSize`, `formatOnSave`, `maxResults`.

---

## Layer 5: Tauri plugin-store (planned)

**Status:** Plugin installed (`@tauri-apps/plugin-store ^2.4.2`) but **not currently active**.
**Intended use:** Secure password storage via OS keychain, resolving `store://` profile URIs.
**Current workaround:** Passwords provided at connect-time (from wizard form or user input). No persistent password storage yet.

---

## Database Initialization Flow

```
App startup
├── initAppDb()                          → app.sqlite (tables + rotation)
├── Zustand persist rehydrate            → localStorage user settings
└── openFolder(path) or standalone init
    └── openProjectDb(folderName)        → data.sqlite (tables + rotation)
        ├── rotateHistory(retentionDays)
        └── rotateIpcLogs(7)
```

### Corruption Recovery

`openDatabaseSafe()` in `src/lib/db-shared.ts` handles SQLite corruption:
1. Attempt normal open + `SELECT 1` integrity check
2. On failure: call `onCorrupt` callback (for logging), then attempt fresh open
3. If both fail: propagate error

---

## Security Considerations

| Concern | Mitigation |
|---------|------------|
| No plaintext passwords on disk | Passwords resolved at connect-time via URI scheme (file/env/store) |
| IPC log redaction | Automatic regex masking of `password`, `secret`, `token`, `credential`, `auth` |
| Settings validation | Version gate (SEC-04), strict type validation on read |
| SQLite injection | Parameterized queries throughout (`?` placeholders) |
| VCS safety | `dbsp.settings.json` contains no secrets — safe to commit |

---

## Store-to-Storage Mapping

| Zustand Store | Primary Storage | What It Stores |
|---------------|-----------------|----------------|
| `useProjectStore` | `dbsp.settings.json` + `app.sqlite` | Project config, recent projects list |
| `useConnectionStore` | `data.sqlite` (connection_profiles) | Saved connection profiles |
| `useHistoryStore` | `data.sqlite` (query_history) | Query execution history |
| `useLogStore` | `app.sqlite` (app_logs) + `data.sqlite` (ipc_logs) | Dual-backend logging |
| `useUserSettingsStore` | `localStorage` | Theme, editor prefs, retention settings |
| `useEditorStore` | In-memory only | Open tabs, active tab, tab content |
| `useSchemaStore` | In-memory only | Introspected schema tree |
| `useResultsStore` | In-memory only | Query results, plan reports |
| `useSidecarStore` | In-memory only | Sidecar process state |
| `useSchemaDiffStore` | In-memory only | Schema comparison results |
| `useAssertionStore` | In-memory only | Assertion runner state |
