# FEAT-134 — NQL general `:param` bound parameters, tag interpolation binding, `nqlRaw()` trusted fragments

```yaml
doc-meta:
  story: FEAT-134
  issue: 134
  status: canonical
  adversarial_applied: true
  llm_consensus_applied: true
  production_audit_applied: true
  created: 2026-06-11
```

## §1 Scope

Implements issue #134 on current `main` (post nql-1.1.0). Target version: **nql 1.2.0** (`feat(nql)` commit typing; single release train with the pending fix releases — release PR #164 held open by operator decision).

Three capabilities, in dependency order:

1. **General `:param` bound parameters** — `:param` accepted as a VALUE in general expression positions (comparison RHS, IN/lists, function args), resolved from the existing `CompilerContext.params` map; missing binding → structured semantic error (mirror of the established missing-binding error model, normalized into `ParseResult.errors[]`).
2. **Tag interpolation binds as params** — `createNqlTag` converts each `${value}` into an auto-generated `:__pN` name + a `params` map passed via `compilerOptions`, replacing literal-splicing (`toNqlLiteral`). Values never touch NQL source text.
3. **`nqlRaw()` trusted-fragment marker** — branded wrapper; interpolations carrying it are spliced VERBATIM into NQL source; everything else is always bound. `@public`, documented "trusted fragment only — never untrusted input".

### Current reality (probed empirically on HEAD + layer map, 2026-06-11)

- The 1.0.2 escape path is SAFE today: `${"x' or 1=1"}` ends up bound as `$1` at the SQL layer (escape → NQL literal → IntentAST value → adapter `$N`). #134 item 2 is therefore NOT a security fix; its user value is **type fidelity** (numbers/dates/bools/null/ARRAYS bound natively — `toNqlLiteral` currently THROWS on arrays/objects/undefined), **`ANY(${ids})` via tag** (today: always throws, tag has no params map — `orm.nql.length === 1`), and **auditability** (values visible in `dump().params`).
- Bare `:param` outside `ANY()` does not parse today (parse error at the comparison operator).
- `ANY(:p)` works only via direct `nqlCompile(src, { params })`; missing binding → structured semantic error in `errors[]` (plain message, not a thrown custom class).
- `nqlRaw` does not exist anywhere (only a `@fileoverview` forward note in `packages/core/src/dx/nql.ts`).
- **Uniform binding decision:** ALL non-raw interpolations bind (strings/numbers included, not just the types `toNqlLiteral` rejects). Rationale: one interpolation code path — a selective escape-for-scalars/bind-for-arrays dual mode is exactly the dual-derivation drift class that caused the FIX-154 emission/hydration divergence. `toNqlLiteral` is DELETED in B2; its tests migrate to binding assertions. `nqlRaw` stays in scope (issue acceptance criterion; load-bearing for the dynamic order-by migration story).

### Insertion points (verified file:line on HEAD)

| Layer | Change |
|---|---|
| Lexer (`packages/nql/src/lexer/tokens.ts:73`) | NONE — `NamedParam` token (`/:[a-zA-Z_][a-zA-Z0-9_]*/`) already general, ordered before `Colon` |
| Grammar (`packages/nql/src/parser/grammar.ts`) | Add `namedParamExpr` alternative in the `primaryExpr` atom rule (**:878** — expression chain is `expression` :819 → `addExpr` :826 → `mulExpr` :840 → `unaryExpr` :855 → `jsonAccessExpr` :864 → `primaryExpr` :878); `anySuffix` (727-733) unchanged. ALSO: enumerate every structural position that consumes literal tokens and accept `NamedParam` where a bound value is semantically sound — concretely `limitClause` (:297) and `offsetClause` (:305) PLUS the `insert … from … limit N` / `upsert … from … limit N` numeric sites are `NumberLiteral` CONSUME sites extended to accept `NamedParam` (integer ≥ 0 validation via the shared resolver); `rangeOpSuffix` (`contains`) accepts a `NamedParam` scalar alongside `rangeLiteral | literal`; date-range and direction tokens stay structural (nqlRaw/builder escape). See compat constraint below |
| AST (`packages/nql/src/parser/ast.ts:215-234`) | New `NqlNamedParamExpr { type: 'namedParam'; name: string }` variant of `NqlExpression` (cannot reuse `NqlVariableRef` — different runtime path) |
| Semantic (`visit-expression.ts`) | New visitor case building the node (strip leading `:` like `buildAny` at :221) |
| Compiler (`compile-expression.ts` + every value-conversion helper) | **ONE shared resolver** `resolveNamedParam(ctx, name)` owning ALL semantics (hasOwn, proto-trio/`__p*` rejection, undefined/NaN/Infinity rejection, structured errors) — consumed by every site that can meet an `NqlNamedParamExpr`: comparison RHS, `expressionToValue()`, `resolveFilterValue()`, `expressionToSql()`, LIKE/coercion paths, mutation assignment compilation, select-expression compilation, CASE branches, JSON function args, range `contains`. NO per-site reimplementation (the FIX-154 dual-derivation lesson). Default branches that would stringify/throw on the new node type are enumerated in B1's test table. Bound values land as explicit public `ParamIntent` nodes (`{kind:'param', value:<opaque>}`) in `WhereComparisonIntent.value`, `ParamExpressionIntent`, limit/offset fields, JSON path/key slots, IN values, and mutation values; `ctx.params` already flows through `compileNestedQuery` |
| `@dbsp/types` | Public `ParamIntent` / `isParamIntent` plus widened value slots for comparison-derived params, JSON path/key params, ANY-array params, and top-level/mutation limits |
| Adapter | WHERE path: none (`compile-where.ts:422` binds comparison values; `custom.ts:214` expressions; `any.ts:88` arrays). **SELECT-expression path (scope extension, operator-approved):** the original zero-change claim was wrong — (1) `handlers/expression/arithmetic.ts:32` and `case-value.ts:109` parameterize unknown operands AS-IS and must unwrap `{ kind: 'param', value }` to bind the value; (2) NQL `{ kind: 'function' }` SELECT intents have NO handler and are silently no-opped by `intent-to-decisions.ts:137` (pre-existing — `SELECT *` fallback, data-exposure class); add the handler reusing the existing function-compilation machinery; (3) **fail-loud posture:** unknown select-expression kinds raise a structured error — the silent no-op default is removed |
| Core tag (`packages/core/src/dx/nql.ts:160-186`) | `createNqlTag`: per-interpolation — `nqlRaw` marker → splice verbatim; else allocate `:__pN`, collect `params.__pN = value`; pass `params` through `NqlBuilderImpl.compile` (:215-249) into `nqlCompile` `compilerOptions` (today only `pseudoColumnKeywords`/`recursiveKeywords` are forwarded, :335). `toNqlLiteral` retained ONLY if a literal-splice fallback is spec'd (see compat) |
| Core `nqlRaw` (`packages/core/src/dx/nql.ts`) | New branded type + factory: `nqlRaw(fragment: string): NqlRawFragment` with a unique symbol brand (an unbranded string must NEVER be treated as raw) |

### Contract-first constraints (public API — Hyrum discipline)

- **Param resolution semantics (value-level, the highest-risk surface):**
  - Resolution uses `Object.hasOwn(params, name)` — NEVER `params[name] !== undefined`. `{ p: null }` binds SQL NULL; `{}` raises missing-binding. The ANY path's current check is `!Array.isArray(rawValues)` (`compile-expression.ts:290`, error code reused from generic invalid-syntax) — neither that nor an `=== undefined` heuristic may be copied to the scalar path; the shared resolver replaces both, and the ANY retrofit gives missing-binding its own structured semantics.
  - Param NAMES matching `__proto__` / `constructor` / `prototype` are REJECTED with a structured error (in source and in the params map) — otherwise `params["__proto__"]` resolves to `Object.prototype` and silently passes the binding check.
  - `{ p: undefined }` is REJECTED with a structured error (it passes `hasOwn` but is not a value — `undefined` ≠ SQL NULL; use `null` to bind NULL). `NaN` / `Infinity` bound values are rejected at bind-time (fail-loud); `BigInt` / `Date` bind natively through the adapter (deliberately dropping `toNqlLiteral`'s numeric-form guards).
  - These semantics are GLOBAL across all compile entrypoints (tag AND direct `nqlCompile({ params })`), and are RETROFITTED to the existing `ANY(:p)` path (same hasOwn/absent-vs-undefined check, same name rejections; arrays containing `NaN`/`Infinity` rejected element-wise). A `params` object created with `Object.create(null)` is accepted (`Object.hasOwn` works without a prototype; name-rejection rules still apply).
  - A param referenced twice (`id = :p or parent_id = :p`) resolves to the same VALUE but the adapter emits an independent `$N` per use-site (no positional dedup) — documented and locked by test.
- **`__p` namespace reserved:** auto-generated names are `__p0, __p1, …`. A user-supplied `:__p*` or a `__p*` params key is REJECTED with a structured error — and the reservation scan runs on the ASSEMBLED source AFTER `nqlRaw` splicing, so a raw fragment cannot inject a colliding `:__p0`. (Unrelated namespace, do not conflate: the adapter already uses a `__p`-prefixed SQL column-alias convention in `handlers/expression/pseudo.ts` — those are SQL aliases, not NQL param names; no interaction.)
- **Structural-position compatibility (the migration risk):** literal-splicing made `limit ${n}` work because the number landed in source text; param-binding would hand the grammar a `NamedParam` where it expects a number literal. Pinned resolution: (a) grammar accepts `NamedParam` in `limit`/`offset` (and any enumerated value-position where binding is sound), compiler validates the bound value's type (integer ≥ 0) with a structured error; (b) for any structural position where binding is NOT extended, the tag-level error message must name `nqlRaw()` as the escape (e.g. dynamic direction `asc|desc`). The grammar enumeration is part of B1's deliverable — no position left undecided.
- **Determinism:** `__pN` numbering counts BOUND interpolations only, in template order — `nqlRaw` slots do not allocate a name and cannot shift the value↔name mapping (mixed raw+bound determinism locked by test). Same template + values → same NQL source + same params, byte-identical SQL. Numbering is GLOBAL across a multi-statement (`| bind`) template — it never resets per statement, and the single params map is shared by all statements (a user `:p` referenced in two statements binds the same value).
- **Error model consistency:** new errors use the existing structured code families in `ParseResult.errors[]` (parse vs semantic), never bare throws from the tag path beyond what `NqlBuilderImpl` already surfaces. Error TEXT carries param NAMES/positions only — never bound VALUES (PII/log-redaction posture; matches the existing ANY error which leaks `typeof` only).
- **Structural-position durability rule:** any grammar rule added LATER defaults to — value-position: accepts `NamedParam` (bound); structural-position (identifiers, directions, keywords): does NOT, with `nqlRaw`/builder as the documented escape. The default is stated in the grammar rule's doc comment so the enumeration cannot rot silently.
- **`nqlRaw` security posture:** brand = module-private `Symbol()` (NOT `Symbol.for()` — the global registry is cross-realm forgeable) stored as a non-enumerable own property; the guard checks own-symbol presence, never duck-typing. `structuredClone`/JSON round-trips drop the symbol, so forged/cloned objects are treated as plain values and BOUND (forgery unit tests required: `Object.create` shape-copy, forged property name, cloned fragment). JSDoc + docs state "never pass untrusted input"; fragments participate in NQL parsing (a broken fragment fails at parse with the normal structured error against the assembled source).
- **Migration notes (1.0.2 escape → 1.2.0 binding):** behavior-compatible for strings/numbers/bools/null (same results, values now in `dump().params` instead of escaped source text); NEW capability for arrays (`ANY(${ids})`); `limit ${n}` keeps working via (a). Document in changelog + `packages/docs` migration subsection.

### Out of scope

- Positional `$1`-style NQL params, param type declarations, server-side prepared-statement reuse.
- `nqlRaw` fragment composition algebra (nesting raw inside raw is just string concat; no AST-level fragment type).
- Mutation-statement params beyond what the general value path provides (the 1.1.0 `allowUnfilteredMutations` guard is unchanged; a `:param` cannot satisfy or bypass the where-less mutation guard).

## §2 Reality constraints & scope pivots

- Issue text predates the nql 1.1.0 sweep: multi-statement now REQUIRES `| bind` (tests written for this story must comply); `compileNestedQuery` already threads `params` through nested compilation (no work, verified); bounded-ANY (`maxAnyItems`) exists.
- Known non-limit (deliberate): no total-param-count cap — template literals are author-bounded, not runtime loops. Revisit only if the MCP surface ever exposes raw template assembly (tracked in TODO.local.md).
- Scope pivot (2026-06-11, operator-approved): adapter SELECT-expression path added to scope after review showed the zero-adapter-change assumption false — param intents reaching SELECT arithmetic/CASE bound wrapper objects, and function SELECT intents were silently dropped by a pre-existing no-op default (reachable on main with literals too). The fix includes removing that silent default (fail-loud on unknown kinds).
- **Architecture decision v3 (2026-06-11, operator-approved): a bound param is a FIRST-CLASS explicit AST node with an opaque value.** Older attempts stored a bare value in `value: unknown` and tracked "is this a param?" out-of-band. That overloading is the root cause: a bound JSONB `{kind:'fieldRef'}` and a real structural fieldRef occupy the same field with the same shape, forcing the adapter to duck-type. v3 fixes it at the source: a resolved `:param` becomes an explicit PUBLIC node `{kind:'param', value:<opaque>}` IN the IntentAST. The inner `.value` is opaque — never inspected for value-vs-structure. The adapter binds `case 'param' → .value` as `$N` (any shape: scalar/object/array/null/bigint); structural nodes (`fieldRef`/`outerRef`/`column`) keep their own kind and compile as structure. Identity travels IN the node like any other node, so EVERY consumer (toIntentIR/plan/dump, set-op leaves, CTEs, mutations, subqueries, direct compile) sees it uniformly — nothing to strip (the node is public by design), nothing to thread (no separate channel). Deliberate contract change: `toIntentIR()`/`plan()`/`dump().plan` now expose `{kind:'param', value:5}` for bound params (honest); tests + S1 updated accordingly. `dump().params` and `dump().sql` unchanged (adapter still binds the value). Supersedes the previous out-of-band designs.
- **Security decision (2026-06-11, operator-approved): NQL SELECT functions are allowlisted, not open.** Making generic function emission total (root fix below) surfaced a NET-NEW exposure: `compileGenericNqlFunction` emitted `funcCall(name, args)` for ANY identifier (`validateIdentifier` checks name SYNTAX only), so `pg_sleep`/`pg_notify`/extension/UDF functions became callable from NQL text — which is untrusted/LLM-adjacent in MCP contexts. On `origin/main` no such path exists (WHERE hard-throws `SEM_INVALID_SYNTAX` for any non-`json_*` function; SELECT had no function path). Decision: restrict NQL-origin SELECT functions to a CONSERVATIVE known-safe allowlist (the functions already supported/tested + documented set: coalesce, json_*, supported aggregates, window functions, common scalars like upper/lower/length/now, math) defined in ONE place; anything outside → fail-loud `SEM_INVALID_SYNTAX`, mirroring the WHERE posture. Closes the exposure, aligns SELECT with WHERE, and cuts NO capability #134 requires (the issue asked for `:param` binding + nqlRaw, never arbitrary function execution). Allowlist is extensible in a later change if a real need appears.
- **Architecture decision (2026-06-11, operator-approved root fix):** successive gate findings (function intents silently dropped → `raw` name reaching the verbatim deparser → top-level `:p` unsupported → compound function arg `round(price + :d)` collapsed) were all symptoms of ONE structural flaw: the adapter reconstructs NQL-origin SELECT expressions via a hand-rolled per-shape ALLOWLIST (`compiler.ts:1145`) whose default branch (`:1176`) binds "everything else" as a single value. Any NQL expression shape outside the allowlist collapses silently. Root fix: make the NQL-origin SELECT-expression lowering + adapter reconstruction TOTAL over the NQL expression grammar — every shape (column, literal, named param, function, nested function, arithmetic/binary op, CASE, coalesce, json access, window, builder-origin raw, `$ref` subquery) lowers to a structured intent the adapter reconstructs RECURSIVELY; the "everything else → single value" default is replaced by a fail-loud structured error for genuinely unhandled shapes. Closes the class instead of the instance.
- The issue's "1.1.0" target is now **1.2.0** (1.1.0 shipped 2026-06-05).
- Item 2 reframed from "safety fix" to "fidelity + capability" — the injection vector was already closed in 1.0.2 (probed: malicious payloads inert).

## §3 BDD scenarios

### S1 — general scalar `:param`
- Given `nqlCompile('users | where id = :p', { params: { p: 5 } })` (adapt to actual API/syntax)
- Then compile succeeds; `WhereComparisonIntent.value` is `{kind:'param', value:5}`; adapter SQL is `… WHERE users.id = $1` with `params [5]`

### S2 — missing binding fails structurally
- Given the same query with `params: {}`
- Then `success: false` with a structured error (stable code, message naming `:p`), NOT a throw

### S3 — tag binds interpolations
- Given ``orm.nql`users | where id = ${5} and name = ${"o'brien"}` ``
- Then NQL source contains `:__p0` / `:__p1` (no value text); `dump().params` is `[5, "o'brien"]`; SQL has `$1`/`$2`

### S4 — `ANY(${ids})` via tag
- Given ``orm.nql`users | where id = ANY(${[1,2,3]})` ``
- Then the array binds (existing ANY path), SQL `= ANY($1::…[])`, no literal text

### S5 — `nqlRaw` splices verbatim; plain strings never do
- Given ``orm.nql`users | ${nqlRaw('order by created_at desc')}` `` → fragment lands in source, parses normally
- And given the SAME string WITHOUT `nqlRaw` → it is bound as a param (and fails or compares, but NEVER alters query structure)

### S6 — `__p` namespace protected
- Given a tag source containing literal `:__p0` or direct `params: { __p0: … }` → structured rejection

### S7 — `limit ${n}` keeps working
- Given ``orm.nql`users | limit ${10}` `` (adapt to actual limit syntax) → compiles; non-integer/negative bound value → structured error

### S8 — real-DB round trip (e2e)
- Given the S3 + S4 queries executed against PostgreSQL with discriminating seed
- Then returned rows match the bound values' filtering exactly (a swap/loss of params produces different rows)

### S9 — multi-statement (`| bind`) param sharing
- Given a two-statement template (with mandatory `| bind`) where a user `:p` appears in both statements and tag interpolations appear in each
- Then one shared params map; `:p` binds the same value in both; `__pN` numbering is global across the template (no per-statement reset)

### S10 — value-resolution semantics (unit)
- `{ p: null }` → binds SQL NULL; `{}` → structured missing-binding error; `params` key `__proto__`/`constructor`/`prototype` → structured rejection; `NaN`/`Infinity` value → structured rejection; `BigInt`/`Date` → bind through adapter; same `:p` twice → same value, two `$N`

### S11 — lexing edge: adjacent interpolations (valid syntactic context)
- Given adjacent interpolations in a context the grammar accepts a list, e.g. ``in (${a}, ${b})`` and the pathological no-separator assembly `:__p0:__p1` (which must fail at PARSE with a structured error, not mis-lex into one token)
- Then the lexer produces two NamedParam tokens (greedy-match boundary at `:`); list-context binds both; separator-less adjacency errors cleanly — locked by test (plus position-0 and empty-template cases)

## §4 Implementation blocks (vertical)

| Block | Scope / files | Observable success | Deps |
|---|---|---|---|
| B1 | nql grammar + ast + semantic + compiler (+ their unit tests; grammar position enumeration table in test) | S1, S2, S7-grammar-side, S10 green; existing nql suite green; parse micro-benchmark within noise of main (NamedParam alts are single-token LL(1) — assert, don't assume) | none |
| B2 | core `nql.ts` (`createNqlTag`, `nqlRaw`, params forwarding) + core unit tests (migrate escaping tests to binding assertions) | S3-S6 green; `toNqlLiteral` array/object throws replaced by binding | B1 |
| B3 | e2e (`tests/e2e/`) + docs (`packages/docs/nql/index.md` named-params section — the SINGLE canonical source for `__pN` semantics, JSDoc/migration notes LINK to it without re-specifying; `orm-api.md` tag subsection, nql README, `@fileoverview` update, migration notes) | S8 green; docs build (VitePress) green | B1+B2 |

Executor: codex `--mode exec` (forbid outward actions — no issue/PR creation; scope verified via `git diff --stat` post-run; "document X" instructions verified against diff).

## §5 Test requirements

- nql unit: grammar (every value position × NamedParam accept/reject table), semantic (node building, `:` stripping), compiler (resolution, missing binding, `__p` rejection, type validation for limit/offset, nested-query param flow through `compileNestedQuery`).
- core unit: tag binding order/determinism, `nqlRaw` brand guard (string without brand is bound, object with forged shape but no symbol is bound), mixed raw+bound template, migrated 1.0.2 escape tests.
- adapter: 1-2 integration asserts ($N numbering with mixed tag params + builder params) — expected zero adapter code change.
- e2e real-DB: S8 (assert ROWS + exact SQL + params; discriminating seed per project memory).
- Full suites + doctest framework green; VitePress build green for docs.

## §6 Adversarial findings ledger

5 perspectives applied (opus, 2026-06-11). S=8 · M=8 · L=2; 16 VALID amendments folded into §1/§2/§3/§4, 2 deferred.

| # | Perspective | Finding | Sev | Resolution |
|---|---|---|---|---|
| 1 | Skeptic | Binding-vs-splice ROI thin for scalars | M | RESOLVED with rationale — uniform binding kept (one code path; selective dual-mode = the FIX-154 drift class); `toNqlLiteral` deleted |
| 2 | Skeptic | limit/offset grammar sites unnamed | S | VALID — `limitClause`/`offsetClause` cited, LL(1) local alts |
| 3 | Skeptic | `nqlRaw` scope creep? | M | REJECTED — issue acceptance criterion, load-bearing for migration story |
| 4 | Edge | `| bind` param-map sharing unspecified | S | VALID — S9 + determinism rule (global numbering, shared map) |
| 5 | Edge | Same param twice → $N semantics | M | VALID — same value, independent `$N` per use, locked |
| 6 | Edge | absent-key vs explicit-null | S | VALID — `Object.hasOwn` resolution pinned |
| 7 | Edge | NaN/Infinity/BigInt/Date un-decided | M | VALID — NaN/Inf reject; BigInt/Date bind |
| 8 | Edge | Adjacent interpolations lexing | S | VALID — S11 |
| 9 | Security | Brand forgery (Symbol.for, clone) | S | VALID — module-private Symbol, forgery tests |
| 10 | Security | Prototype pollution via params keys | S | VALID — hasOwn + proto-trio name rejection |
| 11 | Security | Raw slots shifting `__pN` mapping | M | VALID — bound-only numbering pinned |
| 12 | Security | Raw fragment injecting `:__p0` | M | VALID — reservation scan post-splice |
| 13 | Security | Bound values leaking in error text | M | VALID — names/positions only |
| 14 | Perf | Parse-path regression unasserted | L | VALID — benchmark line in B1 |
| 15 | Perf | No total-param cap | L | DEFER — §2 known non-limit + TODO note |
| 16 | Maintainer | New-rule default undecided | M | VALID — durability rule added |
| 17 | Maintainer | `toNqlLiteral` fate hedged | S | VALID — DELETE, tests migrate |
| 18 | Maintainer | `__pN` docs single source | S | VALID — nql/index.md canonical |

## §7 /llm --spec consensus

Run 2026-06-11 (`llm-delegate.sh --mode consensus --llm all`). codex: success (67s). gemini + copilot: harness failures on their side, no findings — consensus basis is codex single-engine.

| Engine | Sev | Finding | Resolution |
|---|---|---|---|
| codex | S | `namedParam` branch needed in EVERY value-conversion helper, not just compile-expression — pin one shared resolver | VALID — §1 compiler row rewritten around `resolveNamedParam` |
| codex | S | Retrofit hasOwn/proto-trio/NaN semantics to the existing `ANY(:p)` path (incl. array elements) | VALID — §1 global-semantics bullet |
| codex | M | `insert/upsert … from … limit N` numeric sites also structural | VALID — §1 grammar row extended |
| codex | M | `__p*` rejection must be global across entrypoints; decide `Object.create(null)` params | VALID — §1 global-semantics bullet |
| codex | M | `{ p: undefined }` passes hasOwn — reject explicitly | VALID — §1 resolution semantics |
| codex | M | `rangeOpSuffix` (`contains :p`) wouldn't parse | VALID — §1 grammar row extended |
| codex | L | S11 adjacency needs a valid syntactic context (list), separator-less must parse-error | VALID — S11 rewritten |
