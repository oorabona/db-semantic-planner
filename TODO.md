# Roadmap

## v1.0.0 (current)

- [x] Core query planner with full intent-to-SQL pipeline
- [x] PostgreSQL adapter (native pg, no ORM dependency)
- [x] Fluent query builders (select, insert, update, delete, upsert)
- [x] Include strategies (lateral join, subquery, in-query)
- [x] DDL: schema introspection, comparison, migration generation
- [x] NQL (Natural Query Language) parser
- [x] Expression primitives (op, fn, ref, param, cast, literal)
- [x] Extension helpers (pgvector, ParadeDB BM25)
- [x] Schema scoping (multi-tenant isolation)
- [x] CLI with REPL

## Future

- [ ] Correlated EXISTS subquery in WHERE/SELECT — `exists('relation', (sub) => sub.where(...))` with outer column refs (use case: astix fetchCommunityMeta — `EXISTS(SELECT 1 FROM files f WHERE f.last_parsed > c.created_at)`)
- [ ] CAST expression in column selection — `cast(ref('created_at'), 'text')` (use case: `c.created_at::text` in SELECT)
- [ ] Additional adapters (MySQL, SQLite)
- [ ] Cost-based join reordering
- [ ] Query caching layer
- [ ] VitePress documentation site
- [ ] Interactive playground (Monaco + compile-only mode)

---

# Code Review Backlog (codex + copilot, 2026-04-19)

> Per-package fix lists from parallel codex review (4 agents) + Copilot remarks audit on PRs #39/#40/#41.
> Workflow: one branch per package (`fix/<pkg>-review`), `/workflow` to fix all items in that package, then PR for Copilot re-review.
> Order suggested: nql → adapter-pgsql → core → types → cli → mcp-server (P0 first).

## Resume after /clear

```
1. Read this section (TODO.md "Code Review Backlog")
2. Pick a package
3. Run: /workflow "Fix all P0/P1 review findings in @dbsp/<pkg> per TODO.md backlog"
4. Plan-provided mode: TODO entries are the spec — skip clarify/spec/adversarial
5. Branch: fix/<pkg>-review-<YYYYMMDD>
6. Open PR with `/review` summary, request Copilot review
7. Apply Copilot feedback rounds (max 3 per CLAUDE.md), squash-merge
```

---

## @dbsp/nql — 6 findings (2 P0, 4 P1)

Branch: `fix/nql-review-20260419`

- [x] ✅ **[P0] codex** `packages/nql/src/lexer/tokens.ts:105` — `RangeValue` regex `/-?\d+(?:[-:T]\d+)+/` greedily matches arithmetic subtraction without whitespace. `users | where id > 10-5` tokenizes as single `RangeValue:10-5`, then parse error. **Fix**: require ≥4-digit prefix `/\d{4}(?:[-:T]\d{1,2})+/` or add lookahead so plain integer subtraction is excluded. Test: `NqlLexer.tokenize('10-5')` should produce `[NumberLiteral, Minus, NumberLiteral]`. (2026-04-19)

- [x] ✅ **[P0] codex** `packages/nql/src/compiler/compile-expression.ts:437` — `json_exists(data, email)` (identifier 2nd arg, not literal) → `String({type:'path',segments:['email']})` yields `'[object Object]'`, silent corruption. **Fix**: in `compileJson` after `resolveFilterValue` for the key arg, detect `NqlPathExpression` shape and extract via `expressionToField()`, or reject non-literal key with explicit error. (2026-04-19)

- [x] ✅ **[P1] codex** `packages/nql/src/parser/grammar.ts:177` — `cteItem` rule consumes only `Identifier`, rejects `QuotedIdentifier`. **Fix**: replace `this.CONSUME(Identifier)` with `this.SUBRULE(this.identSegment)` in cteItem + visit-cte.ts visitor. (2026-04-19)

- [x] ✅ **[P1] codex** `packages/nql/src/compiler/compile-expression.ts:603` — `caseExpr` not handled in WHERE position. **Fix**: added `case 'case':` (actual AST tag) throwing clear error. (2026-04-19)

- [x] ✅ **[P1] codex** `packages/nql/src/compiler/compile-expression.ts:334` — `compileBetween` accepts path-expression bounds silently producing `{$ref}` objects. **Fix**: validate lower/upper are scalars (number/string/Date/null), throw `'BETWEEN bounds must be literal'`. (2026-04-19)

- [x] ✅ **[P1] codex** `packages/nql/src/semantic/visit-expression.ts:680` — `visitQuantifiedRelationFilter` aliased form: no explicit `ctx.As` guard. **Fix**: explicit `ctx.As && ctx.identSegment` guard added. (2026-04-19)

---

## @dbsp/adapter-pgsql — 14 findings + 2 refactors (MERGED PR #47)

Branch: `fix/adapter-pgsql-review-20260419` — ✅ merged as `38f9594` (2026-04-19). 4 Copilot rounds, final hard-cap merge per senior directive. Full package cleanup bundled (14 review findings + 2 CC refactors + docs/cache polish + internal deparser extension + C3 regression fix + identifier validation restoration).

### Follow-ups discovered during review rounds (not merged)

- [x] ✅ [adapter-pgsql] Round-4 F-R4-1: extension names now validated via `validateExtensionName` across generateDDL + migration UP/DOWN (PR #48, 2026-04-19). NAMEDATALEN 63-char limit added.
- [x] ✅ [adapter-pgsql] Round-4 F-R4-2: check constraint expressions now validated via `validateSqlExpression` across generateDDL + migration UP/DOWN (PR #48, 2026-04-19).
- [x] ✅ [adapter-pgsql] Senior F-S1: typeof guards added to `{sql}` escape hatch in `ddl-generator.ts` + `schema-diff.ts` for full symmetry (PR #48, 2026-04-19).
- [x] ✅ [adapter-pgsql] Copilot-nit PR #48 L-1 follow-up: 5 phase files + 6 local `qualifyTable` helpers consolidated; correct `quoteIdent` type labels propagated (PR #49, 2026-04-20).
- [ ] 🔧 [adapter-pgsql] Senior F-S2: hydrateIncludes leaves raw `{rel}_json` column in results when subquery strategy coerced via mapToHandlerDecision — strip after populating relationName. Priority: L
- [x] ✅ [adapter-pgsql] Senior F-S3: empty/whitespace default values rejected via tightened quote helpers (PR #49, 2026-04-20).
- [x] ✅ [adapter-pgsql] DRY: `qualifyTableIdent()` wired to replace 3 local `qualifyTable` implementations (PR #49, 2026-04-20).
- [x] ✅ [adapter-pgsql] DRY: `ddl-generator.ts:quoteIdentifier` consolidated with `phases/utils.ts:quoteIdent` (PR #49, 2026-04-20).
- [x] ✅ [adapter-pgsql] UX: `quoteIdent` context label propagated (`'table' | 'schema' | 'column'`) at 12 phase-module call sites (PR #49, 2026-04-20).

### P0 (runtime crashes / silent corruption)

- [ ] **[P0] codex** `packages/adapter-pgsql/src/handlers/include/cte.ts:70` — Dynamic `require('../index.js')` inside `buildCteSelect()` — package is ESM-only. Any CTE include with filter conditions throws `ReferenceError: require is not defined`. **Fix**: replace with static top-level `import { createWhereDispatcher } from '...';` (see `handlers/expression/custom.ts` for pattern).

- [ ] **[P0] codex** `packages/adapter-pgsql/src/handlers/where/subquery.ts:178` — Parameterized subquery `LIMIT` emitted as integer literal instead of `$N` ParamRef. `{ limit: { paramIndex: 5 } }` compiles to `LIMIT 5` (the index!), not `LIMIT $5`. **Fix**: emit `{ ParamRef: { number: limitObj.paramIndex } }` instead of `integerNode(limitVal)`. Test: subquery with parameterized limit should produce `LIMIT $N` in SQL.

- [ ] **[P0] copilot #40** `packages/adapter-pgsql/src/handlers/expression/relation.ts:61` (was `custom.ts:178`) — `relationColumnHandler`: `state.aliases.get(relation) ?? relation` for multi-hop path `'callee.file'` returns `'callee.file'` literal as alias → SQL `"callee.file"."col"` (double-dot quoted, broken). **Fix**: detect dotted path, split and resolve each segment via aliases, emit final-segment alias only. Test: `relationColumn('callee.file', 'name')` should produce valid SQL alias.

### P1 (correctness)

- [ ] **[P1] codex** `packages/adapter-pgsql/src/mutations/upsert.ts:100` — `buildOnConflictClause()` ignores `ConflictTarget.where`. Partial-index conflict targets (`ON CONFLICT (email) WHERE active = true`) emit only `ON CONFLICT (email)` → wrong constraint hit. **Fix**: compile `config.conflictTarget.where` via WHERE dispatcher, attach to `infer.whereClause`.

- [ ] **[P1] codex** `packages/adapter-pgsql/src/adapter-compiler-select.ts:617` — `enrichRangeDecisions(options?.model)` misses `deps.model` fallback used elsewhere. ORM path through adapter deps loses range type enrichment → CAST nodes omitted. **Fix**: extract `const resolvedModel = options?.model ?? deps.model` before call.

- [ ] **[P1] codex** `packages/adapter-pgsql/src/adapter-compiler-select.ts:799` — `subquery` includes lowered to `json_agg` in compiler, but `compileWithIncludes()` re-emits original `subquery` decisions → relation fetched twice, raw `{rel}_json` column never cleaned. **Fix**: when lowering `subquery` to `json_agg`, remove original from `subqueryIncludes`.

- [ ] **[P1] codex** `packages/adapter-pgsql/src/streaming/cursor.ts:157` — `forward_all`/`backward_all` FetchDirection encoded as INT_MAX literal `2147483647` instead of SQL `FETCH FORWARD ALL` / `FETCH BACKWARD ALL`. Silent data truncation > INT_MAX rows; lost round-trip fidelity in deparser. **Fix**: explicit branches in `buildFetch()` for `forward_all`/`backward_all` (PG `FETCH_ALL_DIR`, no `howMany`).

- [ ] **[P1] codex** `packages/adapter-pgsql/src/introspection.ts:776` — Column defaults stored as raw strings from `information_schema.column_default`. Emitters (`ddl-generator.ts:399`, `migration-sql.ts:1129`, `table-operations.ts:47`) quote them as string literals unless they look like `fn()`. `CURRENT_TIMESTAMP`, `nextval('seq'::regclass)` round-trip as quoted text → DB behavior changes on regen. **Fix**: store as `{ sql: rawDefault }` in ColumnIR; emitters check shape before quoting.

- [ ] **[P1] copilot #40** `packages/adapter-pgsql/src/plan-decision-extractor.ts:102` — `resolveIncludeByPath` typed return `{ relation; limit? }` but caller at line 646 widens via `as` cast to add `select`/`where`. Type-safety hole — refactor risk. **Fix**: widen return type to include `select?` and `where?` properly so cast is unnecessary.

- [ ] **[P1] copilot #40** `packages/adapter-pgsql/src/adapter-compiler-mutations.ts:111` — `resolveExistsIntent` only enriches top-level exists/notExists; nested under `and`/`or`/`not` skipped. Alias→tableName bug recurs. **Fix**: recursive walk through WhereIntent tree (and/or/not branches), enrich each exists found.

### P2 (refactor / maintainability)

- [ ] **[P2] codex** `packages/adapter-pgsql/src/ddl/ddl-generator.ts:61` — `generateDDL()` CC=66 / 186 lines. Single point of failure for all schema-push. **Fix**: extract DDL phases (indexes, constraints, RLS, sequences) into dedicated generators (pattern from `migration-sql.ts`).

- [ ] **[P2] codex** `packages/adapter-pgsql/src/compile-where.ts:277` — `compileWhereIntent()` CC=64 / 300 lines. Monolithic dispatch. **Fix**: delegate per-operator-family to existing `handlers/where/` modules; this fn should only route.

- [ ] **[P2] copilot #41** `packages/adapter-pgsql/src/validate.ts:303` — Error message says forbidden chars include `$` but regex rejects only `$$` (PG dollar-quoting). Misleading for users with `$N` parameters. **Fix**: clarify error message: `"$$" (dollar-quoted strings)`.

### Test fix

- [ ] **[P0] copilot #40** `packages/adapter-pgsql/src/__tests__/include-where-2hop.test.ts:205` — Backspace `\b` control char embedded in `expect(sql).not.toMatch(/where/i)` — invisible in editor, regex rendered with literal backspace, assertion always passes. **Fix**: rewrite line 205 manually (delete + retype) to remove the embedded control character.

---

## @dbsp/core — 14 findings (13 P1, 1 P2)

Branch: `fix/core-review-20260419`

- [ ] **[P1]** `packages/core/src/planner.ts:1498` — `generateDecisionId` uses `String.replace('-', '')` (first hyphen only). Multi-hyphen DecisionType IDs malformed: `filterstrategy-001` vs `cte-extraction-001`. **Fix**: `type.replace(/-/g, '')` or `replaceAll('-', '')`.

- [ ] **[P1]** `packages/core/src/planner.ts:278` — `opts.forceFilterStrategy`/`forceJoinType` cast `as` from possibly-undefined `Partial<PlanOptions>`. Latent type-safety: future caller adding non-undefined default silently breaks. **Fix**: `opts.forceFilterStrategy = options.forceFilterStrategy ?? undefined` (let union remain).

- [ ] **[P1]** `packages/core/src/planner.ts:462` — Bidirectional UNION-ALL warning fires on `strategy==='union-all' && storageHint==='unknown'` regardless of whether `forceBidirectionalStrategy` triggered the choice. Mixes intent-driven vs forced paths. **Fix**: add separate guard for forced paths so warning content reflects user choice.

- [ ] **[P1]** `packages/core/src/planner.ts:591` — `optimizeInToExists` rewrites `WhereInIntent(subquery)` → `WhereExistsIntent` but silently uses `primaryKey[0] ?? 'id'` for composite PKs → wrong correlation. **Fix**: when `primaryKey.length > 1` and field doesn't match a single PK component exactly, skip optimization (return where as-is).

- [ ] **[P1]** `packages/core/src/dx/query-builder.ts:1189` — `paginate()` builds count builder with 10 positional args, omits `hookStore` (11th) + `onHookError` (12th). Count query bypasses RLS/audit hooks. **Fix**: pass `this.hookStore, this.onHookError` as args 11-12.

- [ ] **[P1]** `packages/core/src/dx/query-builder.ts:1245` — `cursorPaginate` keys cursor lookup by `orderBy.field` cast as `string`. Expression-based orderBy → `field` is undefined → `cursorValues[undefined]` returns undefined → `buildCursorConditions` returns null → cursor silently no-op. **Fix**: validate all orderBy entries are field-based (`{field: string}` or string), throw `InvalidOperationError` for expression orderBy in cursorPaginate.

- [ ] **[P1]** `packages/core/src/dx/query-builder.ts:1302` — `cursorPaginate` `direction: 'backward'` builds `prevCursor` from `data[0]` but does NOT reverse orderBy → query returns same forward-ordered page. Backward pagination broken silently. **Fix**: reverse orderBy directions when `direction==='backward'`, or document/throw if unsupported.

- [ ] **[P1]** `packages/core/src/dx/subquery-builder.ts:124` — `asExpr()` calls `this.build().asExpr(alias)` without setting `select`/`aggregate` first → `build()` throws misleading `'select() or an aggregate function'` error. **Fix**: `asExpr()` either defaults to `select('*')` or throws explicit `'asExpr() requires select() or aggregate'`.

- [ ] **[P1]** `packages/core/src/dx/subquery-builder.ts:131` — `build()` with both `select('field')` AND aggregate (e.g. `.select('price').max('price')`) → silently uses aggregate, drops select. **Fix**: throw `InvalidOperationError` if both set, or document precedence in JSDoc.

- [ ] **[P1]** `packages/core/src/dx/mutation-builders.ts:259` — `executeWithHooksInner()` computes `duration = Date.now() - startTime` BEFORE `adapter.execute()`. afterCtx duration covers compile time only, not DB execution. **Fix**: capture timestamp after `adapter.execute()` completes.

- [ ] **[P1]** `packages/core/src/dx/set-operation-builder.ts:160` — `dump()` constructs fake `PlanReport { rootTable: '', decisions: [], warnings: [] }` and passes to `adapter.createDump()`. Schema-scoping or decision inspection in createDump → silent failure. **Fix**: compute real plan for left side, or refactor `compileSetOperation` to return `Dump` directly.

- [ ] **[P1]** `packages/core/src/dx/recursive-query-builder.ts:213` — `traverseVia()` with edge-table options BEFORE `.from()` → `nodeTable` falls back to `this.startTable ?? tableOrNodeTable`, builds `EdgeTableTraversal` where `nodeTable === edgeTable`. **Fix**: defer construction to `buildIntent()` after startTable validated, or throw if `this.startTable` is undefined when edge-table options used.

- [ ] **[P1]** `packages/core/src/dx/recursive-query-builder.ts:394` — `columns(Record<string, string>)` discards values — only keeps `Object.keys()`. Aliases silently dropped. **Fix**: map record to `{column, as}` pairs, or change signature to `string[]` only.

- [ ] **[P2]** `packages/core/src/dx/filters.ts:287` — `inSubquery()` JSDoc says `WHERE id = ANY(SELECT user_id FROM posts)` but emits `WHERE id IN (...)`. Confusing for users choosing between `inSubquery()` and `any()`. **Fix**: correct JSDoc to `WHERE id IN (SELECT user_id FROM posts)`.

---

## @dbsp/types — 5 findings (2 High, 3 Medium)

Branch: `fix/types-review-20260419`

- [x] ✅ **[P0]** `packages/types/src/model-ir.ts:186` — `originalDbType`/`dbType` mismatch. **Fix**: unified on `originalDbType` (existing project convention in MEMORY.md + 90+ refs); fixed introspection emitter + added `param-type-cast.test.ts` asserting CAST flow. (2026-04-19)

- [x] ✅ **[P1]** `packages/types/src/model-ir.ts:43` — `OnDeleteAction` now includes `'SET DEFAULT'`, introspection `mapDeleteRule` handles it, round-trip test added. (2026-04-19)

- [x] ✅ **[P1]** `packages/types/src/adapter.ts:604` — `CompileOnlyAdapter` tightened with `?: never` on execute/executeOne/executeOneOrThrow/stream/introspect/transaction/executeRaw/executeDDL. (2026-04-19)

- [x] ✅ **[P2]** `packages/types/src/adapter.ts:385` — `HierarchyIR` added, `IntrospectionResult.hierarchies` field exposed. (2026-04-19)

- [x] ✅ **[P2]** `packages/adapter-pgsql/src/pgsql-adapter.ts:203` — `cloneOptions` helper propagates logger/defaultPkColumnName/deriveFkColumnName to transaction/withSchema scoped instances. (2026-04-19)

### Follow-ups discovered during review (non-blocking)

- [x] ✅ [types] `pgsql-adapter-mock.test.ts` private-field anti-pattern replaced with observable behavior assertions (PR #46 round-1). (2026-04-19)
- [x] ✅ [types] `createPgsqlCompileOnlyAdapter` now returns `CompileOnlyAdapter` via single documented cast (PR #49, 2026-04-20).
- [x] ✅ [types] `DetectedHierarchy` aliased to `HierarchyIR` — single source of truth (PR #49, 2026-04-20).
- [x] ✅ [types] E2E testcontainer test `originalDbType-cast.test.ts` proves real PG introspection + CAST emission; SET DEFAULT FK round-trip also covered (PR #49, 2026-04-20).
- [ ] 🔧 [adapter-pgsql] Copilot-nits-PR-46: `pgsql-adapter-mock.test.ts` logger test in [P2-T5b] block uses non-tx stream cleanup path instead of genuine `transaction()` call — rename or move the test to honestly describe what it tests.

---

## @dbsp/cli — 10 findings (3 High, 7 Medium)

Branch: `fix/cli-review-20260419`

- [ ] **[P0]** `packages/cli/src/commands/migrate.ts:167` — `acquireMigrationLock(pool)` / `releaseMigrationLock(pool)` use pooled `pool.query()`. PG advisory locks are session-scoped — pool connection can be reused by different process between acquire/release. Two concurrent `dbsp migrate apply` can both enter critical section. **Fix**: dedicate a single `pool.connect()` client for lock duration (acquire + work + release on same client), release client at end.

- [ ] **[P0]** `packages/cli/src/repl/batch.ts:135` — Batch mode sets `dbSuccess=false` + error on DB failure but leaves `success=true`. Exit code at line 411 uses `!r.success` → DB error prints but exit 0 → silent CI break. **Fix**: set `success=false` when `dbSuccess===false`.

- [ ] **[P0]** `packages/cli/src/generators/schema-codegen.ts:223` — Captures non-`id` referenced FK column at line 223 but never emits it in generated `ref()` call at line 161. `REFERENCES users(email)` round-trips as `ref('users')` (defaults to PK). **Fix**: emit `ref('users', { references: ['email'] })` when target column is not the default PK.

- [ ] **[P1]** `packages/cli/src/commands/migrate.ts:230` — `migrate apply` calls `isDestructiveDown(parsed.upStatements)`. Helper designed for DOWN SQL → `destructive` column in `_dbsp_migrations` mislabeled for every migration. Safety gates rely on this metadata. **Fix**: call `isDestructiveDown(parsed.downStatements)` (or rename to clarify direction).

- [ ] **[P1]** `packages/cli/src/commands/push.ts:67` — `--drop --json` calls `outputResult()` (silent in JSON mode) and only prints completion at line 91 when `!options.json`. Both `--drop --json` and `--drop --dry-run --json` exit 0 with no JSON output. **Fix**: emit JSON object describing dropped objects in JSON mode.

- [ ] **[P1]** `packages/cli/src/repl/batch.ts:245` — Assertion blocks validated against raw `queries` (line 245) but executed against filtered `executableQueries` (line 289, blank/comment-stripped). Validation passes, runtime misaligned silently. **Fix**: validate against `executableQueries`, or apply same filtering before validation.

- [ ] **[P1]** `packages/cli/src/repl/csv.ts:231` — `readline` splits CSV input on physical newlines BEFORE `parseCsvLine` runs. RFC 4180 multiline cells (`"hello\nworld"`) break into multiple records → corrupted `.load` input. **Fix**: read whole file, parse with proper CSV state machine that respects quoted multiline.

- [ ] **[P1]** `packages/cli/src/repl/csv.ts:149` — Headerless CSV: any short non-numeric first row treated as header (line 149), unconditionally skipped (line 257). File `Alice,Paris\nBob,London` imports only `Bob`. **Fix**: require `--no-header` flag explicit, or detect header more robustly (e.g. all values look like field names).

- [ ] **[P1]** `packages/cli/src/generators/schema-codegen.ts:264` — Table/column names emitted as bare object keys; defaults injected as raw single-quoted literals (line 91). DB identifiers like `user-profile` or defaults containing quotes/newlines → generated `dbsp.schema.ts` doesn't parse. **Fix**: quote bare keys when invalid identifier; escape default strings via `JSON.stringify`.

- [ ] **[P2]** `packages/cli/src/repl/history.ts:60` — Stores raw trimmed commands; line 51 saves entries joined by `\n`; line 33 reloads splitting on every newline. Multiline queries reload as multiple unrelated entries. **Fix**: use NUL `\0` separator or escape newlines before join.

---

## @dbsp/mcp-server — 5 findings (superseded by retro-audit PR #51, 2026-04-20)

Branch: `fix/mcp-server-review-20260419` — superseded by retro-audit PR #51 (`b1c85cc`, 2026-04-20). 3 of 5 items addressed; 2 remain as feature TODOs (out of audit scope).

- [ ] 💡 **[P0 → feature]** `packages/mcp-server/src/server.ts:55` — Server registers ZERO MCP tools (all TODOs). Audit PR #51 documented as scaffold (README pre-release banner + "Planned features"); tool implementation deferred as scope creep. **Next**: implement minimal `schema_info` tool first, then progressively add compile/dump/intent_validate per MCP protocol.

- [x] ✅ **[P1]** `packages/mcp-server/src/schema-loader.ts` — `validateResolvedSchema` covers tables/relations/hints/conventions/indexes (matches `ResolvedSchemaValidation` in `@dbsp/core`). `defaultFilters` intentionally gapped pending public export from core. (PR #51, 2026-04-20)

- [ ] 🔧 **[P1]** `packages/mcp-server/src/schema-loader.ts` — `.ts` file loader uses plain `import()`. README/printHelp document `tsx` peer dependency but loader doesn't programmatically attach it. Catch-block emits a clear "install tsx" message but doesn't auto-load. **Fix**: detect `.ts` extension → use tsx programmatic API.

- [x] ✅ **[P2]** `packages/mcp-server/src/schema-loader.ts` — `allowedRoots` containment now applies to BOTH existent and non-existent paths via unified `isPathContained()` in new `path-validator.ts` module. Existence oracle closed. (PR #51, 2026-04-20)

- [x] ✅ **[P2]** `packages/mcp-server/src/index.ts` — `parseArgs()` consumed inside `main()`'s try/catch with usage hint + exit 1. Empty `=` values rejected. Unknown flags rejected. POSIX `--` end-of-options supported. (PR #51, 2026-04-20)

---

## Summary

| Package | P0 | P1 | P2 | Total |
|---------|----|----|----|-------|
| nql | 2 | 4 | 0 | 6 |
| adapter-pgsql | 3 | 7 | 3 | 13 (+1 dep on types) |
| core | 0 | 13 | 1 | 14 |
| types | 1 | 2 | 2 | 5 |
| cli | 3 | 6 | 1 | 10 |
| mcp-server | 1 | 2 | 2 | 5 |
| **Total** | **10** | **34** | **9** | **53** |

> Sources: codex review (4 parallel agents, 2026-04-19) + Copilot remarks audit on PRs #39/#40/#41 (5 still-valid out of 8).

---

# Retro-audit 2026-04-19 follow-ups (L — deferred from PR #49)

> PR #49 merged as `5ba23ca` (2026-04-20). 25 audit findings + 14 Copilot findings + 8 senior findings addressed across 4 rounds. Hard cap bypassed once with user approval for structural COLLATE fix. These L items were explicitly deferred during convergence.

- [ ] 🔧 [adapter-pgsql] `VALID_INDEX_METHODS` missing `bloom` (CONTRIB extension method). Parity gap vs `bm25`/`hnsw`/`ivfflat`. Priority: L
- [ ] 🔧 [adapter-pgsql] `validateCollationName` rejects legacy glibc locale modifier `@euro` (e.g. `de_DE.utf8@euro`). Very legacy PG deployments only; extend regex if user impact surfaces. Priority: L
- [ ] 🔧 [adapter-pgsql] NAMEDATALEN byte-vs-char asymmetry: `validateIdentifier` uses `.length > 63` (char count); `quoteRoleName`/`validateCollationName` use `Buffer.byteLength(name, 'utf8') > 63` (byte count). In practice the ASCII-only regex makes them equivalent; documentation-wise the asymmetry is confusing. Priority: L
- [ ] 🔧 [tests/e2e] `tests/e2e/originalDbType-cast.test.ts` `execDDL()` uses `pool.query()` which does not pin to a specific connection — `SET search_path TO X` and the `finally` reset may run on different pool connections. Wrap in `pool.connect()` + `client.query()` + `client.release()` for strict session affinity. Pre-existing pattern; latent issue. Priority: L
- [ ] 🔧 [adapter-pgsql] M-5 `SchemaChange.meta` discriminated union: 56 `as ForeignKeyIR`/`as IndexIR`/`as ColumnIR` casts in `migration-sql.ts`. Full union per `change.kind` (~25 kinds) deferred with in-source disclosure at `migration-sql.ts` top-of-file. Priority: L (structural refactor)

---

# Retro-audit 2026-04-20 cli follow-ups (L — deferred from PR #50)

> PR #50 merged as `44c9913` (2026-04-20). 60 audit findings (5 parallel sonnet + codex xhigh) + 12 Copilot findings + 5 senior findings addressed across 3 Copilot rounds. R3 was clean. Items below are explicit deferrals — not missed work.

- [ ] 🔧 [cli] SC-1 `processDotCommand` god-switch in `packages/cli/src/repl/dot-commands.ts` — 444 lines, CC=113, mixes I/O + business logic + file ops across 18 case branches. Extract per-case private handlers, wire through a dispatch table. Priority: L (maintainability)
- [ ] 🔧 [cli] SC-2 `repl-engine.ts` 261-line duplicate dispatcher (CC=91) — parallels the dot-commands god-switch for a second REPL engine surface. Same refactor shape. Priority: L
- [ ] 🔧 [cli] SC-3 `handleTableConfig` CC=52 in `repl-engine.ts` — four copy-pasted validate/apply blocks. Model as option-map, loop once. Priority: L
- [ ] 🔧 [cli] SC-4 `handleNql` 157 lines in `repl-engine.ts` — inline `QueryResult` construction mixed with execution-control. Extract `buildQueryResult()` + `shouldExecuteQuery()` pure helpers. Priority: L
- [ ] 🔧 [cli/types] SC-8 `isValidSchema` duplicated in `packages/cli/src/utils/schema-loader.ts` and `packages/gui/src/sidecar/schema-loader.ts` with `similarity=1.0`. Move canonical version to `packages/types` so both packages depend on it. Priority: L (cross-package move)
- [ ] 🔧 [cli] Narrow `schema-loader.ts` realpath catch-all to `err.code === 'ENOENT'` only — currently swallows EACCES/ELOOP/EPERM and falls through to existsSync, which may still return true on a symlink with exotic permissions. Priority: L (defense-in-depth, narrow window)
- [ ] 🔧 [cli] `migrate.test.ts` destructive-flag regression test is a tautology — it calls `mockIsDestructiveDown(parsed.downStatements)` in the test body instead of exercising `applyCommand` end-to-end. Convert to an integration test via testcontainers with a destructive-DOWN fixture asserting the recorded `destructive=true` row. Priority: L (test quality)
- [ ] 🔧 [cli] `repl/history.ts` `chmodSync` runs only on file LOAD (at next session), not after each `save()`. A history file created at 0644 by a prior tool retains that mode through the current session's saves until the next REPL start. Add `chmodSync(HISTORY_FILE, 0o600)` after every `writeFileSync` (best-effort). Priority: L (hygiene)
- [ ] 🔧 [cli] `schema-codegen.ts` snake_case self-ref inference: `baseName = col.name.replace(/Id$/, '')` doesn't strip `_id` in snake_case mode, producing role names like `parent: 'parent_id'`. Use `/_?[iI]d$/`. Priority: L (generator quality)
- [ ] 🔧 [cli] `schema-codegen.ts` FK `onDelete`/`onUpdate` values interpolated as `'${fkInfo.onDelete}'` without going through the local `singleQuoteEscape` helper. Pg enum values are safe today; inconsistency with column-default emission is the concern. Priority: L (consistency)
- [ ] 🔧 [cli] `index.ts` Commander parse errors with `--json` in argv — verify help/version paths emit JSON too when `--json` is present, not plain text. May already work through the exitCode-0 detection; needs a specific test. Priority: L (JSON-mode coverage)

---

# Retro-audit 2026-04-20 mcp-server follow-ups (L — deferred from PR #51)

> PR #51 merged as `b1c85cc` (2026-04-20). 22 audit findings (3 sonnet concerns + codex xhigh) + 23 Copilot/senior findings across 6 Copilot rounds (R3 + R5 escalated to user → STRUCTURAL fixes). Two new modules extracted: `path-validator.ts` (143 LoC, symlink-aware containment), `format-error.ts` (111 LoC, path sanitization). Tests 25 → 141 (+116, 5.6× increase). Items below are explicit deferrals.

- [ ] 🔧 [mcp-server] Senior R6 F-001: `index.ts:251` uses `await import('node:path')` for `basename` (dynamic import) — replace with top-of-file `import { basename } from 'node:path';` Static-import policy consistency. Priority: L (style)
- [ ] 🔧 [mcp-server] Senior R6 F-002: `format-error.ts` exports `sanitizeErrorMessage` as public API via `api.ts` re-export. Add `@stable` JSDoc tag + note "Placeholders (`<schema-file>`, `<schema-dir>`) and 500-char cap are part of the public contract — change requires major version bump." Priority: L (Hyrum-exposure documentation)
- [ ] 🔧 [mcp-server] Senior R6 F-003: `format-error.ts:79` `sanitizeErrorMessage` uses literal-string `replaceAll` — add comment "MUST keep literal string semantics — switching to RegExp requires escaping `paths.resolved` and `paths.parent`" to prevent future refactor regression. Priority: L (defensive doc)
- [ ] 🔧 [mcp-server] Copilot R6 single L: `schema-loader.ts:61` `canonicalRoots` JSDoc says "Empty array means cwd was used as the default root" but `validateAllowedRoots()` always returns `[process.cwd()]` (never empty). Update doc to reflect actual behavior. Priority: L (doc-code mismatch)
- [ ] 🔧 [mcp-server] Senior R5 cosmetic L1: `schema-loader.test.ts:62-63` template-literal fixtures use double-tab indent on `indexes: {}`. biome-formatter would normalize; not blocking. Priority: L (cosmetic)
- [ ] 🔧 [mcp-server] Senior R6 informational: `format-error.ts:107` truncation marker uses `'…'` (single character ellipsis). Tests assert `endsWith('…')` — this locks the wording. Acceptable but document in JSDoc that the marker is part of the contract. Priority: L
- [ ] 💡 [mcp-server] FUTURE: implement at least one MCP tool (`schema_info` is the natural starting point) so the server transitions from "scaffold" to "functional pre-release". Then remove the README pre-release banner. Priority: feature (out of audit scope, in roadmap)
- [ ] 🔧 [mcp-server] FUTURE: replace local `validateResolvedSchema` duck-check with `v.safeParse(ResolvedSchemaValidation, schema)` once `@dbsp/core` exports the validator publicly. Currently the local validator mirrors the valibot schema with a documented gap on `defaultFilters`. Priority: L (cross-package dependency)
