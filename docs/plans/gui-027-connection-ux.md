---
doc-meta:
  status: canonical
  adversarial_applied: true
  scope: gui
  type: specification
  target_project: /mnt/wsl/shared/dev/db-semantic-planner
  created: 2026-02-26
  updated: 2026-02-26
  complexity: COMPLEX
  time-budget: 90min
---

# Specification: GUI-027 — Connection UX Redesign

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | gui |
| Complexity | COMPLEX |
| Time budget | ~90 min |
| Blocks | 5 |
| BDD scenarios | 19 |
| Risk level | MEDIUM |
| Brief | docs/briefs/gui-027-connection-ux.md |

## 1. Problem Statement

The connection UX is entirely dialog-driven and passive. `defaultConnection` is dead code, the sidebar CTA always opens the same dialog, the Preferences "databases" section is informational text, and there is no way to quickly switch connections from the status bar. Users must manually navigate to File > New Connection for every session.

## 2. User Stories

### US-1: Auto-connect on project open
AS A developer opening a project with a configured default connection,
I WANT the app to automatically connect to my database,
SO THAT I can start querying immediately without manual connection steps.

ACCEPTANCE: When `defaultConnection` is set and matches a saved profile, the app connects silently on project open.

### US-2: Quick-connect from sidebar
AS A developer exploring database schemas,
I WANT to see my saved connection profiles and quick-connect from the sidebar,
SO THAT I can switch connections without navigating menus or remembering credentials.

ACCEPTANCE: Sidebar shows profiles list with one-click connect, adapted to standalone vs project mode.

### US-3: Manage profiles from Preferences
AS A developer managing multiple database environments,
I WANT to view, edit, delete and set default connections from the Preferences dialog,
SO THAT I have a central place to manage all my connection profiles.

ACCEPTANCE: Preferences "databases" section provides full CRUD and "set as default" action.

### US-4: Quick-pick from status bar
AS A developer running queries,
I WANT to click the connection indicator in the status bar to switch profiles,
SO THAT I can change connections quickly without leaving the editor.

ACCEPTANCE: Clicking the status bar indicator opens a popover with profile list and quick-connect.

## 3. Business Rules

### 3.1 Invariants
- INV-01: Passwords are NEVER stored in `ConnectionProfile.config` (security by design)
- INV-02: At most one active connection at any time (multi-connection is v2)
- INV-03: Profile CRUD is optimistic in-memory + fire-and-forget SQLite (existing pattern)
- INV-04: `defaultConnection` is a string matching `ConnectionProfile.name` (not ID)
- INV-05: Profile names must be unique (enforced at UI level — `addProfile`/`updateProfile` reject duplicates)
- INV-06: At most one connect operation in-flight at any time; new connect cancels/awaits previous disconnect

### 3.2 Preconditions
- PRE-01: Auto-connect requires a project to be loaded (folderPath available)
- PRE-02: Auto-connect requires `defaultConnection` set in `dbsp.settings.json`
- PRE-03: Quick-connect requires profiles loaded from SQLite (loadProfiles completed)
- PRE-04: Auto-connect must wait for sidecar `status === 'ready'` (adversarial: race condition)
- PRE-05: Auto-connect aborted if project changes before connection completes (adversarial: stale connect)

### 3.3 Effects
- EFF-01: "Set as Default" writes `defaultConnection` to `dbsp.settings.json` via `writeSettings()`
- EFF-02: "Clear Default" removes `defaultConnection` field from settings
- EFF-03: Successful connection updates `ConnectionStatus`, triggers schema introspection
- EFF-04: Profile edit via dialog updates SQLite via `updateProfile()`
- EFF-05: Renaming a profile that is `defaultConnection` must also update the settings file (adversarial: desync)
- EFF-06: After any `writeSettings()` call, update in-memory `projectStore.settings` (watcher handles create/remove only, not content changes)

### 3.4 Error Handling
- ERR-01: Auto-connect auth failure → show PasswordPrompt (single retry with password)
- ERR-02: Auto-connect profile not found → toast warning, no error state
- ERR-03: Quick-connect auth failure → show PasswordPrompt
- ERR-04: Settings write failure → toast error, no crash
- ERR-05: Profile delete while active → disconnect first, then delete
- ERR-06: Delete button disabled while deletion in progress (adversarial: double-click guard)
- ERR-07: Auth failures detected by sidecar error `kind === 'auth'` (28000 SQLSTATE or "password authentication failed"); all other failures are non-auth → toast error, no PasswordPrompt

## 4. Technical Design

### 4.1 Architecture Decision

Extend existing components rather than replace them. New components: `PasswordPrompt`, `ProfileManager`, `ConnectionQuickPick`. Reuse `ConnectionDialog` for edit flows (not inline editing — deferred to v2).

### 4.1b Design Note: Shared ProfileListItem

Three surfaces render profile lists (sidebar, preferences, statusbar). Extract a shared `ProfileListItem` component to avoid duplication. Each surface composes it differently (sidebar: compact, preferences: full with actions, statusbar: minimal).

### 4.2 New Components

| Component | File | Purpose |
|-----------|------|---------|
| `PasswordPrompt` | `src/components/connection/PasswordPrompt.tsx` | Lightweight modal: profile name + password input + Connect/Cancel |
| `ProfileManager` | `src/components/preferences/ProfileManager.tsx` | Profile list with CRUD actions for Preferences databases section |
| `ConnectionQuickPick` | `src/components/connection/ConnectionQuickPick.tsx` | Popover profile list for status bar |
| `SidebarConnectionPanel` | `src/components/connection/SidebarConnectionPanel.tsx` | Profile list for sidebar (standalone + project mode) |
| `ProfileListItem` | `src/components/connection/ProfileListItem.tsx` | Shared profile row: name, env badge, host:port/db. Used by all 3 surfaces. |

### 4.3 Modified Components

| Component | File | Change |
|-----------|------|--------|
| `PreferencesDialog` | `src/components/preferences/PreferencesDialog.tsx` | Replace `DatabasesSection()` (L144-158) with `<ProfileManager>` |
| `SchemaTree` | `src/components/schema/SchemaTree.tsx` | Replace disconnected CTA with `<SidebarConnectionPanel>` |
| `ConnectionStatus` | `src/components/connection/ConnectionStatus.tsx` | Add `onClick` → open `<ConnectionQuickPick>` popover |
| `App.tsx` | `src/App.tsx` | Add auto-connect `useEffect` on project load |
| `Sidebar` | `src/components/layout/Sidebar.tsx` | Pass additional connection props to children |

### 4.4 Data Flow

```
Auto-connect flow:
  Project opens → projectStore.settings.defaultConnection
    → connectionStore.profiles.find(p => p.name === defaultConn)
    → connect(pgConfig(profile)) — no password
      → Success: setActive, introspect schema
      → Auth fail: show PasswordPrompt → retry with password
      → Profile not found: toast warning

Quick-connect flow (sidebar/statusbar):
  User clicks profile → connect(pgConfig(profile)) — no password
    → Success: setActive, introspect
    → Auth fail: show PasswordPrompt

Set default flow:
  ProfileManager "Set as Default" →
    readSettings(folderPath) → set defaultConnection → writeSettings(folderPath, settings)
```

### 4.5 API Contract

No new API endpoints. All operations use existing:
- `connect(params, profileId)` from `useConnection` hook
- `readSettings()` / `writeSettings()` from `settings.ts`
- `addProfile()` / `updateProfile()` / `removeProfile()` from `connection-store`

## 5. Acceptance Criteria (BDD)

### Scenario Group: Auto-connect (F1)

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Auto-connect with valid default connection
  Given a project is loaded with defaultConnection = "dev-local"
  And a profile named "dev-local" exists in connection_profiles
  And the profile uses trust authentication (no password needed)
  When the project settings finish loading
  Then the app connects to the profile's database automatically
  And the schema tree shows the introspected schema

@priority:high @type:edge
Scenario: SC-02 Auto-connect with password required
  Given a project is loaded with defaultConnection = "dev-local"
  And a profile named "dev-local" exists
  And the database requires password authentication
  When auto-connect attempts without password
  Then the PasswordPrompt modal appears with profile name "dev-local"
  When the user enters a valid password and clicks Connect
  Then the connection succeeds and schema loads

@priority:medium @type:edge
Scenario: SC-03 Auto-connect with missing profile
  Given a project is loaded with defaultConnection = "staging"
  And no profile named "staging" exists
  When the project settings finish loading
  Then a toast warning appears: "Default connection 'staging' not found"
  And the connection status remains "disconnected"

@priority:medium @type:edge
Scenario: SC-04 Auto-connect with no defaultConnection
  Given a project is loaded without a defaultConnection field
  When the project settings finish loading
  Then no auto-connect is attempted
  And the connection status remains "disconnected"

@priority:low @type:error
Scenario: SC-05 Auto-connect password prompt cancelled
  Given a project triggers auto-connect requiring a password
  When the PasswordPrompt appears and the user clicks Cancel
  Then the connection status remains "disconnected"
  And no error toast is shown
```

### Scenario Group: Sidebar Connection Panel (F2)

```gherkin
@priority:high @type:nominal
Scenario: SC-06 Sidebar shows profiles in standalone mode
  Given the app is running without a project (standalone)
  And 2 connection profiles exist ("dev-local", "prod-readonly")
  When the sidebar schema section renders
  Then a profile list shows both profiles with name, host:port/database
  And a "New Connection..." button appears at the bottom

@priority:high @type:nominal
Scenario: SC-07 Quick-connect from sidebar
  Given the sidebar shows profiles
  When the user clicks on "dev-local" profile
  Then the app attempts connection without password
  And on success, the profile shows a connected indicator

@priority:medium @type:nominal
Scenario: SC-08 Sidebar in project mode shows default badge
  Given a project is loaded with defaultConnection = "dev-local"
  And 3 profiles exist
  When the sidebar renders
  Then "dev-local" profile shows a star/default badge
  And profiles are sorted: default first, then by lastUsedAt desc (null last), tie-break by name asc

@priority:medium @type:edge
Scenario: SC-09 Sidebar with no profiles
  Given no connection profiles exist
  When the sidebar schema section renders
  Then the disconnected CTA shows "Connect to a database" with a "New Connection..." button
```

### Scenario Group: Profile Manager (F3)

```gherkin
@priority:high @type:nominal
Scenario: SC-10 Profile list in Preferences
  Given 3 profiles exist with different environments
  When the user opens Preferences > Databases
  Then all profiles are listed with name, type badge, host:port/database, environment, lastUsedAt
  And the default profile shows a star icon

@priority:high @type:nominal
Scenario: SC-11 Edit profile via dialog
  Given profiles are listed in Preferences
  When the user clicks "Edit" on a profile
  Then the ConnectionDialog opens pre-filled with that profile's data
  When the user changes the host and clicks Save
  Then the profile is updated in connection-store (SQLite)

@priority:high @type:nominal
Scenario: SC-12 Set as default connection
  Given profiles are listed in Preferences
  And the project has a folderPath
  When the user clicks "Set as Default" on "prod-readonly"
  Then defaultConnection is written to dbsp.settings.json as "prod-readonly"
  And the star icon moves to "prod-readonly"

@priority:medium @type:nominal
Scenario: SC-13 Delete profile
  Given profiles are listed in Preferences
  When the user clicks Delete on an inactive profile
  Then a confirmation dialog appears
  When confirmed, the profile is removed from the list and SQLite

@priority:medium @type:error
Scenario: SC-14 Delete active profile
  Given "dev-local" is the currently connected profile
  When the user clicks Delete on "dev-local"
  Then the app disconnects first
  Then the profile is deleted
  And connection status shows "disconnected"
```

### Scenario Group: Statusbar Quick-Pick (F4)

```gherkin
@priority:high @type:nominal
Scenario: SC-15 Open quick-pick from status bar
  Given the status bar shows "Connected to mydb @ localhost"
  When the user clicks on the connection indicator
  Then a popover appears with all profiles
  And the active profile shows a checkmark

@priority:medium @type:nominal
Scenario: SC-16 Switch connection via quick-pick
  Given the quick-pick popover is open
  And "dev-local" is active
  When the user clicks "prod-readonly"
  Then the app disconnects from "dev-local"
  And connects to "prod-readonly" (with password prompt if needed)
  And the status bar updates
```

### Scenario Group: Adversarial Edge Cases

```gherkin
@priority:medium @type:edge @source:adversarial
Scenario: SC-17 Rename default profile updates settings
  Given "dev-local" is set as defaultConnection in dbsp.settings.json
  When the user renames the profile from "dev-local" to "local-dev" in ProfileManager
  Then defaultConnection is updated to "local-dev" in dbsp.settings.json

@priority:medium @type:edge @source:adversarial
Scenario: SC-18 Auto-connect waits for sidecar ready
  Given a project is loaded with defaultConnection = "dev-local"
  And the sidecar is still starting (status = "spawning")
  When sidecar transitions to "ready"
  Then auto-connect triggers
  And the connection succeeds

@priority:medium @type:error @source:llm-review
Scenario: SC-19 Non-auth connection failure shows toast, not password prompt
  Given the user clicks a profile to quick-connect
  And the database host is unreachable (DNS/network error)
  When the connection attempt fails with a non-auth error
  Then a toast error appears with the failure message
  And the PasswordPrompt does NOT appear
  And the connection status shows "disconnected"
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | x | | | |
| SC-02 | | x | | |
| SC-03 | | x | | |
| SC-04 | | x | | |
| SC-05 | | | x | |
| SC-06 | x | | | |
| SC-07 | x | | | |
| SC-08 | x | | | |
| SC-09 | | x | | |
| SC-10 | x | | | |
| SC-11 | x | | | |
| SC-12 | x | | | |
| SC-13 | x | | | |
| SC-14 | | | x | |
| SC-15 | x | | | |
| SC-16 | x | | | |
| SC-17 | | x | | |
| SC-18 | | x | | |
| SC-19 | | | x | |

## 6. Implementation Plan

### Block 1: PasswordPrompt component + useAutoConnect hook — ~15 min
**Type:** Feature slice
**Dependencies:** None
**Files:**
- `src/components/connection/PasswordPrompt.tsx` — NEW: lightweight modal (profile name + password + Connect/Cancel)
- `src/components/connection/PasswordPrompt.test.tsx` — NEW: render tests
- `src/hooks/useAutoConnect.ts` — NEW: hook that reads defaultConnection from project settings, finds profile, attempts connect, shows PasswordPrompt on auth fail
- `src/hooks/useAutoConnect.test.ts` — NEW: unit tests for the hook logic
- `src/hooks/useConnectFlow.ts` — NEW: shared connect-with-prompt logic (attempt without password → PasswordPrompt on auth fail → retry). Consumed by useAutoConnect, SidebarConnectionPanel, ConnectionQuickPick.
- `src/hooks/useConnectFlow.test.ts` — NEW: unit tests for connect flow
- `src/components/connection/ProfileListItem.tsx` — NEW: shared profile row (name, env badge, host:port/db)
- `src/components/connection/ProfileListItem.test.tsx` — NEW: render tests

**Exit criteria:**
- [ ] PasswordPrompt renders with profile name, password input, Connect/Cancel buttons
- [ ] useAutoConnect resolves defaultConnection → profile → connect attempt
- [ ] Auth failure triggers PasswordPrompt
- [ ] Cancel dismisses without error
- [ ] Missing profile produces toast warning
- [ ] No defaultConnection = no action

### Block 2: SidebarConnectionPanel + sidebar integration — ~20 min
**Type:** Feature slice
**Dependencies:** Block 1 (PasswordPrompt for quick-connect auth failures)
**Files:**
- `src/components/connection/SidebarConnectionPanel.tsx` — NEW: profile list for sidebar
- `src/components/connection/SidebarConnectionPanel.test.tsx` — NEW: render tests
- `src/components/schema/SchemaTree.tsx` — MODIFY: render SidebarConnectionPanel when disconnected (replace current CTA)
- `src/components/layout/Sidebar.tsx` — MODIFY: pass connection-related props

**Exit criteria:**
- [ ] Profiles listed with name, environment badge, host:port/database
- [ ] Active profile highlighted with connected indicator
- [ ] Click profile → quick-connect (no password attempt → PasswordPrompt on auth fail)
- [ ] "New Connection..." button at bottom opens ConnectionDialog
- [ ] Default profile marked with star in project mode
- [ ] Empty state shows "No connections" + "New Connection..." button

### Block 3: ProfileManager in Preferences — ~20 min
**Type:** Feature slice
**Dependencies:** Block 1 (PasswordPrompt), Block 2 (SidebarConnectionPanel for shared profile rendering pattern)
**Files:**
- `src/components/preferences/ProfileManager.tsx` — NEW: CRUD profile list
- `src/components/preferences/ProfileManager.test.tsx` — NEW: render + interaction tests
- `src/components/preferences/PreferencesDialog.tsx` — MODIFY: replace DatabasesSection (L144-158) with ProfileManager

**Exit criteria:**
- [ ] Profiles listed with name, type badge, host:port/database, environment, lastUsedAt
- [ ] Edit → opens ConnectionDialog pre-filled → saves via updateProfile
- [ ] Delete → confirmation → removeProfile (disconnects if active)
- [ ] "Set as Default" → writes defaultConnection to dbsp.settings.json
- [ ] "Clear Default" → removes defaultConnection field
- [ ] "Add Profile" button → opens ConnectionDialog in create mode
- [ ] Default profile shows star icon

### Block 4: ConnectionQuickPick in status bar — ~15 min
**Type:** Feature slice
**Dependencies:** Block 1 (PasswordPrompt), Block 2 (shared quick-connect logic)
**Files:**
- `src/components/connection/ConnectionQuickPick.tsx` — NEW: popover with profile list
- `src/components/connection/ConnectionQuickPick.test.tsx` — NEW: render tests
- `src/components/connection/ConnectionStatus.tsx` — MODIFY: wrap with clickable trigger for popover

**Exit criteria:**
- [ ] Click connection indicator → popover opens with all profiles
- [ ] Active profile has checkmark
- [ ] Click profile → disconnect current + connect new (with PasswordPrompt if needed)
- [ ] "Disconnect" option when connected
- [ ] "New Connection..." at bottom

### Block 5: Auto-connect wiring in App.tsx + integration tests — ~20 min
**Type:** Integration slice
**Dependencies:** Blocks 1-4
**Files:**
- `src/App.tsx` — MODIFY: wire `useAutoConnect` hook after project load
- `src/hooks/useAutoConnect.ts` — MODIFY: finalize integration with actual connect flow
- Integration tests for the full auto-connect → PasswordPrompt → connected flow

**Exit criteria:**
- [ ] Project open triggers auto-connect when defaultConnection is set
- [ ] Full flow works: settings → profile lookup → connect → password prompt → connected
- [ ] All 18 BDD scenarios covered by tests
- [ ] All existing tests still pass

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~20 | Component rendering, hook logic, store actions |
| Integration | ~8 | Auto-connect flow, profile CRUD + settings write |
| E2E | 0 | Deferred (requires sidecar + real DB) |

### Test Data

- Mock profiles: `dev-local` (PostgreSQL, localhost:5432/mydb), `prod-readonly` (PostgreSQL, prod-host:5432/maindb, readOnly), `staging` (PostgreSQL, staging:5432/appdb)
- Mock settings: `{ version: 1, defaultConnection: "dev-local", connections: [...] }`
- Mock connect: vi.fn() returning `{ connectionId: "conn-1", database: "mydb", schema: "public" }`

### Mocks Required

- `@tauri-apps/plugin-dialog` (ask) for delete confirmation
- `useConnection` hook (connect, disconnect, testConnection)
- `connection-store` (profiles, addProfile, updateProfile, removeProfile)
- `settings.ts` (readSettings, writeSettings)
- `toast` for notification assertions

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Password prompt fatigue (no keychain) | M | H | GUI-028 follow-up, clear "remember" messaging |
| Auto-connect race with sidecar startup | M | M | Wait for sidecar `ready` before auto-connect |
| Settings file conflict (external edit + UI write) | L | L | Settings watcher detects changes, ConcurrentEditBanner exists |
| Profile edit while connected | M | M | Warn user, disconnect if config changed |

## 9. Definition of Done

- [ ] All 18 BDD scenarios have passing tests
- [ ] `defaultConnection` triggers auto-connect on project open
- [ ] Sidebar shows profile list with quick-connect
- [ ] Preferences "databases" section provides full CRUD
- [ ] Status bar click opens quick-pick popover
- [ ] PasswordPrompt handles auth failures gracefully
- [ ] All existing tests pass (1087+)
- [ ] Typecheck clean
- [ ] Lint clean
