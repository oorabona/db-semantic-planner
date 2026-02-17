# GUI-025: Explicit Project File Management — Ideation Brief

## Problem Statement

**Problem:** The GUI uses recursive directory walking (`discoverFiles`) to find `.dbsp`/`.assert.dbsp` files in project folders. This is fragile (Tauri scope errors on forbidden paths like `.claude`), implicit (user doesn't control what's tracked), and requires maintaining an exclusion list.

**Root cause:** Project files are discovered implicitly via glob patterns instead of being explicitly tracked. The directory walking approach doesn't fit the Tauri security model (scoped filesystem access) and gives users no control over their project contents.

**Target users:** GUI users creating and managing dbsp projects.

**Current solution:** `discoverFiles()` recursively walks directories, filtered by `DEFAULT_INCLUDE` (`**/*.dbsp`, `**/*.assert.dbsp`) and `DEFAULT_EXCLUDE` (`node_modules`, `dist`, `.git`). Crashes on forbidden paths even with try/catch resilience.

## Proposed Solution

**Approach:** Replace implicit discovery with explicit file tracking in `dbsp.settings.json`. Project files are added via drag & drop, file picker, or one-time scan during wizard setup. The tree view shows exactly what's in the project — nothing more, nothing less.

**Why this approach:**
- Eliminates an entire class of bugs (permissions, dotfiles, Tauri scopes)
- Gives users explicit control over project contents
- Simpler code (remove `discoverFiles`, `DEFAULT_INCLUDE`, `DEFAULT_EXCLUDE`, `shouldIncludeFile`)
- `dbsp.settings.json` becomes single source of truth

## Key Features (all MVP)

### F1: Settings schema change — `project.files[]` replaces `include`/`exclude`

```jsonc
{
  "version": 1,
  "project": {
    "name": "my-project",
    "schemaPath": "src/schema.ts",
    "files": [
      "queries/users.dbsp",
      "queries/users.assert.dbsp",
      "reports/monthly.sql"
    ]
    // include/exclude: REMOVED
  }
}
```

- `project.files[]` — explicit list of relative paths from project root
- `project.schemaPath` — already exists, now becomes primary (not 'auto')
- Remove `include`, `exclude` fields from `DbspProjectSettings`
- Remove `DEFAULT_INCLUDE`, `DEFAULT_EXCLUDE`, `discoverFiles`, `shouldIncludeFile`

### F2: Sidebar tabs — "Database" | "Project"

Current sidebar layout is stacked (files above, schema below). Replace with tabs:

```
┌─────────────────────────┐
│ [Database] [Project]    │  ← tabs (project tab only in project mode)
├─────────────────────────┤
│                         │
│  (active tab content)   │
│                         │
└─────────────────────────┘
```

- **Database tab:** Current `SchemaTree` (tables, columns, relations)
- **Project tab:** Enhanced `FileTree` showing `project.files[]` as tree + schema.ts pinned at bottom
- **Standalone mode:** Only "Database" tab visible (no tab switcher needed)
- **Project mode:** Both tabs, "Project" selected by default

### F3: Project files tree view (enhanced FileTree)

Existing `FileTree` component already renders `ProjectFile[]` as a tree. Enhance it:

- **"Add file" button** in tree header (opens file picker rooted at project folder)
- **Drag & drop** onto the tree or app window → adds to `project.files[]` → saves settings
- **Right-click context menu:**
  - "Remove from project" (removes from settings, keeps file on disk)
  - "Delete file" (deletes + removes from settings)
  - "Open in editor" (opens as tab)
- **Schema.ts** shown as a pinned special entry at the bottom with gear icon
- Click on any file → opens as editor tab

### F4: Wizard — file discovery step + schema.ts selection

Current wizard: 4 steps (Intro → Name & Location → Connections → Options).
New wizard: 5 steps (Intro → Name & Location → Connections → **Files & Schema** → Review).

**Step 4 — Files & Schema** (NEW, replaces part of current Options):

1. **One-time scan** of selected folder for `.dbsp`, `.assert.dbsp`, `.sql` files
   - Results shown as checkbox list, all checked by default
   - User unchecks files they don't want in the project
   - This is a ONE-TIME scan, not a persistent watcher
   - Scan uses try/catch per directory (resilient to permission errors)

2. **Schema.ts** — radio buttons:
   - "Select existing file" → file picker (rooted at project folder)
   - "Generate from database" → introspect first connection (current behavior)
   - "Skip for now" → no schema.ts

**Step 5 — Review** (simplified current Options):
- Summary only: name, folder, connections count, files count, schema.ts path
- No more "generate schema" checkbox (moved to step 4)

### F5: Save dialog rooted at project + out-of-root warnings

**Save As behavior in project mode:**
- File dialog opens at project root folder by default
- If user saves within project root → file auto-added to `project.files[]`
- If user saves outside project root → file is NOT added, but:
  - Warning icon (⚠️) on the editor tab
  - Tooltip: "This file is outside the project folder. Save it within {projectRoot} to include it in the project."

**Standalone mode with open files → "Save as Project":**
- Files already saved within the chosen project root → auto-added to `project.files[]`
- Unsaved tabs or files outside root → warning icon on tab
- No blocking — user can save them to the right location later

## Technical Considerations

**Existing infrastructure to leverage:**
- `FileTree` component already renders project files as a tree
- `Sidebar` already has a Files section (currently stacked, will become tabbed)
- `writeSettings()` already persists `dbsp.settings.json`
- `WizardOptionsStep` already handles schema.ts generation
- `ProjectFile` type already has `path`, `name`, `isDirectory`, `children`

**Components to remove:**
- `discoverFiles()` from `project-store.ts`
- `shouldIncludeFile()` from `project-store.ts`
- `DEFAULT_INCLUDE`, `DEFAULT_EXCLUDE` from `settings.ts`
- `resolveProjectSettings()` include/exclude handling

**Components to modify:**
- `DbspProjectSettings` — add `files`, remove `include`/`exclude`
- `Sidebar` — stacked layout → tabbed layout
- `FileTree` — add header with "Add" button, context menu, drag & drop
- `NewProjectWizard` — 4 steps → 5 steps (insert Files & Schema step)
- `WizardOptionsStep` — becomes Review step (summary only)
- `project-store.ts` — `openFolder` reads `project.files[]` instead of calling `discoverFiles`
- `project-store.ts` — new actions: `addFile`, `removeFile`, `deleteFile`
- `App.tsx` — handle drag & drop events at window level

**Components to create:**
- `WizardFilesStep.tsx` — step 4: file scan + schema.ts radio
- Tab switcher UI in Sidebar (lightweight, not a full tab library)

**Constraints:**
- Must integrate with existing Tauri v2 plugin-fs and plugin-dialog
- File paths must be relative to project root (no absolute paths in settings)
- Must handle gracefully: files listed in settings but deleted from disk

## Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Drag & drop API differences across platforms | M | M | Use Tauri's drag & drop events (cross-platform) |
| Large projects with many files | L | L | `project.files[]` is explicit — user controls the count |
| Settings migration (existing projects with include/exclude) | M | H | Migration: run one-time scan, populate `files[]`, remove `include`/`exclude` |
| File deleted on disk but still in settings | L | M | Show "missing" indicator in tree, offer removal |

## Out of Scope

- File watcher for auto-detecting new files (explicit management only)
- Multi-root workspace (one root folder per project)
- File editing in the tree view (rename, move — use OS file manager)
- `.dbsp` + `.assert.dbsp` pairing enforcement (handled at execution time)

## Next Steps

→ Run `/workflow GUI-025` to spec and implement
→ Complexity: COMPLEX (5+ steps, multi-component, new wizard step, sidebar rework)
