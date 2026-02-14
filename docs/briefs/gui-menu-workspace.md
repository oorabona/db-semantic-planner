# GUI Menu + Workspace + Settings — Ideation Brief

## Problem Statement

**Problem:** The GUI MVP has no global entry point for actions. All interactions are contextual (buttons scattered in panels), .dbsp files are in-memory only (lost on close), and there is no "project" concept linking files, connections, and editor into a cohesive workflow.

**Root cause:** The MVP focused on connect → query → results. The missing layer is the **project** as a unit of work — connecting files, connection profiles, and editor settings. The menu bar is the natural entry point to this concept.

**Target users:**
- Existing dbsp developers (need file persistence, assertions, project-level settings)
- New developers (expect standard desktop UX: File > Open, Cmd+S, Cmd+K)
- Teams sharing queries via git (need committable project config, no secrets in repo)

**Current solutions & gaps:**
- GUI MVP: in-memory tabs, no save, no project concept
- DBeaver: full menu + workspace but zero NQL/dbsp awareness
- VS Code: excellent model (folder-based, settings.json, command palette) — our reference

## Proposed Solution

**Approach:** Three complementary layers built incrementally.

1. **Native Menu Bar** (Tauri Rust) — standard desktop menus: File, Edit, View, Connection, Help
2. **Command Palette** (cmdk) — Cmd+K unified entry (files + `>` commands), same registry as menu
3. **Workspace/Project** (dbsp.settings.json) — VS Code-like folder model with progressive disclosure

**Why this approach:**
- Menu is free perf-wise (Rust native, not React)
- Command Palette via cmdk is proven (Linear, Vercel, Raycast) and tiny (3KB)
- dbsp.settings.json is shared between CLI (`dbsp init`) and GUI — one format, two consumers
- Progressive disclosure: no friction at startup, project mode unlocked by user actions

## Architecture

### Layer Stack

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1 — Native Menu (Tauri Rust)                          │
│   File / Edit / View / Connection / Help                     │
│   Keyboard shortcuts → emit Tauri events to frontend         │
├─────────────────────────────────────────────────────────────┤
│ Layer 2 — Command Registry (React)                          │
│   Shared registry: { id, label, shortcut, handler, when }    │
│   Both menu and palette read from the same source            │
├─────────────────────────────────────────────────────────────┤
│ Layer 3 — Command Palette (cmdk + React)                    │
│   Cmd+K → opens palette                                      │
│   Type directly = fuzzy file search (.dbsp, .assert.dbsp)    │
│   Type > prefix = command search (same as menu entries)      │
├─────────────────────────────────────────────────────────────┤
│ Layer 4 — Project Mode (dbsp.settings.json)                 │
│   Detection: Open Folder → walk up for dbsp.settings.json    │
│   Creation: user action (Save, Assert) → propose creation    │
│   Content: connection URIs + schema path + globs             │
├─────────────────────────────────────────────────────────────┤
│ Layer 5 — Profile URI Resolver (shared CLI/GUI)             │
│   file://.env.local → parse dotenv → DATABASE_URL            │
│   env://DATABASE_URL → process.env lookup                    │
│   store://dev-local → Tauri secure store / CLI keyring       │
└─────────────────────────────────────────────────────────────┘
```

### Settings Architecture (Two Stores)

```
dbsp.settings.json (project, git-committed)     Tauri AppData (user, local only)
├── connections[]                                ├── theme: "light" | "dark"
│   ├── name, profile URI, schema               ├── windowState: { x, y, w, h }
│   └── readOnly flag                            ├── recentProjects: string[]
├── defaultConnection                            ├── keybindings: override[]
├── project.schema ("auto" | path)               ├── lastOpenTabs: string[]
├── project.include/exclude globs                └── locale: string
└── editor.tabSize, formatOnSave, maxResults
```

**Separation principle:**
- `dbsp.settings.json` = what a teammate needs to reproduce the project (committed)
- Tauri AppData = personal preferences (never committed, per-machine)

### dbsp.settings.json Schema

```jsonc
{
  // JSON Schema for IDE autocomplete
  "$schema": "https://dbsp.dev/schemas/settings.json",

  // Connection profiles — URI-based, never inline credentials
  "connections": [
    {
      "name": "dev-local",
      "profile": "file://.env.local",
      "defaultSchema": "public"
    },
    {
      "name": "staging",
      "profile": "env://STAGING_DB_URL"
    },
    {
      "name": "production",
      "profile": "store://prod-readonly",
      "readOnly": true
    }
  ],
  "defaultConnection": "dev-local",

  // Project files — auto-discovery with optional overrides
  "project": {
    "schema": "auto",                  // or "./src/schema.ts", "./packages/db/schema.ts"
    "include": ["**/*.dbsp", "**/*.assert.dbsp"],
    "exclude": ["node_modules", "dist", ".git"]
  },

  // Shared editor settings (applies to both CLI and GUI)
  "editor": {
    "tabSize": 2,
    "formatOnSave": false,
    "maxResults": 1000
  }
}
```

**Schema auto-detection order:**
1. `schema.ts` (project root)
2. `src/schema.ts`
3. `db/schema.ts`
4. `packages/*/schema.ts` (monorepo)
5. If none found → standalone mode (introspection only)

**Profile URI resolution pipeline:**

| Scheme | Resolution | Example |
|--------|-----------|---------|
| `file://` | Parse dotenv file, extract `DATABASE_URL` | `file://.env.local` |
| `env://` | Read from process.env | `env://DATABASE_URL` |
| `store://` | Tauri secure store (GUI) / system keyring (CLI) | `store://dev-local` |
| `vault://` | Future: external vault integration | `vault://hashicorp/dbsp-prod` |

### Menu Bar Structure

```
File
├── New Query              Cmd+N
├── Open File...           Cmd+O
├── Open Folder...         Cmd+Shift+O
├── ─────────────
├── Save                   Cmd+S       (disabled if in-memory tab)
├── Save As...             Cmd+Shift+S
├── ─────────────
├── Export Results (CSV)   Cmd+E
├── ─────────────
├── Close Tab              Cmd+W
├── Preferences...         Cmd+,
└── Quit                   Cmd+Q

Edit
├── Undo                   Cmd+Z
├── Redo                   Cmd+Shift+Z
├── ─────────────
├── Cut                    Cmd+X
├── Copy                   Cmd+C
├── Paste                  Cmd+V
├── ─────────────
├── Find                   Cmd+F
├── Replace                Cmd+H
├── ─────────────
└── Format Document        Cmd+Shift+F

View
├── Command Palette        Cmd+K
├── ─────────────
├── Toggle Sidebar         Cmd+B
├── Toggle Results Panel   Cmd+J
├── ─────────────
├── Zoom In                Cmd+=
├── Zoom Out               Cmd+-
└── Reset Zoom             Cmd+0

Connection
├── New Connection...
├── Disconnect
├── ─────────────
├── Switch Connection      ▸ (submenu: profiles from settings)
└── Manage Profiles...

Help
├── Keyboard Shortcuts     Cmd+?
├── Documentation
├── ─────────────
├── About DBSP Explorer
└── Check for Updates
```

### Modes and Transitions

```
STANDALONE (default)                    PROJECT (opt-in)
┌──────────┬──────────────┐            ┌──────────┬──────────────┐
│ Schema   │ Editor       │            │ Schema   │ Editor       │
│ Tree     │ (in-memory)  │            │ Tree     │ (file-backed)│
│          │              │            │──────────│              │
│          │              │            │ Files    │              │
│          │              │   ────►    │ ├ users.dbsp            │
│          │              │            │ ├ reports.dbsp          │
│          │              │            │ └ tests/                │
│          ├──────────────┤            │   └ users.assert.dbsp   │
│          │ Results      │            │          ├──────────────┤
└──────────┴──────────────┘            │          │ Results      │
                                       └──────────┴──────────────┘
```

**Transition triggers (standalone → project):**

| User action | GUI response |
|-------------|-------------|
| File > Open Folder (has dbsp.settings.json) | Auto-detect project, switch to project mode |
| File > Open Folder (no settings) | Open as folder, stay standalone until Save |
| File > Save (first time, no project) | Native Save As dialog. If saved in a folder → offer to create dbsp.settings.json |
| Run assertion (.assert.dbsp) | Requires project mode → offer to create settings |
| File > Save (in project folder) | Direct save, file-backed tab |
| Generate schema from introspection | Offer to save schema.ts → triggers project creation |

**No splash screen.** No upfront mode choice. The user starts, connects, queries. The project emerges naturally from their workflow.

### Preferences Dialog

```
┌─────────────────────────────────────────────────────────┐
│ Preferences                                        [X]  │
├────────────┬────────────────────────────────────────────┤
│            │                                            │
│ General    │  Language: [English ▾]                     │
│            │  Auto-updates: [✓]                         │
│ Editor     │  Telemetry: [  ]                           │
│            │                                            │
│ Databases  │                                            │
│            │                                            │
│ Advanced   │                                            │
│            │                                            │
├────────────┴────────────────────────────────────────────┤
│                                    [Cancel] [Save]      │
└─────────────────────────────────────────────────────────┘
```

**Sections:**

| Section | Content | Persists to |
|---------|---------|-------------|
| General | Language, auto-updates, telemetry | Tauri AppData (user) |
| Editor | Theme (light/dark), tab size, format on save, font size, max results | Theme → AppData; rest → dbsp.settings.json |
| Databases | Connection profiles list, add/edit/delete/test, default connection | dbsp.settings.json (profiles) + secure store (passwords) |
| Advanced | Log level, sidecar path override, experimental features | Tauri AppData (user) |

**Multi-profile management in Databases section:**

```
┌─────────────────────────────────────────────────────────┐
│ Databases                                               │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Connection Profiles:                                    │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ ★ dev-local      file://.env.local      [Test] [✎] │ │
│ │   staging         env://STAGING_DB_URL   [Test] [✎] │ │
│ │   production      store://prod-readonly  [Test] [✎] │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ [+ Add Connection]  [Set as Default]  [Delete]          │
│                                                         │
│ Default schema: [public          ]                      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

★ = default connection. Each profile shows its URI source, has Test and Edit buttons.

### Command Registry Design

```typescript
interface Command {
  id: string;              // e.g. "file.save", "connection.new"
  label: string;           // Display label in palette/menu
  shortcut?: string;       // e.g. "Cmd+S"
  icon?: LucideIcon;       // Icon for palette
  handler: () => void;     // Execution function
  when?: () => boolean;    // Conditional availability
  category: string;        // For palette grouping
}

// Single registry — source of truth for both menu and palette
const commandRegistry = new Map<string, Command>();

// Menu reads from registry
// Command Palette reads from registry
// Keyboard shortcuts bound from registry
```

### File Tree Component (Project Mode Sidebar)

```
Schema (DB introspection)        ← existing SchemaTree
─────────────────────────
Files (project)                  ← new, only in project mode
├── 📁 queries/
│   ├── 📄 users.dbsp
│   ├── 📄 reports.dbsp
│   └── 📁 analytics/
│       └── 📄 monthly.dbsp
├── 📁 assertions/
│   └── 📄 users.assert.dbsp
└── 📄 schema.ts
```

- Double-click to open in editor tab
- Right-click context menu: Rename, Delete, New File, New Folder
- File icons differentiate .dbsp, .assert.dbsp, .ts, .sql
- File watcher (Tauri watch API) for external changes

## Key Features

### MVP (Must Have)

1. **Native Menu Bar** — Tauri Rust menu (File/Edit/View/Connection/Help) with keyboard shortcuts
2. **Command Registry** — shared action registry consumed by both menu and command palette
3. **Command Palette** — cmdk-based, Cmd+K activation, file fuzzy search + `>` command mode
4. **File-backed tabs** — Save/Open .dbsp files, modified indicator, tab title = filename
5. **Open Folder** — detect dbsp.settings.json, switch to project mode, file tree in sidebar
6. **dbsp.settings.json** — project config format with $schema, shared between CLI and GUI
7. **Profile URI resolver** — file://, env://, store:// schemes for credential resolution
8. **File Tree sidebar section** — visible only in project mode, auto-discovers .dbsp/.assert.dbsp
9. **Progressive transition** — standalone by default, project mode triggered by user actions
10. **Preferences dialog** — modal with sidebar (General/Editor/Databases/Advanced), multi-profile management

### Later (Nice to Have)

11. **Keyboard Shortcuts viewer/editor** — visual shortcut reference and custom keybinding
12. **`dbsp init` CLI** — same dbsp.settings.json output (E17c unification)
13. **vault:// scheme** — external vault integration for enterprise credentials
14. **File templates** — New File > NQL Query template, Assertion template
15. **Breadcrumb navigation** — show file path in editor header for deep project structures

## Technical Considerations

**Constraints:**
- Menu bar is Rust code (Tauri v2 menu API) — changes require Rust rebuild
- cmdk requires React 18+ (we have React 19 — OK)
- File system access requires Tauri fs plugin (scope permissions in tauri.conf.json)
- Profile URI resolver must work in both Node.js (sidecar/CLI) and browser (frontend)
  → Implement in shared TypeScript, sidecar resolves and passes params to frontend

**Stack additions:**

| Addition | Package | Rationale |
|----------|---------|-----------|
| Command Palette | cmdk | 3KB, proven (Linear/Vercel/Raycast), composable |
| File watching | @tauri-apps/plugin-fs (watch) | Native file system events |
| Secure store | @tauri-apps/plugin-store | Encrypted credential storage |
| Dotenv parsing | dotenv (in sidecar) | Robust .env file parsing |
| Fuzzy search | fuse.js or cmdk built-in | File name matching in palette |

**Cross-platform menu behavior:**
- macOS: native menu bar (top of screen), Cmd shortcuts
- Windows/Linux: in-window menu bar, Ctrl shortcuts
- Tauri handles this automatically with `Accelerator` modifiers

## Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Tauri menu API verbosity (Rust boilerplate) | M | H | Generate menu from JSON config, minimize manual Rust |
| Command registry ↔ Tauri menu sync complexity | M | M | Menu emits event IDs, frontend matches to registry |
| File watcher flood (large project folders) | L | M | Debounce + respect exclude globs |
| .env parsing edge cases | L | M | Use battle-tested dotenv lib, not custom parser |
| Preferences dialog scope creep | M | M | Ship with General + Editor + Databases; Advanced = later |
| Monorepo dbsp.settings.json walk-up detection | L | L | Same algorithm as package.json resolution |

## Open Questions (Resolved)

| Question | Decision |
|----------|----------|
| Workspace model? | VS Code-like: Open Folder, detect dbsp.settings.json |
| Credentials in settings? | Never. URI profiles point to .env / secure store |
| Menu scope? | Complete + Command Palette |
| File discovery? | Auto-discovery + configurable globs |
| Schema path? | Optional, auto-detect in project mode, standalone without |
| Standalone→Project transition? | Progressive disclosure, no splash screen |
| Save flow? | Native Save As dialog |
| Project UI change? | File Tree section in sidebar |
| CLI compatibility? | Same dbsp.settings.json format |
| Command Palette lib? | cmdk |
| Preferences dialog? | Modal with sidebar (General/Editor/Databases/Advanced) |
| Multi-profile? | connections[] array in settings, URI-based |

## Next Steps

1. Run `/workflow` to create implementation spec and blocks
2. Suggested block order:
   - Block 1: Command Registry + Native Menu (Rust + React)
   - Block 2: Command Palette (cmdk integration)
   - Block 3: File I/O — Open/Save .dbsp, file-backed tabs
   - Block 4: dbsp.settings.json format + reader/writer
   - Block 5: Profile URI resolver (file://, env://, store://)
   - Block 6: Open Folder + project detection + File Tree sidebar
   - Block 7: Progressive standalone → project transition
   - Block 8: Preferences dialog (General/Editor/Databases)
