# GUI Log SQLite Backend — Ideation Brief

## Problem Statement

**Problem:** Application logs in the GUI desktop explorer are stored in an in-memory Zustand ring buffer (max 500 entries). Logs are lost on restart, cannot be filtered, and the UI timestamp format is confusing to users.

**Root cause:** Log storage was designed as a display buffer, not as a queryable observability system.

**Target users:** Developers using the GUI to debug queries/schema, operators needing log export for diagnosis.

**Current solutions:** Zustand ring buffer (GUI-016), DevTools console (if open), sidecar stderr (if launched in terminal).

## Proposed Solution

**Approach:** Replace the in-memory ring buffer with SQLite via `tauri-plugin-sql` (official Tauri v2 plugin). SQLite runs on the Rust side, stored in `$APPDATA/dbsp-gui/logs.db`. Frontend queries via Tauri commands. Zustand remains as a hot display cache synchronized from SQLite query results.

**Why this approach:**
- Native Tauri plugin (official, well-maintained, minimal risk)
- Real SQL for filtering (`WHERE level = ? AND source = ?`)
- File-based DB → naturally exportable, inspectable, survives restarts
- No WASM overhead (vs sql.js), no WebView compat issues (vs IndexedDB)
- No sidecar changes needed (vs better-sqlite3 which is incompatible with Node SEA)

**Alternatives considered:**
1. better-sqlite3 in sidecar → BLOCKED (native addon incompatible with Node SEA)
2. sql.js (WASM SQLite) → viable but +1MB WASM, manual persistence
3. Dexie/IndexedDB → no SQL, uncertain Tauri WebView support
4. Zustand + tauri-store → JSON, not queryable, poor at scale

## Architecture

```
Frontend (React)
┌───────────────┐     ┌──────────────────────┐
│  LogPanel.tsx  │────→│  log-store.ts         │
│  + FilterBar   │     │  (Zustand = hot view) │
│  + SearchBar   │     │  entries[] (display)   │
└───────────────┘     └──────┬───────────────┘
                              │ sync
┌─────────────────────────────▼─────────────────────────┐
│  log-db.ts (new)                                       │
│  • insertLog(entry)    → INSERT INTO logs ...          │
│  • queryLogs(filters)  → SELECT ... WHERE ...          │
│  • exportLogs(path)    → SELECT * → write JSON/CSV     │
│  • clearOldLogs(days)  → DELETE WHERE timestamp < ?    │
│  • getStats()          → COUNT(*) GROUP BY level       │
└─────────────────────────────┬─────────────────────────┘
                              │ @tauri-apps/plugin-sql
Rust (Tauri backend)
┌─────────────────────────────▼─────────────────────────┐
│  tauri-plugin-sql → SQLite ($APPDATA/dbsp-gui/logs.db) │
└────────────────────────────────────────────────────────┘
```

## Key Features (All MVP)

### 1. SQLite Persistence + Schema
- Table: `logs(id INTEGER PRIMARY KEY, timestamp INTEGER, level TEXT, source TEXT, message TEXT, duration_ms INTEGER)`
- Indexes: `(timestamp)`, `(level, timestamp)`, `(source, timestamp)`
- Auto-rotation: DELETE WHERE timestamp < now - 7 days (configurable)
- Init on app startup, migrate schema if needed

### 2. Filter Dropdowns (GUI-016a)
- Level filter: multi-select dropdown (info, warn, error, debug)
- Source filter: multi-select dropdown (sidecar, ipc, app)
- Filters map to SQL WHERE clauses
- Zustand hot view re-queries SQLite on filter change

### 3. Export Logs to File (GUI-016c)
- Export button → save dialog (tauri-plugin-dialog already installed)
- Formats: JSON (structured) and/or CSV (spreadsheet-compatible)
- Export respects current filters (export what you see)
- Bonus: clear logs button now also clears SQLite

### 4. Improved UI
- Timestamp: compact `HH:MM:SS` format (drop milliseconds in display, keep in DB)
- Relative time tooltip on hover ("2 seconds ago")
- Text search input filtering message content (SQL LIKE)
- Entry count shows filtered/total: "42 / 1,203 entries"
- Optional: alternating row colors for readability

## Technical Considerations

**Constraints:**
- Must add `tauri-plugin-sql` to both Rust (Cargo.toml) and JS (package.json)
- Must register plugin in `lib.rs` and add SQLite permissions in `capabilities/`
- Zustand store API must remain backward-compatible (addEntry still works)
- Batch inserts (buffer ~100ms) to avoid blocking renderer on high-frequency logs

**Migration path:**
- log-store.ts `addEntry()` → also calls `log-db.insertLog()` (dual-write)
- log-store.ts `entries` → populated from `log-db.queryLogs(filters)` instead of internal array
- Ring buffer removed (SQLite + rotation replaces it)

## Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Plugin perf on high volume | M | L | Batch inserts + VACUUM + 7-day rotation |
| Cross-platform DB path | M | L | Tauri resolves `$APPDATA` per OS |
| INSERT blocking renderer | M | M | Async batch buffer (100ms debounce) |
| Schema migration between versions | L | M | Version table + ALTER TABLE on startup |

## Unifies TODO Items

- **GUI-016a** [Log panel: level/source filter dropdowns] → Feature 2
- **GUI-016c** [Log panel: export logs + persist across sessions] → Features 1 + 3

## Next Steps

→ Run `/workflow` to implement (SIMPLE: 4-5 files, clear scope, extends existing panel)
