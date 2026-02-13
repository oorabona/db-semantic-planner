---
doc-meta:
  status: draft
  scope: gui
  type: design
  created: 2026-02-12
  updated: 2026-02-12
---

# DBSP GUI — Desktop Database Explorer

## Purpose

Visual delivery layer for db-semantic-planner. Makes the engine's power accessible through a desktop application that supports schema exploration, SQL/NQL query writing, and plan inspection — reducing the onboarding barrier from "CLI power user" to "connect and explore".

## Target Users

| Persona | Needs | Mode |
|---------|-------|------|
| Existing dbsp developer | Better workflow, visual plan inspection, .dbsp editing | Project mode |
| New developer evaluating | 5-minute wow experience, visual schema, try NQL | Standalone mode |
| Team lead onboarding members | Show schema visually, demonstrate query patterns | Both modes |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  packages/gui                                                │
│  ┌────────────────────┐    ┌──────────────────────────────┐  │
│  │  Tauri v2 (Rust)   │    │  React 19 + ShadCN/UI        │  │
│  │  ├─ commands.rs     │◄──│  ├─ Monaco Editor (SQL/NQL)   │  │
│  │  ├─ sidecar.rs      │    │  ├─ Schema TreeView           │  │
│  │  └─ ipc.rs          │    │  ├─ Results DataTable          │  │
│  └────────┬───────────┘    │  ├─ Plan Inspector             │  │
│           │ JSON-RPC        │  └─ Connection Manager          │  │
│           │ stdin/stdout    └──────────────────────────────┘  │
│  ┌────────▼───────────┐                                      │
│  │  Node.js SEA        │  ← Single Executable Application    │
│  │  (dbsp engine)      │    Embeds: @dbsp/core, nql,         │
│  │                     │    adapter-pgsql, types              │
│  └─────────────────────┘                                      │
└──────────────────────────────────────────────────────────────┘
```

### Dependencies

```
@dbsp/types ──┐
@dbsp/core ───┤
@dbsp/nql ────┼──→ @dbsp/gui (packages/gui)
@dbsp/adapter-pgsql ┘
```

### Communication Flow

```
Frontend (React)
    │ invoke("query", { nql: "..." })
    ▼
Tauri Rust Commands
    │ sidecar.stdin.write(JSON-RPC)
    ▼
Node.js SEA (dbsp engine)
    │ parse → plan → compile → execute
    │ stdout.write(JSON-RPC response)
    ▼
Tauri Rust Commands → Frontend
```

## Tech Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Desktop framework | Tauri v2 | 3-10x smaller than Electron, native installers, auto-updater |
| Frontend | React 19 | Best Monaco/DataGrid ecosystem |
| UI components | ShadCN/UI + Radix | Polished, accessible, customizable |
| Styling | Tailwind CSS | Rapid, consistent theming |
| Data table | TanStack Table | Virtual scroll, column sort/resize |
| Code editor | @monaco-editor/react | SQL + custom NQL TextMate grammar |
| Layout | react-resizable-panels | Persistent panel sizes, collapse |
| State management | Zustand | Lightweight, React 19 compatible |
| Backend (Rust) | Tauri v2 commands | Sidecar lifecycle, IPC bridge |
| Engine | Node.js SEA sidecar | Reuses existing TS packages as-is |
| IPC protocol | JSON-RPC over stdin/stdout | ~1ms latency, crash isolation |

## Distribution

| Platform | Format | Channel |
|----------|--------|---------|
| Windows | .msi | winget install dbsp-gui |
| macOS | .dmg | brew install --cask dbsp-gui |
| Linux | .deb / .AppImage | apt / direct download |
| Auto-update | Tauri updater | Built-in, signature-verified |

### Future: Web Version (phpMyAdmin-like)

The sidecar architecture naturally enables a pure web version:

```
Desktop (Tauri)                 Web (future @dbsp/web)
React frontend ──┐              React frontend ──┐ (same code)
  Tauri invoke() │                fetch() / WS   │
  Rust commands  │              Express/Fastify   │
  Node SEA ◄─────┘              Node.js server ◄──┘
  pg Pool → PostgreSQL          pg Pool → PostgreSQL
```

- Frontend React code is **identical** between desktop and web
- Backend Node.js engine is **identical** — only transport changes (stdin → HTTP/WS)
- IPC abstraction layer must be designed to support both transports
- Web version requires a server (browser cannot connect to PostgreSQL directly via TCP)
- WASM is NOT needed: the dbsp engine is pure JavaScript, runs natively in any JS environment

**Architectural constraint:** Keep the IPC layer transport-agnostic from day 1.

## Layout

```
┌──────────────────────────────────────────────────────────┐
│ [Connection: mydb@localhost] [+]          [dark] [gear]  │
├──────────┬───────────────────────────────────────────────┤
│ Schema   │  [tab1.dbsp] [tab2.sql] [tab3.dbsp] [+]     │
│ --------  │ ┌───────────────────────────────────────────┐ │
│ > users  │ │                                           │ │
│   id     │ │         Monaco Editor                     │ │
│   name   │ │                                           │ │
│   email  │ │  users | status = 'active' | limit 10     │ │
│ > posts  │ │                                           │ │
│   id     │ └───────────────────────────────────────────┘ │
│   title  │ ┌───────────────────────────────────────────┐ │
│   author │ │ [Results] [SQL] [Plan] [Params]           │ │
│ > tags   │ │ ┌─────┬────────┬─────────────┐           │ │
│          │ │ │ id  │ name   │ email       │           │ │
│          │ │ ├─────┼────────┼─────────────┤           │ │
│          │ │ │ 1   │ Alice  │ alice@..    │           │ │
│          │ │ │ 3   │ Carol  │ carol@..    │           │ │
│          │ │ └─────┴────────┴─────────────┘           │ │
│          │ │ 2 rows · 4.2ms · [Export CSV]            │ │
│          │ └───────────────────────────────────────────┘ │
└──────────┴───────────────────────────────────────────────┘
```

### Panel Details

| Panel | Component | Key Features |
|-------|-----------|-------------|
| Schema (left) | TreeView | Expand tables/columns/indexes/FKs, search filter, type icons |
| Editor (top-right) | Monaco | Tabs (.dbsp, .sql), syntax highlight, autocomplete, Cmd+Enter to run |
| Results (bottom-right) | DataTable + Tabs | Results / SQL / Plan / Params tabs, virtual scroll, export |

## Dual Mode

| Mode | Activation | Capabilities |
|------|-----------|-------------|
| Standalone | Connect to any PostgreSQL | Introspect, run SQL/NQL, view results |
| Project | Open folder with schema.ts | Full workflow: plan, compare, migrate, .dbsp/.assert.dbsp |

## Key Features

### MVP (Must Have)

1. **Connection Manager** — PostgreSQL connection string, save/switch profiles, test connection
2. **Schema Treeview** — introspect connected DB, tables → columns (type, nullable, PK/FK), indexes, constraints
3. **Monaco SQL Editor** — PostgreSQL syntax highlighting, table/column autocomplete from schema tree
4. **Monaco NQL Editor** — custom TextMate grammar from Chevrotain lexer, .dbsp file support, pipe-aware highlighting
5. **Results Table** — TanStack virtual scroll, column sort, type-aware display (dates, JSON, null), row count + timing
6. **Plan Inspector** — visual dump: root table, decisions (strategy + reason), warnings (message + suggestion), CTE count, timing

### Later (Nice to Have)

7. **.assert.dbsp runner** — inline pass/fail, green/red markers, bulk run
8. **Schema diff** — compare live DB vs schema.ts (reuse `compareSchemata` from adapter-pgsql/ddl)
9. **Query history** — timestamped log with search, re-run, copy
10. **Theme system** — dark/light toggle, custom accent colors

## File Structure

```
packages/gui/
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── main.rs               # Tauri bootstrap
│   │   ├── commands.rs            # invoke handlers (query, introspect, connect)
│   │   ├── sidecar.rs             # Node.js SEA lifecycle management
│   │   └── ipc.rs                 # JSON-RPC protocol (request/response/error)
│   ├── Cargo.toml
│   └── tauri.conf.json            # Bundle config, externalBin, window settings
├── src/                           # React frontend
│   ├── App.tsx                    # Root layout with resizable panels
│   ├── components/
│   │   ├── layout/                # SplitPane, Sidebar, TabBar, StatusBar
│   │   ├── editor/                # Monaco wrapper, NQL grammar, tab management
│   │   ├── schema/                # TreeView, column details, search
│   │   ├── results/               # DataTable, plan inspector, param viewer
│   │   └── connection/            # Connection dialog, saved profiles
│   ├── hooks/                     # useQuery, useSchema, useSidecar, useConnection
│   ├── stores/                    # Zustand: connections, tabs, results, preferences
│   └── lib/
│       ├── ipc.ts                 # Tauri invoke typed wrappers
│       ├── nql-grammar/           # TextMate grammar for Monaco
│       └── types.ts               # Shared frontend types
├── package.json                   # @dbsp/gui
├── tsconfig.json
└── vite.config.ts                 # Vite (Tauri default bundler)
```

## Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| SEA binary size (80-120 MB) | M | H | Tree-shaking, bundle only required packages |
| NQL TextMate grammar complexity | M | M | Start with basic token highlighting, iterate |
| Cross-platform CI matrix | M | M | GitHub Actions tauri-action (official) |
| Scope creep beyond MVP | H | M | Strict gate: connect → tree → edit → run → results |

## Open Questions

- [ ] NQL TextMate grammar: generate from Chevrotain lexer tokens or hand-write?
- [ ] Connection profiles: store in Tauri app data or in project `.dbsp/` config?
- [ ] Standalone mode: should it support NQL without a schema.ts (auto-infer from introspection)?
- [ ] Result export: CSV only for MVP, or also JSON/SQL INSERT?

## Next Steps

1. Run `/clarify gui` to detail MVP feature requirements
2. Run `/spec GUI-001` for Connection Manager + Schema Treeview
3. Run `/spec GUI-002` for Monaco Editor (SQL + NQL)
4. Run `/spec GUI-003` for Results Table + Plan Inspector
