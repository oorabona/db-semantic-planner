---
doc-meta:
  status: canonical
  scope: gui
  type: specification
  target_project: /mnt/wsl/shared/dev/db-semantic-planner
  created: 2026-02-25
  updated: 2026-02-25
  completed: 2026-02-25
  complexity: ENTERPRISE
  time-budget: 3h
---

# Specification: GUI-025 — Explicit Project File Management

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | `packages/gui` |
| Complexity | ENTERPRISE |
| Time budget | ~3h |
| Waves | 4 |
| Blocks | 10 |
| BDD scenarios | 28 |
| Risk level | HIGH (watcher + D&D + multi-root) |

## 1. Problem Statement

The GUI uses recursive directory walking (`discoverFiles`) to find project files. This is fragile (Tauri scope errors on forbidden paths), implicit (user has no control), and requires maintaining exclusion lists. Replace with explicit file tracking in `dbsp.settings.json`, enhanced tree view with pairing/D&D/rename, file watcher for live sync, and multi-root workspace support.

## 2. User Stories

### US-1: Explicit file control
AS A GUI user managing a dbsp project,
I WANT to explicitly control which files are in my project via settings,
SO THAT I avoid permission errors, know exactly what's tracked, and can add/remove files freely.

ACCEPTANCE: `project.files[]` in settings is the single source of truth. No directory walking.

### US-2: Live file sync
AS A GUI user editing files in both the GUI and external editors,
I WANT the project tree to reflect external changes automatically,
SO THAT I always see the current state without manual refresh.

ACCEPTANCE: File watcher detects external changes/deletions, configurable auto-reload or prompt.

### US-3: Multi-root workspace
AS A developer working on a monorepo with multiple dbsp subprojects,
I WANT to configure multiple root folders in one project,
SO THAT I can work across related packages without switching projects.

ACCEPTANCE: `project.roots[]` supports N roots, each rendered as a tree root node.

## 3. Business Rules

### 3.1 Invariants (always true)
- INV-01: All paths in `project.files[]` MUST be relative to project root (no absolute paths)
- INV-02: No path in settings may contain `..` (path traversal prevention)
- INV-03: File watcher MUST NOT follow symlinks (stat, not lstat)
- INV-04: Max 10 roots per project (soft limit, configurable)
- INV-05: Pairing applies only to `.dbsp` + `.assert.dbsp` (not `.sql`)
- INV-06: Symlinks are not supported as project file containers — paths containing symlinks may not receive watcher events
- INV-07: `validateDroppedFiles` MUST accept `roots[]` from the start (default `[projectDir]`) — not refactored in Block 10

### 3.2 Preconditions (required before action)
- PRE-01: Project mode active (folder opened with `dbsp.settings.json`)
- PRE-02: For drag & drop: files must be within project root or a declared root
- PRE-03: For rename: new name must not contain `/`, `\`, `..`

### 3.3 Effects (what changes)
- EFF-01: Adding a file → appends to `project.files[]` → saves `dbsp.settings.json`
- EFF-02: Removing a file → removes from `project.files[]` → saves settings (file stays on disk)
- EFF-03: Deleting a file → removes from disk AND from `project.files[]`
- EFF-04: Renaming a file → renames on disk + updates `project.files[]` + updates open editor tabs
- EFF-05: Moving a file → moves on disk + updates path in `project.files[]` + updates open tabs
- EFF-06: External deletion detected → "missing" indicator in tree + prompt for removal
- EFF-07: External modification detected → auto-reload (default) or prompt (configurable)

### 3.4 Error Handling
- ERR-01: When file added is outside all roots → reject with toast "File is outside project roots"
- ERR-02: When rename to existing name → error toast "File already exists"
- ERR-03: When watcher loses connection → silent retry with exponential backoff
- ERR-04: When migration scan encounters permission error → skip directory, continue scanning
- ERR-05: When `files[]` > 500 entries → warning in wizard/tree "Large project — consider splitting"

## 4. Technical Design

### 4.1 Architecture Decision

**Pure function extraction:** `buildPairedTree(files: string[]): PairedTreeNode[]` as a pure, testable function separate from React components. Tree rendering consumes the output.

**FileWatcher abstraction:** Interface `FileWatcher` with `watch(paths)` / `unwatch()` / `onChange(callback)`. Concrete implementation uses Tauri `watchImmediate` from `@tauri-apps/plugin-fs`. Mockable in tests.

**Wave delivery:** Each wave is independently deployable. Wave 1 (foundation) must land first, then W2-W4 can be parallelized.

### 4.2 Data Model Changes

| Entity | Change | Migration |
|--------|--------|-----------|
| `DbspProjectSettings` | Add `files: readonly string[]` | Yes (M1) |
| `DbspProjectSettings` | Add `roots?: readonly string[]` | No (optional) |
| `DbspProjectSettings` | Remove `include`, `exclude` | Yes (M1) |
| `ProjectFile` (type) | Add `paired?: boolean`, `pairFile?: string` | No |
| `UserSettings` | Add `fileWatcher: { mode: 'auto' \| 'prompt', debounceMs: number }` | No |
| `WizardStep` (type) | Expand from `0|1|2|3` to `0|1|2|3|4|5` | No |

### 4.3 New Interfaces

```typescript
// FileWatcher abstraction (F6)
interface FileWatcher {
  watch(paths: readonly string[]): Promise<void>;
  unwatch(): Promise<void>;
  onChange(callback: (events: FileEvent[]) => void): void;
}

type FileEvent = {
  type: 'create' | 'modify' | 'delete' | 'rename';
  path: string;
  oldPath?: string; // for rename
};

// Paired tree node (F9)
type PairedTreeNode = {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'pair';
  children?: PairedTreeNode[];
  pairPath?: string; // for type: 'pair', the .assert.dbsp path
  missing?: boolean; // file in settings but not on disk
};
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: Settings Schema (F1)

```gherkin
@priority:high @type:nominal
Scenario: SC-01 — Project loads files from settings
  Given a project with dbsp.settings.json containing files: ["a.dbsp", "b.sql"]
  When the project opens
  Then FileTree shows exactly 2 files: "a.dbsp" and "b.sql"
  And no directory walking occurs (discoverFiles not called)

@priority:high @type:nominal
Scenario: SC-02 — Adding file updates settings
  Given an open project with files: ["a.dbsp"]
  When user adds "b.dbsp" via file picker
  Then project.files becomes ["a.dbsp", "b.dbsp"]
  And dbsp.settings.json is saved to disk

@priority:medium @type:edge
Scenario: SC-03 — File in settings but missing on disk
  Given project.files contains "deleted.dbsp" which doesn't exist on disk
  When the project opens
  Then tree shows "deleted.dbsp" with a "missing" indicator
  And context menu offers "Remove from project"
```

### Scenario Group: Collapsible Sidebar (F2)

```gherkin
@priority:medium @type:nominal
Scenario: SC-04 — Collapse/expand sidebar section
  Given sidebar in project mode with "Project Files" expanded
  When user clicks the "Project Files" header
  Then the section collapses (files hidden, chevron points right)
  And "Database Schema" section expands to fill space

@priority:medium @type:nominal
Scenario: SC-05 — Standalone mode sidebar
  Given standalone mode (no project)
  When viewing sidebar
  Then only "Database Schema" section is visible
  And "Project Files" section is hidden
```

### Scenario Group: FileTree Actions (F3)

```gherkin
@priority:high @type:nominal
Scenario: SC-06 — Add file via picker
  Given an open project rooted at /home/user/myproject
  When user clicks "+" button in FileTree header
  Then file picker opens at /home/user/myproject
  And selected file is added to project.files[] (relative path)

@priority:high @type:nominal
Scenario: SC-07 — Context menu remove
  Given "queries/old.dbsp" in project
  When user right-clicks → "Remove from project"
  Then file removed from project.files[]
  And file still exists on disk

@priority:high @type:nominal
Scenario: SC-08 — Context menu delete
  Given "queries/old.dbsp" in project
  When user right-clicks → "Delete file"
  And confirms deletion dialog
  Then file removed from disk AND from project.files[]

@priority:high @type:nominal
Scenario: SC-09 — Drag files from OS
  Given an open project
  When user drags "new.dbsp" from OS file manager onto app window
  Then file is validated (extension check, within root check)
  And added to project.files[] with relative path
  And tree updates immediately

@priority:medium @type:edge
Scenario: SC-10 — Drag unsupported file type
  Given an open project
  When user drags "image.png" onto app window
  Then file is silently ignored (no error, no add)

@priority:medium @type:edge
Scenario: SC-11 — Drag file outside project root
  Given project rooted at /home/user/myproject
  When user drags /tmp/external.dbsp onto window
  Then toast: "File is outside project roots"
  And file is not added

@priority:medium @type:edge
Scenario: SC-12 — Drag duplicate file
  Given "a.dbsp" already in project.files[]
  When user drags "a.dbsp" again
  Then file is deduplicated (not added twice)
  And no error shown
```

### Scenario Group: Wizard Files & Schema (F4)

```gherkin
@priority:high @type:nominal
Scenario: SC-13 — Wizard step 3 scans for files
  Given wizard at step 3 "Files & Schema"
  And project folder contains queries/a.dbsp, queries/b.assert.dbsp, notes.txt
  When one-time scan completes
  Then checkbox list shows queries/a.dbsp (checked) and queries/b.assert.dbsp (checked)
  And notes.txt is not shown (not a supported extension)

@priority:high @type:nominal
Scenario: SC-14 — Wizard schema selection
  Given wizard step 3 with radio buttons
  When user selects "Select existing file"
  Then file picker opens at project folder
  And selected path is stored as schemaPath

@priority:medium @type:edge
Scenario: SC-15 — Wizard scan with permission error
  Given project folder contains .git/ (no read permission via Tauri)
  When scan runs
  Then .git/ is skipped (no crash)
  And other files are discovered normally
```

### Scenario Group: Save Dialog (F5)

```gherkin
@priority:medium @type:nominal
Scenario: SC-16 — Save As within project root
  Given project mode with root /home/user/myproject
  When user does Save As → selects /home/user/myproject/new.dbsp
  Then file is saved AND auto-added to project.files[]

@priority:medium @type:nominal
Scenario: SC-17 — Save As outside project root
  Given project mode with root /home/user/myproject
  When user does Save As → selects /tmp/external.dbsp
  Then file is saved BUT NOT added to project.files[]
  And editor tab shows warning icon (⚠️)
  And tooltip: "This file is outside the project folder"
```

### Scenario Group: File Watcher (F6)

```gherkin
@priority:high @type:nominal
Scenario: SC-18 — Auto-reload on external modification
  Given "a.dbsp" open in editor tab and watcher mode = "auto"
  When file is modified externally
  Then editor tab content reloads automatically
  And toast: "a.dbsp reloaded (external change)"

@priority:high @type:nominal
Scenario: SC-19 — Prompt on external modification
  Given watcher mode = "prompt" in preferences
  When "a.dbsp" is modified externally
  Then notification: "a.dbsp modified externally. Reload?"
  And buttons: [Reload] [Ignore]

@priority:high @type:nominal
Scenario: SC-20 — External file deletion
  Given "a.dbsp" in project and open in tab
  When file is deleted externally
  Then tree shows "missing" indicator
  And editor tab shows "[deleted]" suffix
  And tab content remains editable (user can Save As)

@priority:medium @type:edge
Scenario: SC-21 — Watcher ignores self-triggered changes
  Given user saves "a.dbsp" from GUI editor
  When watcher detects the write event
  Then no reload prompt or auto-reload occurs (debounce filters self-writes)
```

### Scenario Group: Rename/Move (F8)

```gherkin
@priority:high @type:nominal
Scenario: SC-22 — F2 inline rename
  Given "old.dbsp" selected in FileTree
  When user presses F2
  Then filename becomes an editable input
  When user types "new.dbsp" and presses Enter
  Then file renamed on disk
  And project.files[] updated (old path → new path)
  And open editor tab updates its title

@priority:high @type:nominal
Scenario: SC-23 — Context menu rename
  Given "old.dbsp" in tree
  When right-click → "Rename"
  Then same inline rename behavior as F2

@priority:medium @type:edge
Scenario: SC-24 — Rename to existing name
  Given "a.dbsp" and "b.dbsp" both in project
  When user renames "a.dbsp" to "b.dbsp"
  Then error toast: "File already exists"
  And rename cancelled (original name preserved)

@priority:medium @type:nominal
Scenario: SC-25 — Drag file to different folder in tree
  Given "queries/a.dbsp" in project with directories visible
  When user drags "a.dbsp" to "reports/" folder in tree
  Then file moved on disk to "reports/a.dbsp"
  And project.files[] updated
  And open editor tab updates its path
```

### Scenario Group: Pairing (F9)

```gherkin
@priority:high @type:nominal
Scenario: SC-26 — Paired files shown as expandable node
  Given project.files contains "users.dbsp" AND "users.assert.dbsp"
  When tree renders
  Then "users.dbsp" appears as an expandable node (▶)
  When expanded
  Then shows 2 children: "users.dbsp" and "users.assert.dbsp"

@priority:high @type:nominal
Scenario: SC-27 — Single file shown as leaf
  Given project.files contains "users.dbsp" but NOT "users.assert.dbsp"
  When tree renders
  Then "users.dbsp" appears as a leaf (no expand arrow)

@priority:medium @type:nominal
Scenario: SC-28 — SQL file never paired
  Given project.files contains "report.sql" and "report.assert.dbsp"
  When tree renders
  Then "report.sql" appears as a leaf
  And "report.assert.dbsp" appears as a separate leaf
  And they are NOT grouped
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | ✓ | | | |
| SC-02 | ✓ | | | |
| SC-03 | | ✓ | | |
| SC-04 | ✓ | | | |
| SC-05 | ✓ | | | |
| SC-06 | ✓ | | | |
| SC-07 | ✓ | | | |
| SC-08 | ✓ | | | |
| SC-09 | ✓ | | | |
| SC-10 | | ✓ | | |
| SC-11 | | | | ✓ |
| SC-12 | | ✓ | | |
| SC-13 | ✓ | | | |
| SC-14 | ✓ | | | |
| SC-15 | | ✓ | | |
| SC-16 | ✓ | | | |
| SC-17 | | ✓ | | |
| SC-18 | ✓ | | | |
| SC-19 | ✓ | | | |
| SC-20 | | | ✓ | |
| SC-21 | | ✓ | | |
| SC-22 | ✓ | | | |
| SC-23 | ✓ | | | |
| SC-24 | | | ✓ | |
| SC-25 | ✓ | | | |
| SC-26 | ✓ | | | |
| SC-27 | ✓ | | | |
| SC-28 | | ✓ | | |

**Totals:** 16 nominal, 8 edge, 2 error, 1 security = 27 + 1 = 28 scenarios

## 6. Implementation Plan

### Wave 1 — Foundation

#### Block 1: Settings schema + migration — ~20 min
**Type:** Feature slice (data layer)
**Dependencies:** None
**Features:** F1, M1

**Files:**
- `packages/gui/src/lib/settings.ts` — Add `files: readonly string[]` and `roots?: readonly string[]` to `DbspProjectSettings`, remove `include`/`exclude`, remove `DEFAULT_INCLUDE`/`DEFAULT_EXCLUDE`
- `packages/gui/src/lib/settings-migration.ts` — NEW: `migrateSettings(settings, folderPath): Promise<DbspProjectSettings>` — one-time scan to populate `files[]`
- `packages/gui/src/stores/project-store.ts` — Remove `discoverFiles`, `shouldIncludeFile`, `matchesGlob`. Update `openFolder` to read `project.files[]` directly. Add `addFile`, `removeFile`, `deleteFile` actions.
- `packages/gui/src/lib/settings.test.ts` — Update existing tests for new schema
- `packages/gui/src/lib/settings-migration.test.ts` — NEW: migration logic tests

**Exit criteria:**
- [ ] `DbspProjectSettings` has `files[]`, no `include`/`exclude`
- [ ] `openFolder` reads from `files[]`, not `discoverFiles`
- [ ] Migration detects old format and converts
- [ ] `addFile`/`removeFile`/`deleteFile` store actions work
- [ ] All existing settings tests pass + new migration tests
- [ ] SC-01, SC-02, SC-03, SC-12 (partial) covered

#### Block 2: buildPairedTree pure function — ~15 min
**Type:** Feature slice (logic)
**Dependencies:** Block 1 (needs `files[]` schema)
**Features:** F9

**Files:**
- `packages/gui/src/lib/paired-tree.ts` — NEW: `buildPairedTree(files: string[]): PairedTreeNode[]` pure function
- `packages/gui/src/lib/paired-tree.test.ts` — NEW: snapshot tests for pairing logic

**Exit criteria:**
- [ ] `.dbsp` + `.assert.dbsp` grouped into pair nodes
- [ ] `.sql` files never paired
- [ ] Missing files marked with `missing: true`
- [ ] Directory structure preserved
- [ ] SC-26, SC-27, SC-28 covered via unit tests

#### Block 3: Collapsible sidebar + paired tree rendering — ~20 min
**Type:** Feature slice (UI)
**Dependencies:** Block 1, Block 2
**Features:** F2, F9 UI

**Files:**
- `packages/gui/src/components/layout/CollapsibleSection.tsx` — NEW: generic collapsible section component
- `packages/gui/src/components/layout/CollapsibleSection.test.tsx` — NEW: tests
- `packages/gui/src/components/layout/Sidebar.tsx` — Wrap sections in `CollapsibleSection`
- `packages/gui/src/components/schema/FileTree.tsx` — Consume `PairedTreeNode[]`, render pairs as expandable nodes
- `packages/gui/src/components/schema/FileTree.test.tsx` — Update for paired rendering

**Exit criteria:**
- [ ] Sidebar sections collapse/expand with chevron
- [ ] Standalone mode: only Schema section visible
- [ ] Paired files render as expandable nodes
- [ ] Single files render as leaves
- [ ] SC-04, SC-05, SC-26, SC-27 covered

### Wave 2 — CRUD Operations

#### Block 4: FileTree add button + context menu — ~25 min
**Type:** Feature slice (UI + store)
**Dependencies:** Block 1, Block 3
**Features:** F3 (partial)

**Files:**
- `packages/gui/src/components/schema/FileTree.tsx` — Add "+" button in header, right-click context menu (Remove, Delete, Open, Rename)
- `packages/gui/src/components/schema/FileTreeContextMenu.tsx` — NEW: context menu component
- `packages/gui/src/components/schema/FileTreeContextMenu.test.tsx` — NEW: tests
- `packages/gui/src/stores/project-store.ts` — Wire add/remove/delete to Tauri fs operations

**Exit criteria:**
- [ ] "+" button opens file picker at project root
- [ ] Context menu renders on right-click with 4 actions
- [ ] Remove removes from settings only
- [ ] Delete removes from disk + settings (with confirmation)
- [ ] SC-06, SC-07, SC-08 covered

#### Block 5: Drag & drop from OS — ~25 min
**Type:** Feature slice (UI + events)
**Dependencies:** Block 1, Block 4
**Features:** F3 (D&D)

**Files:**
- `packages/gui/src/App.tsx` — Add window-level `onDrop`/`onDragOver`/`onDragEnter` handlers
- `packages/gui/src/lib/drag-drop.ts` — NEW: `validateDroppedFiles(files, projectRoots): ValidatedFile[]` — extension check, root check, dedup
- `packages/gui/src/lib/drag-drop.test.ts` — NEW: validation logic tests
- `packages/gui/src/components/schema/FileTree.tsx` — Add drop zone visual indicator on tree

**Exit criteria:**
- [ ] Files dragged from OS onto window are validated and added
- [ ] Unsupported extensions silently ignored
- [ ] Files outside roots rejected with toast
- [ ] Duplicates deduplicated
- [ ] SC-09, SC-10, SC-11, SC-12 covered

#### Block 6: Wizard Files & Schema step — ~25 min
**Type:** Feature slice (UI)
**Dependencies:** Block 1
**Features:** F4

**Files:**
- `packages/gui/src/components/project/wizard-types.ts` — Expand `WizardStep` to `0|1|2|3|4|5`
- `packages/gui/src/components/project/WizardFilesStep.tsx` — NEW: file scan + checkbox list + schema.ts radio
- `packages/gui/src/components/project/WizardFilesStep.test.tsx` — NEW: tests
- `packages/gui/src/components/project/WizardReviewStep.tsx` — NEW: summary step
- `packages/gui/src/components/project/WizardReviewStep.test.tsx` — NEW: tests
- `packages/gui/src/components/project/NewProjectWizard.tsx` — Add steps 3 and 5 to router, update step indicators
- `packages/gui/src/components/project/useWizardState.ts` — Add `files`, `schemaSelection` to wizard state

**Exit criteria:**
- [ ] Wizard has 6 steps (0-5)
- [ ] Step 3 scans folder and shows checkbox list
- [ ] Schema.ts radio (Select / Generate / Skip) works
- [ ] Step 5 shows summary of all choices
- [ ] Scan handles permission errors gracefully
- [ ] SC-13, SC-14, SC-15 covered

#### Block 7: Save dialog project scoping — ~15 min
**Type:** Feature slice (UI)
**Dependencies:** Block 1
**Features:** F5

**Files:**
- `packages/gui/src/lib/file-io.ts` — Modify `saveFileAs` to accept `projectRoot?` param, auto-add to project when within root
- `packages/gui/src/stores/editor-store.ts` — Track out-of-root warning state per tab
- `packages/gui/src/components/editor/SqlEditor.tsx` — Show warning icon on out-of-root tabs
- `packages/gui/src/lib/file-io.test.ts` — Update tests

**Exit criteria:**
- [ ] Save As defaults to project root
- [ ] File saved within root auto-added to project.files[]
- [ ] File saved outside root gets warning icon + tooltip
- [ ] SC-16, SC-17 covered

### Wave 3 — Live Sync

#### Block 8: File watcher + preferences — ~30 min
**Type:** Feature slice (infra + UI)
**Dependencies:** Block 1
**Features:** F6

**Files:**
- `packages/gui/src/lib/file-watcher.ts` — NEW: `FileWatcher` interface + `TauriFileWatcher` implementation using `@tauri-apps/plugin-fs` `watchImmediate`
- `packages/gui/src/lib/file-watcher.test.ts` — NEW: tests with mock watcher
- `packages/gui/src/hooks/useFileWatcher.ts` — NEW: React hook that connects watcher to stores
- `packages/gui/src/stores/project-store.ts` — Handle watcher events (modify, delete, create)
- `packages/gui/src/stores/editor-store.ts` — Handle file reload/deletion for open tabs
- `packages/gui/src/stores/user-settings-store.ts` — Add `fileWatcher` preference
- `packages/gui/src/components/preferences/PreferencesPanel.tsx` — Add watcher mode toggle

**Exit criteria:**
- [ ] Watcher starts when project opens, stops when project closes
- [ ] External modification → auto-reload (default) or prompt
- [ ] External deletion → "missing" indicator + tab shows "[deleted]"
- [ ] Self-triggered writes debounced (no double-reload)
- [ ] Preferences toggle between auto/prompt
- [ ] SC-18, SC-19, SC-20, SC-21 covered

#### Block 9: Rename + move + tab lifecycle — ~25 min
**Type:** Feature slice (UI + fs)
**Dependencies:** Block 4 (context menu), Block 8 (watcher integration)
**Features:** F8

**Files:**
- `packages/gui/src/components/schema/FileTree.tsx` — Add inline rename (F2 key handler), drag-to-move within tree
- `packages/gui/src/lib/file-operations.ts` — NEW: `renameFile(oldPath, newPath)`, `moveFile(sourcePath, destDir)` with validation
- `packages/gui/src/lib/file-operations.test.ts` — NEW: validation + path logic tests
- `packages/gui/src/stores/project-store.ts` — `renameFile`, `moveFile` actions that update `files[]` + call fs
- `packages/gui/src/stores/editor-store.ts` — `updateTabPath(oldPath, newPath)` action

**Exit criteria:**
- [ ] F2 key activates inline rename
- [ ] Context menu "Rename" activates inline rename
- [ ] Rename updates disk + settings + open tabs
- [ ] Rename to existing name shows error
- [ ] Drag within tree moves file + updates all refs
- [ ] SC-22, SC-23, SC-24, SC-25 covered

### Wave 4 — Scale

#### Block 10: Multi-root workspace — ~25 min
**Type:** Feature slice (data + UI)
**Dependencies:** Block 1, Block 3, Block 8
**Features:** F7

**Files:**
- `packages/gui/src/lib/settings.ts` — `roots?: readonly string[]` field handling
- `packages/gui/src/stores/project-store.ts` — Multi-root file loading, per-root watcher management
- `packages/gui/src/components/schema/FileTree.tsx` — Render N root nodes
- `packages/gui/src/components/project/WizardFilesStep.tsx` — Multi-root selection in wizard
- `packages/gui/src/lib/paired-tree.ts` — Extend to accept `roots[]` and partition files

**Exit criteria:**
- [ ] `project.roots: ["packages/api", "packages/web"]` renders 2 root nodes
- [ ] Each root has its own watcher
- [ ] Files from different roots display under correct root
- [ ] Watcher lifecycle managed per-root (add/remove)
- [ ] AC-2, AC-15 covered

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~30 | Pure functions: buildPairedTree, validateDroppedFiles, migrateSettings, file-operations, drag-drop validation |
| Component | ~20 | React components: CollapsibleSection, FileTree, FileTreeContextMenu, WizardFilesStep, WizardReviewStep |
| Integration | ~10 | Store actions: addFile/removeFile/deleteFile, watcher→store, rename→tab lifecycle |
| E2E | 0 | Deferred (requires Tauri runtime) |

### Test Data Requirements
- **Fixtures:** Sample `dbsp.settings.json` files (old format with include/exclude, new format with files[])
- **Mocks:** `FileWatcher` mock, Tauri `plugin-fs` mock (readDir, rename, remove), Tauri `plugin-dialog` mock
- **Snapshot tests:** `buildPairedTree` output for various file combinations

### Key Testability Patterns
- `buildPairedTree` — Pure function, no deps. Test with snapshots.
- `validateDroppedFiles` — Pure function. Test extension/root/dedup logic.
- `migrateSettings` — Async but mockable (mock readDir). Test format detection + conversion.
- `FileWatcher` — Interface. Test via mock implementation in component/integration tests.
- Context menu actions — Test store actions independently, then wire tests via mocked stores.

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| File watcher performance on large dirs | H | M | Debounce 300ms, watch only roots, batch events |
| Multi-root + watcher = N watchers | H | M | Manage lifecycle per root, max 10 roots |
| D&D platform differences | M | M | Use Tauri cross-platform drag events, test on all platforms |
| Rename race condition (watcher fires during rename) | M | H | Self-write debounce, ignore events during active operations |
| Tab lifecycle complexity (rename/delete/move) | M | H | Central `updateTabPath` action, test each scenario |
| Settings file conflict (external edit + GUI edit) | M | L | Watcher detects settings changes → re-read |
| Cross-platform rename case sensitivity | M | M | On case-insensitive FS (Win/macOS), allow case-only renames by checking inode, not just name |
| Symlink in file path | L | L | Document: symlinks not supported, watcher may miss changes |

## 9. Definition of Done

- [ ] All 10 blocks implemented
- [ ] All 28 BDD scenarios have passing tests
- [ ] All tests pass (unit + component + integration)
- [ ] Lint clean (`pnpm biome check`)
- [ ] Typecheck clean (`pnpm tsc --noEmit`)
- [ ] No `discoverFiles`, `shouldIncludeFile`, `matchesGlob`, `DEFAULT_INCLUDE`, `DEFAULT_EXCLUDE` remain in codebase
- [ ] `dbsp.settings.json` migration works for existing projects
- [ ] Documentation updated (brief updated with final design decisions)
- [ ] /review clean (no blocking findings)
