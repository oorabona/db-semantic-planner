# Playground redesign — design

**Date:** 2026-05-05
**Author:** brainstorm session
**Status:** Approved by user, pending implementation plan
**Scope:** `packages/docs/.vitepress/theme/Playground.vue` and `/playground.md`

## Why

The current Playground page packs four densely-stacked surfaces (NQL textarea, schema model with diagram + TS tabs, output with SQL/Params/Plan tabs, plus several Copy buttons) and feels cluttered. A fresh visitor's eye has no clear focal point, the differentiator (Plan tab) is buried behind a tab default-set to SQL, and the schema model dominates above-the-fold real estate that should belong to the magic moment (intent → SQL + Plan).

This redesign reframes the Playground as a *demo-first* surface optimised for the visitor who lands fresh and decides whether to engage in 10 seconds. Schema becomes context (collapsed top); query and the structured Plan become the headline. URL-hash persistence makes individual queries shareable.

## Goals

1. **Above-the-fold differentiator.** The visitor sees a pre-compiled example with the structured Plan rendered as the hero output, within ~1s of page load.
2. **Schema demoted but accessible.** A 32-px sticky bar at the top with table count and an `Edit ↗` toggle. Expanding reveals today's full editor (DSL + Mermaid diagram + generated TS).
3. **Mobile-first vertical flow.** Schema bar → Query → Plan cards → SQL/Params. Same order on every viewport; no responsive reflow that breaks the story.
4. **URL-hash sharing.** A query authored in the playground is shareable via the URL. CompressionStream native baseline.
5. **Component-oriented internals.** Split the current 1500+ LoC monolith into focused sub-components even when they all live in `Playground.vue`, so a future embeddable variant can be extracted cleanly.

## Non-goals

- Embeddable `<PlaygroundLite>` for guides. Tracked as a separate issue; out of v1 scope.
- ORM TypeScript editor mode (T3). Wire the toggle into the layout but the TS path is a separate PR.
- localStorage persistence. URL hash is the single source of restore truth.
- Schema designer page (`/schema-designer`). Schema editing stays inside the playground container.
- Custom-schema sharing for >5KB DSL. CompressionStream tops out around URL limits at ~5–6KB compressed; oversize schemas degrade to "URL hash silently dropped, default loaded" with a top banner explaining why. node-liblzma upgrade tracked as future work.

## User journey

| Step | What the user does | What the page shows |
|---|---|---|
| Land on `/playground` (no hash) | nothing | Schema bar collapsed at top · query area pre-filled with first example · Plan cards hero already rendered · SQL/Params sub-panel filled |
| Click an example | dropdown change | Same query area updates, auto-compile re-runs (debounced once on next tick), Plan cards re-render |
| Edit the NQL textarea | typing | Auto-compile after 300ms; collapse state on existing decision cards is preserved (per-decision structural signature tracker) |
| Click `Copy SQL` | button | Clipboard receives the raw SQL; button shows `Copied` for 2s |
| Click `▾ Schema · Edit ↗` | bar click | Schema section expands inline (DSL + Mermaid + TS tabs as today). User edits DSL → debounced 500ms → schema rebuild → auto-compile of current NQL |
| Click `Reset` next to `Edit ↗` | button | `window.location.assign(window.location.pathname)` — drops URL hash, reloads, default state |
| Land on a hash-shared link | URL hash present | Hash decoded → schema/query/mode applied → mount completes → auto-compile fires; visitor sees the same state as the link author |
| Hash decode fails (corrupt / no CompressionStream / module load fail) | nothing | Sticky top banner with severity-tinted background; inline action buttons (`Reset URL`, `Got it`, or `Reload` for fatal); default state loaded underneath |

## Anatomy

```
┌─ Playground container ─────────────────────────────────────┐
│ <ErrorBanner sticky-top v-if="errorBanner" />              │
│                                                            │
│ <SchemaSection collapsed-by-default>                       │
│   ▾ Schema · 6 tables · users · posts · …    [Reset] [Edit]│
│   (expanded body: DSL editor + Diagram tab + TS tab)       │
│ </SchemaSection>                                           │
│                                                            │
│ <QuerySection>                                             │
│   Mode toggle: [NQL] [TypeScript]                          │
│   Examples dropdown (filters by available tables)          │
│   Textarea (auto-compile, Ctrl/Cmd+Enter, Compile button)  │
│ </QuerySection>                                            │
│                                                            │
│ <PlanSection> ← hero, no tab, always visible when result   │
│   <PlanMetaStrip /> root · planning time · relations · …   │
│   <PlanWarnings v-if /> (one card per warning)             │
│   <PlanCtes v-if /> (one card per CTE, recursive flag)     │
│   <PlanDecisions /> (collapsible cards, structural sig)    │
│ </PlanSection>                                             │
│                                                            │
│ <OutputSection> ← SQL/Params sub-tabs, Copy button         │
│   [SQL][Parameters]                              [Copy]    │
│   <pre><code>compiled SQL</code></pre>                     │
│ </OutputSection>                                           │
└────────────────────────────────────────────────────────────┘
```

All sections except `<ErrorBanner>` are vertically stacked, no responsive layout switches. `<ErrorBanner>` uses `position: sticky; top: 0` so it pins inside the playground card on scroll without occluding VitePress nav.

## State machine — initialisation

```
isInitializing: ref(true)
errorBanner: ref<ErrorBanner | null>(null)

onMounted async:
  1. Hash inspection + decode (whole step is awaited):
     - If no `#h=` hash → restored = null (default state).
     - If hash present but `'CompressionStream' in window === false`
         → errorBanner = warn-cas-4 ; restored = null.
     - Else `await decodeHash(rawHash)` (async because DecompressionStream
       processes via stream pipes):
         → on success: restored = { schema, nql, mode }, apply to refs.
         → on any throw (corrupt payload, JSON parse fail, schema-type
           mismatch): errorBanner = warn-cas-3 ; restored = null.
  2. Promise.all([import('@dbsp/core'), import('@dbsp/adapter-pgsql'), import('mermaid')])
       on rejection → errorBanner = fatal-cas-6 ; isInitializing = false ; return
  3. await rebuildOrm(schemaDsl.value)
       schemaError set internally if parse fails — keep going so the
       inline schema-error banner shows, but skip auto-compile in step 4.
  4. if (!schemaError && nqlTag && nqlCode.trim()):
       cancel any nqlDebounceTimer the user's mid-load typing scheduled
       performCompile({ resetTab: false })
  5. isInitializing = false
```

Visual states for the output area, in priority order:

| Condition | Render |
|---|---|
| `errorBanner.severity === 'fatal'` | banner (top), output-panel hidden |
| `isInitializing` | shimmer skeleton "Loading playground…" |
| `error` (compile error) | red error banner, native ORM message |
| `result` | Plan section + Output section |
| (default) | "Click Compile to see the output." placeholder |

## Decision-card collapse-state preservation

A `Map<id, signature>` tracker preserves the user's collapse choices across content-only edits and additive plan changes, while resetting cleanly when the planner reuses a per-plan-counter id for a structurally-different decision. Signature key per decision: `type:sourceTable:target:relationPath:includeAlias:joinType:choice`. Empty `decisions` (transient compile error) skips the watcher entirely so an in-flight error doesn't wipe state.

This logic ships in `Playground.vue` today (commits `cf14b48` + later) — the redesign keeps it as-is and just relocates the watcher into `<PlanDecisions>`.

## URL hash format

```
#h=<base64url(gzip(JSON.stringify({ s: schema, n: nql, m: 'nql'|'ts' })))>
```

- `h=` prefix is a forward-compat marker (future v2 might add `?l=lzma` for node-liblzma payloads).
- Compression: `CompressionStream('gzip')`, native, no library dependency.
- Encoding: base64url (RFC 4648 §5) — replace `+/` with `-_`, strip trailing `=`.
- Decode: symmetric, with try/catch on every step. Any failure → `errorBanner = warn-cas-3`, default state loaded.
- Browser missing `CompressionStream` → detect with `'CompressionStream' in window`. Hash is silently dropped, banner explains.

Encode trigger: debounced 500ms on schema/nql/mode change. Avoids flooding URL bar updates while typing. Uses `history.replaceState`, not `pushState`, so back-button doesn't traverse keystrokes.

## Error banner — single component, severity-aware

```ts
type ErrorBanner = {
  severity: 'warn' | 'fatal';
  title: string;
  message: string;
  actions: Array<{ label: string; handler: () => void }>;
};
```

Mapping cases → content:

| Case | Severity | Title | Message | Actions |
|---|---|---|---|---|
| Hash decode failure | `warn` | Couldn't restore the shared link | The URL hash is corrupt or from an older version. Loaded the default playground instead. | `Reset URL` · `Got it` |
| No CompressionStream + hash present | `warn` | Couldn't restore the shared link | This link needs `CompressionStream` (Firefox 113+, Safari 16.4+, Chrome 80+). Loaded the default state. | `Reset URL` · `Got it` |
| Module imports fail | `fatal` | Couldn't load the playground | A network issue prevented the playground modules from loading. | `Reload` · `Reset URL` |

Action handlers:

- `Reset URL` → `window.location.assign(window.location.pathname)`
- `Got it` → `errorBanner.value = null`
- `Reload` → `window.location.reload()`

Schema parse errors and NQL syntax errors stay in their existing inline banners (`schemaError` red bar inside the Schema section, `error` red `<pre>` inside the Output area). Only init-time anomalies surface in the top banner.

## Auto-compile semantics

| Trigger | resetTab | Notes |
|---|---|---|
| Mount complete (no schema-error) | false | Stay on whichever tab the URL hash specified (or SQL by default). |
| Compile button click | true | Manual gesture → reset tab to SQL. |
| Ctrl/Cmd+Enter | true | Same as button. |
| Example dropdown change | true | New context → reset tab. |
| NQL textarea change (300ms debounce) | false | Preserve user's tab choice while iterating. |
| Schema rebuild settles | false | Auto-recompile after schema changes; user's tab stays. |
| Manual compile queued during schema rebuild | true | Queued via `pendingManualCompile` flag; fires after rebuild settles. |

If a manual gesture races with a debounced compile, `compile()` cancels `nqlDebounceTimer` to prevent a duplicate fire 300ms later.

## Component decomposition (internal — same file for v1)

| Component | Responsibility | Inputs | Outputs |
|---|---|---|---|
| `<ErrorBanner>` | Sticky top init-error display | `data: ErrorBanner \| null` | `dismiss` event |
| `<SchemaSection>` | Collapsed bar + expandable editor (DSL/Diagram/TS) | `schemaDsl: ref<string>` | `Reset` and `Edit` events; emits change via `v-model:schemaDsl` |
| `<QuerySection>` | Mode toggle + example dropdown + textarea + Compile | `nqlCode: ref<string>`, `queryMode: ref<'nql'\|'ts'>`, `examples: visible[]` | `compile` (manual), `change` (auto-debounced) |
| `<PlanSection>` | Meta strip + warnings + CTEs + decisions cards | `result: Dump \| null` | (none) |
| `<PlanDecisions>` | Decision-card list with collapse state preservation | `decisions: PlanDecision[]` | (none) |
| `<OutputSection>` | SQL/Params sub-tabs + Copy buttons | `result: Dump \| null` | (none) |

These are extracted as separate `<script setup>` blocks or single-file-component sub-files, depending on what's tidier. The single-instance composition stays in `Playground.vue` for v1; the factoring just enables future extraction without a rewrite.

## Accessibility

- All buttons keep `type="button"`. Tab strip in `<OutputSection>` uses `<div role="group" aria-label="Output format">` and plain `<button>`s (matches current pattern).
- Decision-card disclosure buttons keep `aria-expanded` + `aria-controls="plan-decision-body-${d.id}"`. Body uses `v-show` so the controlled element exists in the DOM when the button references it.
- Copy buttons bind `aria-label` to the copied state (`Copy SQL to clipboard` ↔ `SQL copied to clipboard`) so screen readers hear the success transition.
- Status badges (roadmap) and decision-type chips have ≥ 4.5:1 contrast against their tinted backgrounds in both light and dark modes.
- `<ErrorBanner>` uses `role="alert"` (warn) or `role="alertdialog"` (fatal) so assistive tech announces it on appearance. Action buttons are reachable by keyboard tab order.
- Schema editor textarea, NQL textarea, and example `<select>` keep their existing `aria-label`s.
- Skeleton shimmer uses `aria-busy="true"` on its container and `aria-live="polite"` so screen readers announce the load completion when the result lands.

## Out of scope (tracked as future work)

- **`<PlaygroundLite>` for guides** — embeddable variant; defer until ≥ 2 guide pages have asked for it. GitHub issue with title "Refactor Playground for embedding in guides — API and decomposition TBD".
- **Schema sharing for >5KB DSL via node-liblzma** — eat-your-own-dogfood angle. Lazy-loaded only when a "Share large schema" button is invoked. GitHub issue with title "Add LZMA fallback for oversize schema URL hashes (eat-your-own-dogfood with node-liblzma)".
- **TypeScript ORM mode (T3)** — toggle is wired into `<QuerySection>` but the TS compile path is a separate PR.
- **Multi-instance state isolation** — accepted v1 limitation; refactor to `useState`-per-instance composables only when an embed use case lands.

## Verification (during implementation)

- `pnpm -C packages/docs build` succeeds with the new component decomposition.
- `/playground` renders correctly on a fresh page load, with auto-compile producing the Plan + SQL within the first paint cycle.
- Mobile viewport (320px) keeps vertical order; no horizontal scroll, no overflowing cards.
- Hash round-trip: encode a state, paste the URL into a new tab, verify the same state is restored.
- Unsupported-browser path: temporarily blacklist `CompressionStream` in DevTools, paste a hashed URL, verify the warn banner appears with the documented copy.
- Module-load fatal path: throttle network to offline mid-mount, verify the fatal banner appears with `Reload` and `Reset URL`.
- Lighthouse score on `/playground` stays within 5 points of the current baseline (no major bundle regression).

## Approved decision summary

| # | Decision |
|---|---|
| 1 | Layout: schema collapsed top, stacked story (vertical) |
| 2 | NQL/TS toggle above textarea, NQL default |
| 3 | Output: Plan as always-visible hero; SQL/Params as sub-tabs below |
| 4 | Auto-compile on mount |
| 5 | URL persistence: CompressionStream native baseline |
| 6 | `Reset` button next to `Edit ↗` in schema header |
| 7 | Skeleton shimmer during init imports |
| 8 | Sticky top banner for init-time anomalies (cases 3/4/6) with inline actions |
| 9 | Inline banners (existing pattern) for runtime errors (cases 7/9) |
| 10 | Single-instance v1; embed-in-guides tracked as separate issue |
| 11 | Component-oriented internal decomposition during the rewrite |
