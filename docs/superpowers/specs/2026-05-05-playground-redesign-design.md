# Playground redesign — design

**Date:** 2026-05-05
**Author:** brainstorm session
**Status:** Approved by user (v2 — codex review folded), pending implementation plan
**Scope:** `packages/docs/.vitepress/theme/Playground.vue` and `/playground.md`

## Why

The current Playground page packs four densely-stacked surfaces (NQL textarea, schema model with diagram + TS tabs, output with SQL/Params/Plan tabs, plus several Copy buttons) and feels cluttered. A fresh visitor's eye has no clear focal point, the differentiator (Plan tab) is buried behind a tab default-set to SQL, and the schema model dominates above-the-fold real estate that should belong to the magic moment (intent → SQL + Plan).

This redesign reframes the Playground as a *demo-first* surface optimised for the visitor who lands fresh and decides whether to engage in 10 seconds. Schema becomes context (collapsed top); query and the structured Plan become the headline. URL-hash persistence makes individual queries shareable.

## Goals

1. **Above-the-fold differentiator.** The visitor sees a pre-compiled example with the structured Plan rendered as the hero output. Performance budget: **Plan + SQL visible within 2s on Fast 4G after VitePress hydration**, measured via Lighthouse.
2. **Schema demoted but accessible.** A 32-px sticky bar at the top with table count and an `Edit ↗` toggle. Expanding reveals today's full editor (DSL + Mermaid diagram + generated TS).
3. **Mobile-first vertical flow.** Schema bar → Query → Plan cards → SQL/Params. Same order on every viewport; no responsive reflow that breaks the story.
4. **URL-hash sharing.** A query authored in the playground is shareable via the URL. CompressionStream native baseline, hash schema is versioned (`{v:1, …}`) so future versions can evolve without breaking shared links.
5. **Component-oriented internals.** Split the current 1500+ LoC monolith into focused sub-components even when they all live in `Playground.vue`, so a future embeddable variant can be extracted cleanly.

## Non-goals

- Embeddable `<PlaygroundLite>` for guides. Tracked as a separate issue; out of v1 scope.
- ORM TypeScript editor mode (T3). Layout reserves the toggle slot but the v1 hash format only encodes `m:'nql'`. The toggle UI may render as disabled or hidden in v1; the TS compile path is a separate PR.
- localStorage persistence. URL hash is the single source of restore truth.
- Schema designer page (`/schema-designer`). Schema editing stays inside the playground container.
- Custom-schema sharing for oversize DSL. Encoder enforces a `MAX_HASH_LENGTH = 4000` chars baseline (calibrated against browser URL limits during implementation). When the encoded payload exceeds it, encoder skips writing the hash AND surfaces a non-fatal banner (`URL sharing paused — state too large to share via URL`); the playground keeps compiling locally. Gzip's 32 KB sliding window covers typical small DSL payloads; node-liblzma upgrade tracked as future work for power users with larger schemas.

## User journey

| Step | What the user does | What the page shows |
|---|---|---|
| Land on `/playground` (no hash) | nothing | Schema bar collapsed at top · query area pre-filled with first example · Plan cards hero already rendered · SQL/Params sub-panel filled |
| Click an example | dropdown change | Same query area updates, auto-compile re-runs (debounced once on next tick), Plan cards re-render |
| Edit the NQL textarea | typing | Auto-compile after 300ms; collapse state on existing decision cards is preserved (per-decision structural signature tracker) |
| Click `Copy SQL` | button | Clipboard receives the raw SQL; button shows `Copied` for 2s |
| Click `▾ Schema · Edit ↗` | bar click | Schema section expands inline (DSL + Mermaid + TS tabs as today). User edits DSL → debounced 500ms → schema rebuild → auto-compile of current NQL |
| Click `Reset` next to `Edit ↗` | button (with `@click.stop`) | Soft reset: `history.replaceState(history.state ?? {}, '', pathname + search)` (drops `#h=` hash, keeps query string + scroll), then resets `schemaDsl`/`nqlCode`/`queryMode`/`expandedDecisions` refs in-place. No full reload. |
| Land on a hash-shared link | URL hash present | Hash decoded → schema/query/mode applied → rest of init runs → auto-compile fires; visitor sees the same state as the link author |
| Hash changes while still on `/playground` (SPA hash navigation) | clicks an in-page hash link | `hashchange` listener cancels in-flight compiles + re-enters the restore path with the new hash; no full remount |
| Hash decode fails (corrupt / version mismatch / no CompressionStream) | nothing | Sticky top warn banner; default state loaded underneath |
| Module imports fail | nothing | Sticky top fatal banner with `Reload` + `Reset URL`; output panel hidden |
| Encoded URL exceeds `MAX_HASH_LENGTH` | typing very large schema | Sticky top warn banner ("URL sharing paused"); local compile continues; hash NOT written |

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
│   Mode toggle: [NQL] [TypeScript (v1: disabled)]           │
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

All sections except `<ErrorBanner>` are vertically stacked, no responsive layout switches. `<ErrorBanner>` uses `position: sticky; top: var(--vp-nav-height); z-index: calc(var(--vp-z-index-nav) - 1);` so it pins below VitePress's own fixed navbar without z-index conflict.

## Lifecycle — mount / hashchange / unmount

```
state:
  isInitializing: ref(true)
  errorBanner:    ref<ErrorBanner | null>(null)
  disposed:       boolean (module-scope, set in onBeforeUnmount)

onMounted async:
  await runInitFlow()

onMounted (sync, after `await runInitFlow()` completes):
  window.addEventListener('hashchange', onHashChange)

onBeforeUnmount:
  disposed = true
  window.removeEventListener('hashchange', onHashChange)
  // Cancel every in-flight timer:
  if (schemaDebounceTimer) clearTimeout(schemaDebounceTimer)
  if (nqlDebounceTimer)    clearTimeout(nqlDebounceTimer)
  if (sqlCopiedTimer)      clearTimeout(sqlCopiedTimer)
  if (paramsCopiedTimer)   clearTimeout(paramsCopiedTimer)
  if (copiedTimer)         clearTimeout(copiedTimer)
  if (hashWriteTimer)      clearTimeout(hashWriteTimer)
  // Bump generation so any awaited renderDiagram bails:
  rebuildGeneration += 1
  // Clear queued manual gestures:
  pendingManualCompile = false
  suppressNextNqlWatch = false
  // Note: every awaited branch in runInitFlow / rebuildOrm / renderDiagram
  // already guards `if (gen !== rebuildGeneration) return` and now also
  // `if (disposed) return` BEFORE mutating any ref.

async function runInitFlow():
  1. Hash inspection + decode (whole step is awaited):
     - If no `#h=` hash → restored = null (default state).
     - If hash present but `'CompressionStream' in window === false`
         → errorBanner = warn-cas-4 ; restored = null.
     - Else `await decodeHash(rawHash)` (async because DecompressionStream
       processes via stream pipes):
         → on success: validate `restored.v === 1` and `restored.m === 'nql'`.
            * unknown `v` or `m` → errorBanner = warn-cas-version ; restored = null.
            * v1 + nql: sanitize `restored.s` and `restored.n` (see Security
              section), then apply to refs.
         → on any throw (corrupt payload, JSON parse fail, decompression
           fail, schema-shape mismatch, sanitization rejection):
           errorBanner = warn-cas-3 ; restored = null.
     - If `disposed` after the await → return without mutation.
  2. Eager imports for the critical path (Plan + SQL):
       const [core, adapter] = await Promise.all([
         import('@dbsp/core'),
         import('@dbsp/adapter-pgsql'),
       ])
       on rejection → errorBanner = fatal-cas-6 ; isInitializing = false ; return.
       If `disposed` → return.
  3. await rebuildOrm(schemaDsl.value)
       schemaError set internally if parse fails — keep going so the
       inline schema-error banner shows, but skip auto-compile in step 4.
       If `disposed` → return.
  4. if (!schemaError && nqlTag && nqlCode.trim()):
       cancel any nqlDebounceTimer the user's mid-load typing scheduled
       performCompile({ resetTab: false })
  5. isInitializing = false
  6. Lazy-load Mermaid in the background after first compile lands:
       import('mermaid').then(m => { mermaidInstance = m.default; ... })
       If the user hasn't expanded the schema yet, the diagram render is
       deferred until either (a) Mermaid is loaded AND schema is expanded,
       or (b) schema-expand triggers an explicit `await import('mermaid')`
       on demand (whichever fires first).
       If `disposed` → discard the result.

function onHashChange():
  // SPA hash navigation (in-page link or browser back/forward over hash).
  if (decodedHash matches lastEmittedHash) return  // ignore our own writes
  Cancel any in-flight nqlDebounceTimer + schemaDebounceTimer.
  Bump rebuildGeneration so any pending renderDiagram bails.
  Clear pendingManualCompile.
  Reset isInitializing = true; errorBanner = null
  await runInitFlow()  // re-enter the init path with the new hash
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
#h=<base64url(gzip(JSON.stringify({ v: 1, s: schema, n: nql, m: 'nql' })))>
```

- `h=` prefix is a forward-compat marker (a future `#l=…` could carry an LZMA-compressed payload without changing the gzip path).
- `v: 1` is mandatory in v1; future versions bump it. Decode rejects unknown `v` with `warn-cas-version` and loads default.
- `m: 'nql'` is the only accepted mode in v1. `m: 'ts'` (post-T3) will require `v ≥ 2`. v1 decoder treats unknown `m` as a `warn-cas-version` banner — the visitor sees the link is from a newer version.
- Compression: `CompressionStream('gzip')`, native, no library dependency.
- Encoding: base64url (RFC 4648 §5) — replace `+/` with `-_`, strip trailing `=`.
- Decode: symmetric, with try/catch on every step. Any failure → `errorBanner = warn-cas-3`, default state loaded.
- Browser missing `CompressionStream` → detect with `'CompressionStream' in window`. Hash is silently dropped, banner explains.
- **Encoder length cap.** Before writing, the encoder measures `nextUrl.length`. If it exceeds `MAX_HASH_LENGTH` (4000 chars baseline, calibrated during implementation), the encoder skips the write AND raises `errorBanner = warn-cas-oversize`. Local compile continues. The hash already in the URL bar (if any) is NOT modified — the visitor's existing shareable state stays intact until they reset.

Encode trigger: debounced 500ms on schema/nql/mode change. Avoids flooding URL bar updates while typing. The writer uses `history.replaceState(history.state ?? {}, '', nextUrl)` so VitePress's stored scroll state (kept under `history.state`) survives. The writer also tracks `lastEmittedHash` so the `hashchange` listener can ignore its own writes.

## Security & sanitization

Hash payloads are arbitrary user input from anywhere on the internet. Before applying a decoded payload to refs, the playground validates:

- **Schema DSL identifier check.** Each table/column name parsed from `restored.s` is run through the same `validateIdentifier` regex used by `@dbsp/adapter-pgsql` (`/^[A-Za-z_][A-Za-z0-9_]*$/`). Any non-conforming identifier rejects the whole hash with `warn-cas-3`.
- **Schema DSL size cap.** Raw decoded `restored.s` is rejected if longer than 8 KB (well above any reasonable schema, well below memory pressure thresholds).
- **NQL query size cap.** Raw decoded `restored.n` is rejected if longer than 2 KB (NQL is intentionally compact; oversize implies tampering).
- **Mermaid render input.** Even after schema validation, the Mermaid code generator escapes `<`, `>`, and quotes when interpolating identifiers — the existing `buildMermaidCode` helper is audited during implementation and any unescaped path is fixed. Mermaid's own SVG output is rendered via `v-html` because Mermaid is trusted; the ID inputs to Mermaid (which come from validated identifiers) are safe.
- **TS export.** The `generateTypeScript` helper uses validated identifiers only; templated string literals are escaped to prevent breakouts.

Failure modes from sanitization rejection raise the same `warn-cas-3` banner, never silently load partial state.

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
| Hash decode failure (corrupt / sanitization reject) | `warn` | Couldn't restore the shared link | The URL hash is corrupt, oversized, or contains unsupported content. Loaded the default playground instead. | `Reset URL` · `Got it` |
| Hash version / mode unsupported | `warn` | Shared link from a newer version | This link uses a version of the playground hash format that isn't supported here. Loaded the default state. | `Reset URL` · `Got it` |
| No CompressionStream + hash present | `warn` | Couldn't restore the shared link | This link needs `CompressionStream` (Firefox 113+, Safari 16.4+, Chrome 80+). Loaded the default state. | `Reset URL` · `Got it` |
| Encoded URL exceeds MAX_HASH_LENGTH | `warn` | URL sharing paused | The current playground state is too large to share via URL. The page still works locally; URL sharing will resume when state shrinks below the limit. | `Got it` |
| Module imports fail | `fatal` | Couldn't load the playground | A network issue prevented the playground modules from loading. | `Reload` · `Reset URL` |

Action handlers:

- `Reset URL` (warn) → `e.stopPropagation()` (when fired from inside `<SchemaSection>` header) + `history.replaceState(history.state ?? {}, '', pathname + search)` + reset refs in-place + `errorBanner.value = null`.
- `Got it` → `errorBanner.value = null`.
- `Reload` (fatal) → `window.location.reload()`.
- `Reset URL` (fatal) → `window.location.assign(pathname + search)` (full reload, drops hash). Only fatal recovery uses full reload.

Schema parse errors and NQL syntax errors stay in their existing inline banners (`schemaError` red bar inside the Schema section, `error` red `<pre>` inside the Output area). Only init-time anomalies and encoder-cap warnings surface in the top banner.

## Auto-compile semantics

| Trigger | resetTab | Notes |
|---|---|---|
| Mount complete (no schema-error) | false | Stay on whichever tab the URL hash specified (or SQL by default). |
| `hashchange` re-enter | false | Hash navigation behaves like a fresh load with the new hash; tab restored from hash. |
| Compile button click | true | Manual gesture → reset tab to SQL. |
| Ctrl/Cmd+Enter | true | Same as button. |
| Example dropdown change | true | New context → reset tab. |
| NQL textarea change (300ms debounce) | false | Preserve user's tab choice while iterating. |
| Schema rebuild settles | false | Auto-recompile after schema changes; user's tab stays. |
| Manual compile queued during schema rebuild | true | Queued via `pendingManualCompile` flag; fires after rebuild settles. |

If a manual gesture races with a debounced compile, `compile()` cancels `nqlDebounceTimer` to prevent a duplicate fire 300ms later.

## Component decomposition (single-file v1)

The redesign keeps everything in `Playground.vue`. Sub-components are real Vue SFCs (separate `.vue` files in `theme/playground/`) imported by `Playground.vue`. They are presentational: parent owns all stateful refs (compile flow, hash sync, module imports, schema flow, expandedDecisions, copy timers) and passes data down via `defineProps`; children emit events for user gestures via `defineEmits`. Children own their **local-only** state (e.g. `<PlanDecisions>` keeps its `Map<id, signature>` watcher inside its own setup; the watcher is local because state is per-decision-list and doesn't need to leak).

| Component | Responsibility | Props (in) | Emits (out) | Owns |
|---|---|---|---|---|
| `<ErrorBanner>` | Sticky top init-error display | `data: ErrorBanner \| null` | `dismiss` | nothing |
| `<SchemaSection>` | Collapsed bar + expandable editor (DSL/Diagram/TS) | `dsl: string`, `tableCount: number`, `mermaidSvg: string`, `generatedTs: string`, `schemaError: string \| null`, `expanded: boolean` | `update:dsl`, `update:expanded`, `reset`, `copy-ts` | nothing (parent owns state) |
| `<QuerySection>` | Mode toggle + example dropdown + textarea + Compile | `nqlCode: string`, `queryMode: 'nql'`, `examples: visible[]`, `selectedExampleIndex: number`, `nqlTag-ready: boolean` | `update:nqlCode`, `update:selectedExampleIndex`, `compile` (manual) | nothing |
| `<PlanSection>` | Meta strip + warnings + CTEs + decisions cards | `result: Dump \| null` | (none) | nothing |
| `<PlanDecisions>` | Decision-card list with collapse state preservation | `decisions: PlanDecision[]` | (none) | local `Map<id, signature>` watcher state |
| `<OutputSection>` | SQL/Params sub-tabs + Copy buttons | `result: Dump \| null` | `copy-sql`, `copy-params` | local `activeOutputTab` ref |

The single-instance composition stays in `Playground.vue` for v1; the factoring just enables future extraction without a rewrite. `nqlTag`, `coreModule`, `adapterModule`, `mermaidInstance`, `schemaDebounceTimer`, `nqlDebounceTimer`, `rebuildGeneration`, `pendingManualCompile`, `suppressNextNqlWatch`, copy timers, `lastDecisionSignatures`, `lastEmittedHash` all stay parent-owned in `Playground.vue` setup.

## Accessibility

- All buttons keep `type="button"`. Tab strip in `<OutputSection>` uses `<div role="group" aria-label="Output format">` and plain `<button>`s (matches current pattern).
- Decision-card disclosure buttons keep `aria-expanded` + `aria-controls="plan-decision-body-${d.id}"`. Body uses `v-show` so the controlled element exists in the DOM when the button references it.
- Copy buttons bind `aria-label` to the copied state (`Copy SQL to clipboard` ↔ `SQL copied to clipboard`) so screen readers hear the success transition.
- Status badges (roadmap) and decision-type chips have ≥ 4.5:1 contrast against their tinted backgrounds in both light and dark modes.
- `<ErrorBanner>` uses `role="alert"` (warn) or `role="alertdialog"` (fatal) so assistive tech announces it on appearance. Action buttons are reachable by keyboard tab order.
- Schema editor textarea, NQL textarea, and example `<select>` keep their existing `aria-label`s.
- Skeleton shimmer uses `aria-busy="true"` on its container and `aria-live="polite"` so screen readers announce the load completion when the result lands.
- **Mermaid diagram pan/zoom** uses pointer events (`pointerdown`/`pointermove`/`pointerup`) with `touch-action: none` on the SVG container, so mobile users can pinch/drag the diagram. The existing wheel-zoom and mouse-drag handlers are migrated to pointer events as part of the refactor.

## Out of scope (tracked as future work)

- **`<PlaygroundLite>` for guides** — embeddable variant; defer until ≥ 2 guide pages have asked for it. GitHub issue title: "Refactor Playground for embedding in guides — API and decomposition TBD".
- **Schema sharing for oversize DSL via node-liblzma** — eat-your-own-dogfood angle. Lazy-loaded only when a "Share large schema" button is invoked. GitHub issue title: "Add LZMA fallback for oversize schema URL hashes (eat-your-own-dogfood with node-liblzma)".
- **TypeScript ORM mode (T3)** — toggle slot reserved in `<QuerySection>` but the v1 hash format does not encode `m:'ts'`. The TS compile path is a separate PR; hash format will bump to `v: 2`.
- **Multi-instance state isolation** — accepted v1 limitation; refactor to `useState`-per-instance composables only when an embed use case lands. The single-instance restriction is documented in `Playground.vue` JSDoc.

## Verification (during implementation)

- `pnpm -C packages/docs build` succeeds with the new sub-component decomposition (separate `.vue` files imported from `theme/playground/`).
- `/playground` renders correctly on a fresh page load. Lighthouse measurement: LCP < 2.5s, CLS < 0.1, INP < 200ms on a Fast-4G profile after VitePress hydration.
- Mobile viewport (320px) keeps vertical order; no horizontal scroll, no overflowing cards. Schema diagram pan/zoom works via touch (pinch + drag).
- Hash round-trip: encode a state, paste the URL into a new tab, verify the same state is restored. Repeat with `MAX_HASH_LENGTH` budget reached → encoder must skip and surface the warn banner.
- `hashchange` test: from `/playground#h=abc`, navigate to `/playground#h=def` via in-page link, verify state restores without a full remount.
- Unmount test: navigate away from `/playground` mid-init, verify console has no late mutation warnings or stray timer fires.
- Sanitization test: paste a hand-crafted hash whose DSL contains `&lt;script&gt;` or non-ASCII column names, verify the warn banner appears with `warn-cas-3` and no DOM injection occurs.
- Unsupported-browser path: temporarily blacklist `CompressionStream` in DevTools, paste a hashed URL, verify the warn banner appears with the documented copy.
- Version-mismatch test: hand-craft a hash with `v: 99`, verify the version banner appears.
- Module-load fatal path: throttle network to offline mid-mount, verify the fatal banner appears with `Reload` and `Reset URL`.
- Reset URL test: from a hashed URL, click `Reset URL`, verify `window.location.search` is preserved, scroll position is preserved (history.state intact), refs reset to defaults, no full reload occurs.
- Lighthouse score on `/playground` stays within 5 points of the current baseline (no major bundle regression). Mermaid lazy-load means it does NOT count toward initial bundle.

## Approved decision summary

| # | Decision |
|---|---|
| 1 | Layout: schema collapsed top, stacked story (vertical) |
| 2 | NQL/TS toggle above textarea, NQL only in v1 hash format |
| 3 | Output: Plan as always-visible hero; SQL/Params as sub-tabs below |
| 4 | Auto-compile on mount; performance budget Plan+SQL <2s on 4G |
| 5 | URL persistence: CompressionStream native, hash versioned `{v:1, …}`, encoder length cap |
| 6 | `Reset` button next to `Edit ↗` — soft reset via history.replaceState (no full reload) |
| 7 | Skeleton shimmer during init imports |
| 8 | Sticky top banner for init-time anomalies (cases 3/4/6/version/oversize) with inline actions |
| 9 | Inline banners (existing pattern) for runtime errors (cases 7/9) |
| 10 | Single-instance v1; embed-in-guides tracked as separate issue |
| 11 | Component-oriented decomposition into separate `.vue` files; parent owns state, children presentational |
| 12 | Lazy-load Mermaid (post-critical path) so auto-compile hero isn't blocked |
| 13 | Identifier validation + size caps on hash-restored schema/NQL |
| 14 | `onBeforeUnmount` cleanup for all timers + dispose flag guard on awaited branches |
| 15 | `hashchange` listener for SPA hash navigation re-entering the init flow |
| 16 | Mobile pointer events for Mermaid diagram pan/zoom |
</content>
</invoke>