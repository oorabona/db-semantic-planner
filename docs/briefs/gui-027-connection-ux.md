---
doc-meta:
  status: draft
  scope: gui
  type: ideation-brief
  created: 2026-02-26
  updated: 2026-02-26
---

# GUI-027 — Connection UX Redesign

## Problem Statement

**Problem:** The connection UX is entirely dialog-driven and passive. There is no auto-connect on project open, the sidebar CTA always opens the same dialog regardless of context, the preferences "databases" section is informational-only text, and `defaultConnection` in `DbspSettings` is dead code.

**Root cause:** Connection was treated as an isolated one-time setup action during MVP, not as an integral part of the project workflow. The focus was "can connect" rather than "seamless connection experience".

**Target users:** Developer using the GUI to explore schemas, edit SQL/NQL, and run queries against PostgreSQL databases.

**Current solutions and gaps:**
- `ConnectionDialog` is the sole entry point for create/connect (no quick-connect)
- Profiles persist in SQLite but are not manageable through UI (only via dialog or JSON)
- `defaultConnection: string | undefined` exists in `DbspSettings` but is never read
- Sidebar "Connect" CTA opens the same dialog in both standalone and project mode
- Preferences "databases" section says "Use File > New Connection (⌘N)" — not actionable

## Proposed Solution

**Approach:** Four complementary features that transform connection from a one-shot dialog action into an integrated workflow:

1. **Auto-connect** — wire `defaultConnection` to project open
2. **Sidebar connection panel** — context-aware profile list replacing the static CTA
3. **Profile manager in Preferences** — full CRUD replacing the passive text
4. **Statusbar quick-pick** — click connection indicator to switch profiles

**Why this approach:** Each feature addresses a distinct pain point. Combined, they provide a cohesive connection experience from launch to daily use. Multi-connection per tab deferred to v2 (requires tab-level connection routing, significant complexity).

## Key Features

### F1: Auto-connect on project open (MVP)

When a project is loaded and `defaultConnection` is set in `dbsp.settings.json`:
1. Resolve the connection profile by name from `connection_profiles` SQLite table
2. Attempt connection WITHOUT password (supports trust auth, `.pgpass`, peer auth)
3. If auth failure → show mini password prompt (small dialog: profile name + password field + Connect button)
4. If connection succeeds → set active, introspect schema, populate sidebar
5. If no `defaultConnection` or profile not found → no auto-connect (silent, no error)

**Technical notes:**
- `defaultConnection` is a string matching `ConnectionProfile.name`
- Password is NOT stored in profiles (intentional security decision)
- GUI-028 (keychain via `store://` URI) will make auto-connect seamless later
- Mini password prompt is a lightweight modal, not the full ConnectionDialog

### F2: Sidebar connection panel (MVP)

Replace the static "Connect" CTA in the Schema section with a context-aware panel:

**Standalone mode (no project):**
- List saved profiles (from `connection_profiles` SQLite)
- Each profile row: name, environment badge (dev/staging/prod), host:port/database
- Click profile → quick-connect (attempt without password, mini-prompt if needed)
- Active profile highlighted with connected indicator
- "Disconnect" action on active profile
- "New Connection..." button at bottom → opens ConnectionDialog

**Project mode:**
- Same as standalone, but filtered/prioritized:
  - Project connections (from `dbsp.settings.json connections[]`) shown first
  - Default connection marked with star/badge
  - Other saved profiles shown below separator
- "Set as Default" context action on profiles

**Design:** Compact list, similar to VS Code's Source Control panel. Not a full page — fits in the sidebar section.

### F3: Profile manager in Preferences (MVP)

Replace the passive "databases" text section with a full profile manager:

**List view:**
- All profiles from `connection_profiles` SQLite table
- Columns: Name, Type (PostgreSQL badge), Host:Port/Database, Environment, Last Used
- Sort by last used (most recent first)

**Actions per profile:**
- **Edit** → opens ConnectionDialog pre-filled with profile data (MVP). Inline edit form in v2.
- **Delete** → confirm dialog, remove from SQLite
- **Duplicate** → create copy with "(copy)" suffix
- **Set as Default** → writes profile name to `defaultConnection` in `dbsp.settings.json`

**Header actions:**
- "Add Profile" button → opens ConnectionDialog in save-only mode

**Default connection indicator:**
- Profile matching `defaultConnection` shows a star icon
- "Set as Default" / "Clear Default" toggle

### F4: Statusbar quick-pick (MVP)

Enhance the existing `ConnectionStatus` component in the bottom status bar:

**Current:** Shows "Disconnected" / "Connected to host:port/database" — read-only.

**New behavior:**
- Click on connection indicator → popover/dropdown
- Shows all profiles (same as sidebar panel, compact format)
- Quick-connect on click (attempt without password → mini-prompt if needed)
- Active profile checked/highlighted
- "Disconnect" option when connected
- "New Connection..." at bottom
- Keyboard shortcut: `Ctrl+Shift+C` or configurable

**Design:** Similar to VS Code's language/encoding selector in status bar — popover with list.

### Deferred to v2

- **Multi-connection per tab** — each editor tab targets a different connection
- **Inline profile editing** in preferences (v1 uses ConnectionDialog)
- **Connection groups** — organize profiles by project/team

## Technical Considerations

### Password handling (pre-GUI-028)

Passwords are NOT stored in `ConnectionProfile.config` (security decision). Strategy:
1. Quick-connect and auto-connect attempt connection without password
2. If auth failure → mini password prompt (profile name + password input + Connect)
3. GUI-028 will add `store://` URI support via Tauri plugin-store (OS keychain)
4. After GUI-028: auto-connect resolves `store://` → password from keychain → seamless

### Mini password prompt component

New lightweight dialog: `PasswordPrompt.tsx`
- Props: `profileName`, `onSubmit(password)`, `onCancel()`
- UI: profile name (read-only), password input (autofocus), Connect button
- Smaller than ConnectionDialog — just the password field

### Settings write for defaultConnection

When user sets a default via profile manager or sidebar:
- Read current `dbsp.settings.json`
- Set/update `defaultConnection` field
- Write back to file
- Settings watcher picks up the change

### Connection resolution flow

```
Project opens
  → Read dbsp.settings.json
  → defaultConnection = "dev-local"?
    → Find profile where name === "dev-local" in SQLite
    → Found? → resolveProfile(profile)
      → profile.type === 'postgresql'
      → extract host/port/database/user/schema/sslMode from config
      → connect(params, profileId) — no password
        → Success? → set active, introspect
        → Auth failure? → show PasswordPrompt
          → User enters password → retry connect
          → User cancels → stay disconnected (toast info)
    → Not found? → toast warning "Default connection 'dev-local' not found"
```

### Sidebar panel state

No new Zustand store needed. The sidebar panel reads from:
- `useConnectionStore` — profiles, active connection, status
- `useProjectStore` — current project settings (for defaultConnection, project connections)

### Constraints

- Must integrate with existing ConnectionDialog (reuse for edit flows)
- Profiles already in SQLite — no migration needed
- `defaultConnection` already in `DbspSettings` type — no schema change
- Password prompt must work without GUI-028 (keychain is a follow-up)

## Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Auto-connect with wrong password loops | M | L | Max 1 auto-attempt, then manual |
| Profile edit while connected | M | M | Warn, disconnect if config changed |
| Settings file conflict (external edit + UI write) | L | L | Settings watcher detects changes |
| Password prompt fatigue (no keychain) | M | H | GUI-028 follow-up, clear messaging |

## Implementation Sequence

Suggested order (each is independently shippable):

1. **F3: Profile manager** — foundation: makes profiles visible and manageable
2. **F2: Sidebar panel** — uses profile list, adds quick-connect
3. **F1: Auto-connect** — uses profile resolution from F2/F3
4. **F4: Statusbar quick-pick** — uses same profile list + connect logic

Password prompt component needed for F1/F2 — build as part of F2.

## Definition of Done

- [ ] `defaultConnection` in `dbsp.settings.json` triggers auto-connect on project open
- [ ] Sidebar shows profile list with quick-connect (standalone and project mode)
- [ ] Preferences "databases" section provides full profile CRUD
- [ ] Statusbar connection indicator opens quick-pick to switch profiles
- [ ] Mini password prompt for connections without stored password
- [ ] All existing tests pass, new features have test coverage

## Next Steps

→ Run `/workflow "GUI-027"` (plan-provided mode) to implement
→ After GUI-027: implement GUI-028 (keychain via `store://` URI) for seamless auto-connect
→ v2: multi-connection per tab routing
