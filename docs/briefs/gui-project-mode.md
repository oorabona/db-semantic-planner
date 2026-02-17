# GUI-022: Project Mode — Ideation Brief

## Problem Statement

**Problem:** The GUI is a stateless single-session DB explorer. Query history, logs, connection settings, and schema context are either ephemeral (localStorage) or global (single SQLite). Users who work on multiple databases or return to the same project lose context every time.

**Root cause:** No project identity layer exists to partition state (history, logs, settings, schema) per database/project.

**Target users:** Developers who use the GUI regularly with 1-3 databases, especially those with a `schema.ts` file defining their data model.

**Current solutions:** Manual reconnection each session, history in localStorage (no search, no persistence across clear), logs in a single global SQLite.

## Proposed Solution

**Approach:** Hybrid filesystem architecture

- **Project-aware:** `.dbsp/` folder in project directory (detected automatically) for versioned projects
- **Global fallback:** `~/.dbsp/` for ad-hoc connections and app-level state
- **Unified storage:** One `<connection>.sqlite` per project/connection (history + IPC logs + connection profiles)
- **Global app logs:** `~/.dbsp/app.sqlite` for sidecar stderr, boot errors, app-level events

**Why this approach:** Respects developer workflows (`.dbsp/` next to code = familiar pattern like `.vscode/`), works without project setup (global fallback), and keeps SQLite out of git (`.gitignore`).

## Storage Architecture

### Per-Project/Connection SQLite (`<name>.sqlite`)

| Table | Content | Scope |
|-------|---------|-------|
| `query_history` | NQL/SQL queries executed by user | Per connection |
| `ipc_logs` | IPC request/response with timing | Per connection |
| `connection_profiles` | Host, port, database, credentials ref | Per project |

### Global App SQLite (`~/.dbsp/app.sqlite`)

| Table | Content | Scope |
|-------|---------|-------|
| `app_logs` | Sidecar stderr, boot errors, app events | Global |
| `recent_projects` | Last opened projects (paths + timestamps) | Global |
| `global_settings` | App-wide preferences | Global |

### Log Scoping Rules

| Log type | Example | Storage |
|----------|---------|---------|
| Sidecar stderr | Boot errors, crash output | `~/.dbsp/app.sqlite` |
| App-level events | "Project opened", "Settings saved" | `~/.dbsp/app.sqlite` |
| IPC request/response | `schema.introspect` → 245ms | `<conn>.sqlite` |
| Query history | User-executed NQL/SQL | `<conn>.sqlite` |

## Project Lifecycle

### Path A: "New Project" (greenfield)

```
File > New Project...  (or Welcome screen CTA)
  Step 1: Name + location
    → .dbsp/ in existing dir  OR  ~/.dbsp/<name>/
  Step 2: Configure connection
    → Host, port, database, credentials
  Step 3 (optional): Reverse-engineer schema.ts
    → Introspect DB → generate schema.ts
    → Best-effort with TODO annotations for ambiguous types
```

### Path B: "Convert to Project" (from ad-hoc connection)

```
Already connected → "Save as Project" button
  Step 1: Name + location (pre-filled from connection)
  Step 2: Generate schema.ts? (checkbox, default: yes)
  Step 3: Done → project created, connection migrated
```

## Key Features

### MVP (Must Have)

1. **F1: Project folder detection** — `.dbsp/` auto-detect + `~/.dbsp/` fallback
2. **F2: Unified per-connection SQLite** — replaces localStorage history + current log SQLite
3. **F3: Global app.sqlite** — sidecar stderr + app events (replaces current global log store)
4. **F4: IPC logs scoped per connection** — migrate from global log-store to per-connection
5. **F5: "New Project" wizard** — File menu + welcome screen CTA, 3-step wizard
6. **F6: "Convert to Project"** — from ad-hoc connection, onboarding path
7. **F7: Reverse-engineering** — introspect DB → generate `schema.ts` (part of F5/F6)
8. **F8: File menu reorganization** — New NQL File, project items (New/Open/Recent)
9. **F9: Schema.ts editor + auto-reload** — Monaco tab, `fs.watch()`, sidecar `schema.reload`
10. **F10: Connection profiles in SQLite** — replace settings.json connection storage

### Later (Nice to Have)

11. **F11: Multi-connection switching** — project with N connection profiles
12. **F12: Team sharing** — `.dbsp/` in git (minus `.sqlite`), `.gitignore` template
13. **F13: Project templates** — blog, ecommerce, etc. (scaffolding)

## File Menu Reorganization

```
File
├── New Project...          (F5)
├── Open Project...         (F1)
├── Recent Projects    →    (F1)
├── ─────────────────
├── New SQL File            (existing, renamed from "New File")
├── New NQL File            (F8)
├── Open File...            (existing)
├── ─────────────────
├── Save                    (existing)
├── Save As...              (existing)
├── Export Logs...          (existing)
├── ─────────────────
├── Preferences...          (existing)
└── Quit                    (existing)
```

## Schema.ts Editing

- **Mono-file editor:** NOT a general TypeScript IDE — only `schema.ts`
- **Monaco tab:** TypeScript syntax highlighting (already available in GUI)
- **File watcher:** `Tauri fs.watch()` on schema.ts path, debounced 500ms
- **On change:** Re-parse schema → refresh schema tree + SQL/NQL completions
- **Entry point:** "Edit Schema" button in schema tree header
- **Save:** Triggers sidecar `schema.reload` → live refresh without restart

## Technical Considerations

**Constraints:**
- Must be backward-compatible: existing users without `.dbsp/` keep working (global fallback)
- SQLite files in `.gitignore` by default (history is local, not shared)
- schema.ts reverse-engineering is best-effort (FK detection depends on constraints existing in DB)
- Tauri `fs.watch()` has known race conditions on rapid saves → debounce required

**Migration path:**
- Existing localStorage query history → migrate to SQLite on first project creation
- Existing global log SQLite → split into app.sqlite (global) + per-connection (scoped)
- Existing settings.json connections → migrate to project SQLite profiles

## Risks

| Risk | Mitigation |
|------|------------|
| SQLite migration from localStorage + current log-store | Gradual: keep fallback to old stores during transition period |
| schema.ts parsing failures (malformed TS) | Graceful degradation: show error toast, keep last valid schema |
| File watcher race conditions | Debounce 500ms on fs.watch events |
| Reverse-engineering incomplete (missing FKs, types) | Generate best-effort + TODO annotations in schema.ts |
| Wizard UX complexity (too many steps) | Max 3 steps, smart defaults, skip optional steps |

## Next Steps

→ Run `/workflow GUI-022` with this brief to plan and implement
→ Start with F1 (project detection) + F2 (unified SQLite) as foundation blocks
→ F5/F6 (wizard) depends on F1+F2 being in place
