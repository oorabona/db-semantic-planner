---
doc-meta:
  status: canonical
  scope: gui
  type: specification
  created: 2026-02-13
  updated: 2026-02-13
  complexity: COMPLEX
  time-budget: 3h
---

# Specification: GUI-MW — Menu + Workspace + Settings

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | packages/gui (React + Tauri Rust) |
| Complexity | COMPLEX |
| Time budget | ~3h |
| Blocks | 8 |
| BDD scenarios | 28 |
| Risk level | MEDIUM |
| Adversarial | 5/5 perspectives, 10 challenges resolved |
| Brief | docs/briefs/gui-menu-workspace.md |

## 1. Problem Statement

The GUI MVP lacks global entry points (no menu bar), file persistence (.dbsp tabs are in-memory only), and a project concept linking files, connections, and editor settings. Users expect standard desktop UX (File > Open, Cmd+S, Cmd+K palette) and a way to share project configuration between CLI and GUI via a common `dbsp.settings.json` format.

## 2. User Stories

### US-1: Desktop Menu & Shortcuts
**AS A** dbsp developer
**I WANT** a native menu bar with standard keyboard shortcuts
**SO THAT** I can access all app features through familiar desktop conventions

**ACCEPTANCE:** Menu bar visible on all platforms, all shortcuts functional, Edit menu wires to Monaco

### US-2: Command Palette
**AS A** power user
**I WANT** a Cmd+K command palette with file search and command access
**SO THAT** I can navigate and execute actions without leaving the keyboard

**ACCEPTANCE:** Cmd+K opens palette, typing filters files, `>` prefix filters commands

### US-3: File-Backed Editing
**AS A** developer writing NQL queries
**I WANT** to open and save .dbsp files from disk
**SO THAT** my queries persist between sessions and can be version-controlled

**ACCEPTANCE:** File > Open opens .dbsp, File > Save writes to disk, tab shows filename

### US-4: Project Workspace
**AS A** team member sharing a dbsp project
**I WANT** a project folder with dbsp.settings.json that configures connections and schema
**SO THAT** the team shares one config file (committed to git) without exposing credentials

**ACCEPTANCE:** Open Folder detects settings, File Tree appears, URI profiles resolve credentials

### US-5: Preferences
**AS A** developer customizing my environment
**I WANT** a Preferences dialog to manage editor settings and connection profiles
**SO THAT** I can configure the app without editing JSON manually

**ACCEPTANCE:** Cmd+, opens modal, 4 sections, changes persist to correct store

## 3. Business Rules

### 3.1 Invariants (always true)

- **INV-01:** Credentials MUST NEVER appear in `dbsp.settings.json`. Only URI profile references.
- **INV-02:** Menu and command palette MUST expose the same actions (shared command registry).
- **INV-03:** The app MUST work without `dbsp.settings.json` (standalone mode = default).
- **INV-04:** File-backed tabs MUST show a dirty indicator (•) when modified.
- **INV-05:** Project settings (dbsp.settings.json) are committed to git. User settings (theme, window) are local only.

### 3.2 Preconditions (required before action)

- **PRE-01:** File > Save requires a file-backed tab (has filePath). Otherwise → Save As.
- **PRE-02:** Project mode requires a folder open with `dbsp.settings.json` detected.
- **PRE-03:** URI profile resolution requires the sidecar running (for file:// and env:// parsing in Node.js context).
- **PRE-04:** store:// profiles require Tauri secure store plugin initialized.

### 3.3 Effects (what changes)

- **EFF-01:** File > Open Folder → if `dbsp.settings.json` found, sidebar adds File Tree section below Schema Tree.
- **EFF-02:** File > Save As → writes file, sets tab.filePath, sets tab.dirty=false, updates tab title to filename.
- **EFF-03:** Creating `dbsp.settings.json` → transitions from standalone to project mode (File Tree appears).
- **EFF-04:** Preferences > Databases changes → written to `dbsp.settings.json` connections[] if in project mode, or to Tauri AppData if standalone.

### 3.4 Error Handling

- **ERR-01:** Malformed dbsp.settings.json → toast with parse error, remain in standalone mode.
- **ERR-02:** URI resolution fails (missing .env, undefined env var, missing store entry) → warning in Preferences Databases section, connection profile shows error state.
- **ERR-03:** File save fails (permission denied, disk full) → error toast, tab stays dirty.
- **ERR-04:** File changed externally → non-blocking notification: "File changed on disk. [Reload] [Ignore]".
- **ERR-05:** Close tab with unsaved changes → confirm: "Save changes to X?" [Save] [Don't Save] [Cancel].
- **ERR-06:** Invalid glob in project.include/exclude → log warning, fall back to defaults.
- **ERR-07:** File deleted while tab is open → tab stays open, marked "deleted from disk", Save creates new file.

### 3.5 Security Constraints (from /adversarial)

- **SEC-01:** file:// URI resolver MUST restrict paths to project folder. Implementation: `path.resolve(projectRoot, relativePath)` then verify `resolvedPath.startsWith(projectRoot)`. Reject absolute paths, `..` traversal, and symlink escape.
- **SEC-02:** Tauri fs plugin scope MUST be limited to project folder + dialog-selected paths. Never `**` global scope.
- **SEC-03:** .env parser MUST extract only the target key (DATABASE_URL). Full file content MUST NOT be stored in memory. Parsed .env data MUST NOT be cached or logged.
- **SEC-04:** dbsp.settings.json MUST include `"version": 1` for future schema migration support.
- **SEC-05:** Resolved connection params (passwords, tokens) MUST NEVER be logged, written to dbsp.settings.json, or serialized in error toasts. Redact sensitive fields in all UI and log output.

### 3.6 Performance Constraints (from /adversarial)

- **PERF-01:** File tree: scan top-level only on Open Folder. Expand subdirectories on click (read on demand).
- **PERF-02:** Never enter excluded directories (don't stat, don't scan).
- **PERF-03:** Settings: read once on project open, cache in project-store. File watcher invalidates cache.

## 4. Technical Design

### 4.1 Architecture (5 Layers)

```
Layer 1: Native Menu (Tauri Rust)
  → menu! macro in lib.rs, emits events to frontend
Layer 2: Command Registry (React)
  → Map<string, Command>, source of truth for actions
Layer 3: Command Palette (cmdk React)
  → Reads from registry, fuzzy file search + > commands
Layer 4: Project Mode (dbsp.settings.json)
  → Settings reader/writer, project-store (Zustand)
Layer 5: Profile URI Resolver (sidecar + frontend)
  → file://, env://, store:// → ConnectionParams
```

### 4.2 Tauri Plugin Additions

| Plugin | Crate | JS Package | Purpose |
|--------|-------|------------|---------|
| dialog | tauri-plugin-dialog | @tauri-apps/plugin-dialog | File open/save dialogs |
| fs | tauri-plugin-fs | @tauri-apps/plugin-fs | Read/write/watch files |
| store | tauri-plugin-store | @tauri-apps/plugin-store | Secure credential storage |

### 4.3 New Files

| File | Purpose |
|------|---------|
| `src/lib/commands.ts` | Command registry (Map<id, Command>) |
| `src/components/palette/CommandPalette.tsx` | cmdk-based palette UI |
| `src/stores/project-store.ts` | Project state (folder, settings, mode) |
| `src/lib/settings.ts` | dbsp.settings.json reader/writer/validator |
| `src/lib/profile-resolver.ts` | URI profile resolution pipeline |
| `src/components/schema/FileTree.tsx` | Project file tree (.dbsp/.assert.dbsp) |
| `src/components/preferences/PreferencesDialog.tsx` | Preferences modal |
| `src/components/preferences/GeneralSection.tsx` | General prefs section |
| `src/components/preferences/EditorSection.tsx` | Editor prefs section |
| `src/components/preferences/DatabasesSection.tsx` | Database profiles section |
| `src/components/preferences/AdvancedSection.tsx` | Advanced prefs section |
| `src/stores/user-settings-store.ts` | Local user settings (theme, window) |

### 4.4 Modified Files

| File | Changes |
|------|---------|
| `src-tauri/Cargo.toml` | Add plugin dependencies |
| `src-tauri/src/lib.rs` | Add menu builder, register plugins |
| `src-tauri/tauri.conf.json` | Add plugin permissions |
| `src/App.tsx` | Wire menu events, add palette + preferences |
| `src/stores/editor-store.ts` | Add setFilePath action, file-aware close |
| `src/components/layout/Sidebar.tsx` | Add File Tree section (project mode) |

### 4.5 dbsp.settings.json Schema

```typescript
interface DbspSettings {
  $schema?: string;
  version: 1;                  // required, for future schema migration (SEC-04)
  connections?: Array<{
    name: string;
    profile: string;           // URI: file://, env://, store://
    defaultSchema?: string;
    readOnly?: boolean;
  }>;
  defaultConnection?: string;
  project?: {
    schemaPath?: string | 'auto'; // path to schema.ts or auto-detect (renamed from 'schema' to avoid SQL schema confusion)
    include?: string[];           // default: ["**/*.dbsp", "**/*.assert.dbsp"]
    exclude?: string[];           // default: ["node_modules", "dist", ".git"]
  };
  editor?: {
    tabSize?: number;             // default: 2
    formatOnSave?: boolean;       // default: false
    maxResults?: number;          // default: 1000
  };
}
```

### 4.6 Profile URI Resolution

```
"file://.env.local" → sidecar reads .env.local, parses DATABASE_URL
  → { host, port, database, user, password, schema?, sslMode? }

"env://DATABASE_URL" → sidecar reads process.env.DATABASE_URL
  → parse postgres:// URL → ConnectionParams

"store://dev-local" → frontend reads Tauri secure store key "profile:dev-local"
  → { host, port, database, user, password, schema?, sslMode? }
```

Resolution happens:
- **file:// and env://**: In the sidecar (Node.js has fs + env access). New IPC method: `resolveProfile(uri: string) → ConnectionParams`.
- **store://**: In the frontend (Tauri store plugin is a JS API). Resolved before calling sidecar.

### 4.7 Command Registry Schema

```typescript
interface Command {
  id: string;              // e.g. "file.save", "connection.new"
  label: string;           // Display label
  shortcut?: string;       // e.g. "mod+s" (mod = Cmd on mac, Ctrl on win/linux)
  icon?: ComponentType;    // Lucide icon component
  handler: () => void;     // Execution function
  when?: () => boolean;    // Conditional availability
  category: 'file' | 'edit' | 'view' | 'connection' | 'help';
}
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: Native Menu

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Menu bar is visible
  Given the app has started
  When the main window renders
  Then a native menu bar is visible with File, Edit, View, Connection, Help menus

@priority:high @type:nominal
Scenario: SC-02 Menu item triggers action
  Given the app is running with an editor tab open
  When user clicks File > Save As (or presses Cmd+Shift+S)
  Then the native Save As file dialog opens

@priority:medium @type:edge
Scenario: SC-03 Menu items disabled when not applicable
  Given no editor tab is open
  When user opens the File menu
  Then "Save" and "Save As" are disabled (grayed out)
```

### Scenario Group: Command Palette

```gherkin
@priority:high @type:nominal
Scenario: SC-04 Open palette with Cmd+K
  Given the app is running
  When user presses Cmd+K
  Then the command palette overlay appears with a search input

@priority:high @type:nominal
Scenario: SC-05 File search mode (default)
  Given the palette is open in a project with users.dbsp and reports.dbsp
  When user types "user"
  Then "users.dbsp" appears in results as a fuzzy match

@priority:high @type:nominal
Scenario: SC-06 Command mode with > prefix
  Given the palette is open
  When user types ">save"
  Then "File: Save" and "File: Save As" appear as command results

@priority:medium @type:edge
Scenario: SC-07 Palette in standalone mode
  Given the app is in standalone mode (no project folder)
  When user opens palette and types a filename
  Then no file results appear (only commands via > prefix)

@priority:medium @type:nominal
Scenario: SC-08 Execute command from palette
  Given the palette shows "View: Toggle Sidebar"
  When user selects it (click or Enter)
  Then the sidebar toggles visibility and palette closes
```

### Scenario Group: File I/O

```gherkin
@priority:high @type:nominal
Scenario: SC-09 Open a .dbsp file
  Given the app is running
  When user does File > Open and selects "queries/users.dbsp"
  Then a new tab opens with the file content, title "users.dbsp", language "nql"

@priority:high @type:nominal
Scenario: SC-10 Save As creates a file
  Given an in-memory tab with NQL content
  When user does File > Save As and chooses "queries/new.dbsp"
  Then the file is written to disk, tab.filePath is set, tab.dirty becomes false, title becomes "new.dbsp"

@priority:high @type:nominal
Scenario: SC-11 Save overwrites existing file
  Given a file-backed tab (filePath = "queries/users.dbsp") with dirty=true
  When user presses Cmd+S
  Then content is written to "queries/users.dbsp" and dirty becomes false

@priority:high @type:error
Scenario: SC-12 Close tab with unsaved changes
  Given a tab with dirty=true
  When user closes the tab
  Then a confirm dialog appears: "Save changes to X?" with [Save] [Don't Save] [Cancel]

@priority:medium @type:error
Scenario: SC-13 Save fails with permission denied
  Given a file-backed tab
  When save fails due to permission error
  Then an error toast appears and tab remains dirty

@priority:medium @type:edge
Scenario: SC-14 External file modification
  Given a file-backed tab for "users.dbsp" is open
  When the file is modified by an external editor
  Then a notification bar appears: "File changed on disk. [Reload] [Ignore]"
```

### Scenario Group: Project Mode & Settings

```gherkin
@priority:high @type:nominal
Scenario: SC-15 Open folder with dbsp.settings.json
  Given a folder exists with a valid dbsp.settings.json
  When user does File > Open Folder and selects it
  Then the app enters project mode: sidebar shows "Files" section with .dbsp files

@priority:high @type:nominal
Scenario: SC-16 Settings auto-detect schema
  Given dbsp.settings.json has "project": { "schemaPath": "auto" }
  And src/schema.ts exists in the project folder
  Then the schema path resolves to "src/schema.ts"

@priority:high @type:edge
Scenario: SC-17 Open folder without settings (standalone)
  Given a folder has .dbsp files but no dbsp.settings.json
  When user opens the folder
  Then the folder opens in standalone mode (no File Tree, but file Save As works)

@priority:medium @type:nominal
Scenario: SC-18 Progressive transition to project
  Given the app is in standalone mode with a folder open
  When user does an action requiring project mode (e.g., Save)
  Then GUI offers: "Create a dbsp project in this folder?" with [Create] [Not now]

@priority:medium @type:error
Scenario: SC-19 Malformed dbsp.settings.json
  Given a folder has a dbsp.settings.json with invalid JSON
  When user opens the folder
  Then a toast shows the parse error and app remains in standalone mode
```

### Scenario Group: Profile URI Resolution

```gherkin
@priority:high @type:nominal
Scenario: SC-20 Resolve file:// profile
  Given dbsp.settings.json has connections: [{ name: "dev", profile: "file://.env.local" }]
  And .env.local contains DATABASE_URL=postgresql://user:pass@localhost:5432/mydb
  When the profile is resolved
  Then connection params are { host: "localhost", port: 5432, database: "mydb", user: "user", password: "pass" }

@priority:high @type:nominal
Scenario: SC-21 Resolve store:// profile
  Given a connection with profile "store://dev-local"
  And Tauri secure store has key "profile:dev-local" with connection params
  When the profile is resolved
  Then the stored connection params are returned

@priority:medium @type:error
Scenario: SC-22 Resolve fails for missing .env
  Given profile "file://.env.staging" but .env.staging does not exist
  When resolution is attempted
  Then an error is returned: "File not found: .env.staging"
```

### Scenario Group: Preferences

```gherkin
@priority:high @type:nominal
Scenario: SC-23 Open preferences dialog
  Given the app is running
  When user presses Cmd+, (or Edit > Preferences)
  Then a modal dialog opens with sidebar: General, Editor, Databases, Advanced

@priority:high @type:nominal
Scenario: SC-24 Manage connection profiles
  Given the Databases section is open in project mode
  When user adds a new connection profile
  Then the profile is added to dbsp.settings.json connections[] array
```

### Scenario Group: Lifecycle & Sync (from /llm --spec)

```gherkin
@priority:high @type:error
Scenario: SC-25 App quit with unsaved changes
  Given multiple tabs are open with dirty=true
  When user presses Cmd+Q (or closes the window)
  Then the app intercepts CloseRequested and prompts "Save changes?" for each dirty tab
  And user can Save All, Discard All, or Cancel quit

@priority:medium @type:edge
Scenario: SC-26 Focus existing tab on duplicate open
  Given "users.dbsp" is already open in a tab
  When user does File > Open and selects the same file
  Then the existing tab is focused (no duplicate tab created)

@priority:medium @type:edge
Scenario: SC-27 External settings file creation/deletion
  Given a folder is open in standalone mode (no dbsp.settings.json)
  When dbsp.settings.json is created externally (e.g., git pull)
  Then the app detects it via file watcher and transitions to project mode

@priority:medium @type:edge
Scenario: SC-28 External settings file deletion
  Given the app is in project mode with dbsp.settings.json
  When dbsp.settings.json is deleted externally
  Then the app transitions back to standalone mode with a notification
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 Menu visible | ✓ | | | |
| SC-02 Menu action | ✓ | | | |
| SC-03 Disabled items | | ✓ | | |
| SC-04 Open palette | ✓ | | | |
| SC-05 File search | ✓ | | | |
| SC-06 Command mode | ✓ | | | |
| SC-07 Palette standalone | | ✓ | | |
| SC-08 Execute command | ✓ | | | |
| SC-09 Open file | ✓ | | | |
| SC-10 Save As | ✓ | | | |
| SC-11 Save overwrite | ✓ | | | |
| SC-12 Close unsaved | | | ✓ | |
| SC-13 Save fails | | | ✓ | |
| SC-14 External modify | | ✓ | | |
| SC-15 Open project | ✓ | | | |
| SC-16 Auto-detect schema | ✓ | | | |
| SC-17 No settings | | ✓ | | |
| SC-18 Progressive transition | ✓ | | | |
| SC-19 Malformed settings | | | ✓ | |
| SC-20 file:// resolve | ✓ | | | |
| SC-21 store:// resolve | ✓ | | | |
| SC-22 Missing .env | | | ✓ | |
| SC-23 Open preferences | ✓ | | | |
| SC-24 Manage profiles | ✓ | | | |
| SC-25 App quit unsaved | | | ✓ | |
| SC-26 Duplicate file focus | | ✓ | | |
| SC-27 External settings created | | ✓ | | |
| SC-28 External settings deleted | | ✓ | | |
| **Totals** | **13** | **7** | **5** | **0** |
| **INV-01** | | | | ✓ (credentials never in settings) |
| **SEC-05** | | | | ✓ (no credential logging) |

## 6. Implementation Plan

### Block 1: Tauri Plugins + Native Menu (Rust)
**Type:** Infrastructure
**Dependencies:** None
**Estimated time:** 20min
**Files:**
- `src-tauri/Cargo.toml` — add tauri-plugin-dialog, tauri-plugin-fs, tauri-plugin-store
- `src-tauri/tauri.conf.json` — add plugin permissions (dialog:open, dialog:save, fs:read, fs:write, fs:watch, store:default)
- `src-tauri/src/lib.rs` — build full menu (File/Edit/View/Connection/Help), register plugins, emit menu events to frontend, expose `update_menu_item(id, enabled)` Tauri command for bidirectional state sync

**Exit criteria:**
- [ ] App builds with new plugins
- [ ] Menu bar appears with all 5 menus
- [ ] Menu clicks emit `menu://[id]` events to frontend
- [ ] Keyboard shortcuts trigger menu events
- [ ] `update_menu_item` command allows frontend to enable/disable menu items

### Block 2: Command Registry + Menu Wiring (React)
**Type:** Feature slice
**Dependencies:** Block 1
**Estimated time:** 20min
**Files:**
- `src/lib/commands.ts` — CommandRegistry class with register/get/getAll/execute
- `src/App.tsx` — listen to Tauri menu events, dispatch to registry

**Exit criteria:**
- [ ] CommandRegistry created with all menu actions registered
- [ ] Menu events dispatched to correct handlers
- [ ] `when` conditions work (e.g., Save disabled if no active tab)
- [ ] `when` changes propagate to native menu via `update_menu_item` (bidirectional sync)
- [ ] Unit tests for CommandRegistry (register, execute, when conditions)

### Block 3: Command Palette (cmdk)
**Type:** Feature slice
**Dependencies:** Block 2
**Estimated time:** 25min
**Files:**
- `package.json` — add cmdk dependency
- `src/components/palette/CommandPalette.tsx` — cmdk-based UI, file mode + command mode
- `src/App.tsx` — wire Cmd+K to toggle palette, pass project files for search

**Exit criteria:**
- [ ] Cmd+K opens/closes palette
- [ ] Typing filters (file mode by default, > for commands)
- [ ] Selecting a command executes it and closes palette
- [ ] Selecting a file opens it in a new tab
- [ ] Palette works in standalone mode (commands only, no files)
- [ ] Unit tests for palette filtering logic

### Block 4: File I/O (Open/Save)
**Type:** Feature slice
**Dependencies:** Block 1 (dialog + fs plugins), Block 2 (commands)
**Estimated time:** 25min
**Files:**
- `src/lib/file-io.ts` — openFile(), saveFile(), saveFileAs() using Tauri dialog + fs APIs
- `src/stores/editor-store.ts` — add setFilePath, file-aware closeTab (confirm dialog)
- `src/App.tsx` — register file commands in registry, wire Save/Open/SaveAs

**Exit criteria:**
- [ ] File > Open opens .dbsp/.sql file into a new tab with correct language
- [ ] File > Save writes content to filePath, clears dirty
- [ ] File > Save As shows native dialog, creates file, updates tab
- [ ] Close tab with unsaved changes shows confirm dialog
- [ ] App quit (Cmd+Q / window close) with dirty tabs intercepts CloseRequested, prompts for each (SC-25)
- [ ] Tab title shows filename for file-backed tabs
- [ ] Unit tests for file-io (mock Tauri APIs), editor-store file operations

### Block 5: dbsp.settings.json Format + Reader/Writer
**Type:** Feature slice
**Dependencies:** None (can be parallel with blocks 1-4)
**Estimated time:** 20min
**Files:**
- `src/lib/settings.ts` — DbspSettings type, readSettings(), writeSettings(), validateSettings(), SCHEMA_SEARCH_PATHS
- `src/lib/settings.test.ts` — parse, validate, auto-detect schema, error cases

**Exit criteria:**
- [ ] DbspSettings TypeScript type matches the JSON schema
- [ ] readSettings(folderPath) reads and validates dbsp.settings.json
- [ ] writeSettings(folderPath, settings) writes formatted JSON
- [ ] validateSettings() returns typed errors for invalid settings
- [ ] Schema auto-detection searches canonical paths in order
- [ ] Unit tests cover: valid parse, invalid JSON, missing file, auto-detect schema with multiple paths

### Block 6: Profile URI Resolver
**Type:** Feature slice
**Dependencies:** Block 1 (Tauri store plugin), Block 5 (settings type), Sidecar IPC (existing)
**Estimated time:** 25min
**Files:**
- `src/lib/profile-resolver.ts` — resolveProfile(uri, projectPath?) dispatches by scheme
- `src/lib/ipc.ts` — add sidecarApi.resolveProfile(uri, projectPath) IPC method
- Sidecar: add `resolveProfile` JSON-RPC handler (parse .env via dotenv, read env var)
- `src/lib/profile-resolver.test.ts` — unit tests for URI parsing and store:// resolution
- `package.json` — add `dotenv` dependency (bundled in sidecar for .env parsing)

**Exit criteria:**
- [ ] file:// → sidecar parses .env file, returns ConnectionParams
- [ ] env:// → sidecar reads process.env, parses postgres:// URL
- [ ] store:// → frontend reads Tauri secure store
- [ ] Invalid URI → typed error with clear message
- [ ] Missing file/env/store → specific error messages
- [ ] Unit tests for all 3 schemes + error cases

### Block 7: Project Mode + File Tree
**Type:** Feature slice
**Dependencies:** Block 1 (fs plugin + watch), Block 4 (file I/O), Block 5 (settings reader)
**Estimated time:** 30min
**Files:**
- `src/stores/project-store.ts` — project state (folderPath, settings, mode, files[])
- `src/components/schema/FileTree.tsx` — file tree component (lazy expand, file icons)
- `src/components/layout/Sidebar.tsx` — add FileTree section when in project mode
- `src/App.tsx` — wire File > Open Folder, handle progressive transition

**Exit criteria:**
- [ ] File > Open Folder with dbsp.settings.json → project mode, File Tree visible
- [ ] File > Open Folder without settings → standalone, no File Tree
- [ ] File Tree shows .dbsp/.assert.dbsp organized by folder
- [ ] Double-click file in tree → opens in editor tab
- [ ] File tree respects include/exclude globs from settings
- [ ] Progressive transition: saving in standalone → offer to create settings
- [ ] File watcher detects external creation/deletion of dbsp.settings.json → automatic mode switch (SC-27/SC-28)
- [ ] Duplicate file open focuses existing tab instead of creating new tab (SC-26)
- [ ] Unit tests for project-store, file discovery logic

### Block 8: Preferences Dialog
**Type:** Feature slice
**Dependencies:** Block 5 (settings), Block 6 (resolver for profile display)
**Estimated time:** 30min
**Files:**
- `src/components/preferences/PreferencesDialog.tsx` — modal shell with sidebar nav
- `src/components/preferences/GeneralSection.tsx` — language, auto-updates
- `src/components/preferences/EditorSection.tsx` — theme, tabSize, formatOnSave
- `src/components/preferences/DatabasesSection.tsx` — profile list, add/edit/delete/test
- `src/components/preferences/AdvancedSection.tsx` — placeholder for future
- `src/stores/user-settings-store.ts` — local user prefs (zustand/persist)

**Exit criteria:**
- [ ] Cmd+, (or Edit > Preferences) opens the modal
- [ ] Sidebar navigation switches between 4 sections
- [ ] Editor section changes write to dbsp.settings.json (project) or AppData (standalone)
- [ ] Databases section shows connection profiles with URI source
- [ ] Add/Edit/Delete/Test connection profiles works
- [ ] Profile URI is displayed with resolved status (green check or red error)
- [ ] Unit tests for user-settings-store, preferences state management

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~45 | Registry, settings parser, URI resolver, stores, palette filtering |
| Component | ~15 | Palette UI, FileTree, PreferencesDialog (with testing-library/react) |
| E2E | 0 | Deferred (Tauri WebDriver setup too heavy for this iteration) |

### Test Data Requirements

**Fixtures:**
- Sample dbsp.settings.json (valid, invalid, minimal, full)
- Sample .env files (with/without DATABASE_URL)
- Sample project folder structure (for file discovery tests)

**Mocks:**
- Tauri dialog API (open/save dialogs)
- Tauri fs API (readTextFile, writeTextFile, watch)
- Tauri store API (get/set/delete)
- Sidecar IPC (resolveProfile response)

### Coverage Targets
- New files: >80% branch coverage
- Settings parser: 100% (critical for correctness)
- Profile resolver: 100% (security-critical, no silent fallbacks)

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Tauri menu API verbosity (Rust boilerplate) | M | H | Define menu structure in a clean helper function, one-time cost |
| Menu↔Registry event sync | M | M | Menu items emit string IDs, registry lookup by ID |
| cmdk styling conflicts with ShadCN | L | M | Use cmdk unstyled mode, apply Tailwind classes |
| File watcher performance on large folders | M | M | Debounce 300ms, respect exclude globs, lazy-load tree |
| Sidecar restart during profile resolution | M | L | Queue resolution requests, retry on sidecar reconnect |
| Cross-platform shortcut differences | L | L | Tauri Accelerator handles Cmd↔Ctrl automatically |

## 9. Definition of Done

- [ ] All 8 blocks implemented
- [ ] All 28 BDD scenarios have corresponding tests
- [ ] All tests pass (existing 272 + new ~60)
- [ ] Lint/typecheck pass (`pnpm biome check`, `pnpm tsc --noEmit`)
- [ ] Menu bar functional on all platforms (macOS native, Windows/Linux in-window)
- [ ] Command palette opens with Cmd+K
- [ ] File Open/Save works with native dialogs
- [ ] Project mode activates on Open Folder with dbsp.settings.json
- [ ] Preferences dialog opens with Cmd+,
- [ ] /review clean (no blocking findings)
- [ ] TODO.md updated with any deferred items
