# DBSP GUI — Ideation Brief

## Problem Statement

**Problem:** db-semantic-planner is CLI-only. Schema exploration, NQL query writing, and plan inspection require terminal fluency — creating a high onboarding barrier and limiting adoption to power users.

**Root cause:** The engine is mature; the gap is a visual delivery layer that makes the engine's power accessible.

**Target users:**
- Existing dbsp developers (better workflow, visual plan inspection)
- New developers evaluating dbsp (5-minute wow experience)

**Current solutions & gaps:**
- CLI REPL: functional but text-only, no visual schema
- pgAdmin/DBeaver: generic SQL, no NQL/dbsp awareness
- sqlectron: simple inspiration but abandoned, no extensibility

## Proposed Solution

**Approach:** Tauri v2 desktop app with React + ShadCN/UI frontend and Node.js SEA sidecar embedding the dbsp engine.

**Why this approach:**
- Tauri: 3-10x smaller than Electron, native installers (MSI/DMG/DEB), auto-updater, proven (GitButler)
- React + ShadCN: best ecosystem for Monaco Editor, DataGrid, TreeView
- Node.js SEA: reuses existing TypeScript packages as-is, no rewrite
- Sidecar pattern: clean process boundary, crash isolation

## Key Features

### MVP (Must Have)
1. **Connection Manager** — PostgreSQL connection, save/switch profiles
2. **Schema Treeview** — introspect DB, display tables/columns/indexes/FKs
3. **Monaco SQL Editor** — syntax highlighting, table/column autocomplete
4. **Monaco NQL Editor** — custom TextMate grammar, .dbsp file support
5. **Results Table** — virtual scroll, column sort, type-aware display
6. **Plan Inspector** — visual dump: decisions, warnings, CTEs, timing

### Later (Nice to Have)
7. .assert.dbsp runner with inline pass/fail
8. Schema diff (live DB vs schema.ts via compareSchemata)
9. Query history with search
10. Theme system (dark/light + custom)

## Technical Considerations

**Constraints:**
- Must integrate into existing pnpm monorepo as `packages/gui`
- Node.js SEA requires Node 21+ for build
- Tauri v2 requires Rust toolchain
- Cross-platform CI (GitHub Actions tauri-action)

**Stack:**

| Layer | Technology |
|-------|------------|
| Frontend | React 19 + ShadCN/UI + Tailwind CSS |
| Data Table | TanStack Table (virtual scroll) |
| Editor | @monaco-editor/react + custom NQL TextMate grammar |
| State Management | Zustand |
| Layout | react-resizable-panels |
| Backend | Tauri v2 (Rust) |
| Engine | Node.js SEA sidecar (dbsp packages) |
| IPC | JSON-RPC over stdin/stdout |
| Distribution | .msi (winget), .dmg (brew cask), .deb/.AppImage |

**Naming:** `@dbsp/gui` — `packages/gui/`

**Dual mode:**
- Standalone: connect to any PostgreSQL, introspect, run SQL/NQL
- Project mode: load schema.ts, full dbsp workflow (plan, compare, migrate)

## Layout

```
+-----------+----------------------------------------------+
| Schema    | [tab1.dbsp] [tab2.sql] [tab3.dbsp] [+]      |
| --------  | +------------------------------------------+ |
| > users   | |                                          | |
|   id      | |         Monaco Editor                    | |
|   name    | |                                          | |
|   email   | +------------------------------------------+ |
| > posts   | [Results] [SQL] [Plan] [Params]              |
|   id      | +------------------------------------------+ |
|   title   | | id  | name   | email       |             | |
|   author  | | 1   | Alice  | alice@..    |             | |
| > tags    | | 3   | Carol  | carol@..    |             | |
|           | +------------------------------------------+ |
|           | 2 rows - 4.2ms - [Export CSV]                |
+-----------+----------------------------------------------+
```

## Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| SEA binary size (80-120 MB) | M | H | Tree-shaking, bundle only required packages |
| NQL TextMate grammar complexity | M | M | Start basic highlighting, iterate |
| Cross-platform CI | M | M | Use official tauri-action GitHub Action |
| Scope creep | H | M | Strict MVP: connect - tree - edit - run - results |

## Next Steps

- Run `/prd` to generate full PRD with user stories and acceptance criteria
- Scaffold `packages/gui` with Tauri + React + ShadCN
- Create NQL TextMate grammar from Chevrotain lexer token definitions
