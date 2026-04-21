# packages/core — Audit BACKLOG (2026-04-21)

Source findings: 104 raw (20 SOLID + 13 SEC + 15 PERF + 25 DOC + 16 API + 15 CODEX)
After deduplification: **102 findings** (2 merges: SEC-7+CODEX-8 → FIND-021; PERF-9+PERF-11 → FIND-050)

---

## PR Bundle 1: Security hardening — L (12 findings, ~10 fix sites)

- [ ] FIND-001 (S) `orm-instance.ts:574` — listAncestors/listDescendants echo raw user table string into error message
  - Source: [sonnet:security]
  - Fix: Validate table against `model.tables` before use in error and QueryBuilderImpl call; throw safe generic error if unknown
  - Rationale: XSS via JSON error responses + schema-name enumeration (OWASP A09 + A03)
  - Blast radius: ~20 LoC

- [ ] FIND-002 (M) `orm-instance.ts:521` — withSchema skips validateIdentifier when no adapter present
  - Source: [sonnet:security]
  - Fix: Call standalone regex validation (identifier pattern) unconditionally before any `if (adapter)` branch
  - Rationale: Compile-only mode explicitly supported; schema names flow to SQL without ever being validated
  - Blast radius: ~5 LoC

- [ ] FIND-003 (M) `orm-instance.ts:870` — ddl.dropIndex inline SQL uses replace-based quoting without validateIdentifier
  - Source: [sonnet:security]
  - Fix: Add validateIdentifier(name) + validateIdentifier(sc) before building SQL; prefer delegating to adapter.generateDropIndex
  - Rationale: Control characters and semicolons pass through replace-only quoting
  - Blast radius: ~15 LoC

- [ ] FIND-004 (M) `query-builder.ts:1255` — cursorPaginate decodes base64 JSON cursor without shape validation
  - Source: [sonnet:security]
  - Fix: After JSON.parse validate shape (typeof obj === 'object' && !Array.isArray && obj !== null); use Object.hasOwn iteration to prevent __proto__ pollution
  - Rationale: OWASP A08 — cursor crosses client→server trust boundary; non-object parse results cause undefined dereferences
  - Blast radius: ~10 LoC

- [ ] FIND-005 (M) `object-filter.ts:290` — objectToWhereIntent iterates Object.entries on user-supplied filter without proto-key guard
  - Source: [sonnet:security]
  - Fix: Filter out __proto__/constructor/prototype keys; use Object.hasOwn in iteration
  - Rationale: CWE-1321 prototype pollution; leaked column-list via ColumnNotFoundError error message
  - Blast radius: ~8 LoC

- [ ] FIND-006 (M) `errors.ts:280` — RelationNotFoundError/ColumnNotFoundError/TableNotFoundError embed full available-list in .message
  - Source: [sonnet:security]
  - Fix: Add publicMessage property with generic message; keep detail in structured .available / .suggestion fields; applications use publicMessage in HTTP responses
  - Rationale: Full schema enumeration in one request (OWASP A01)
  - Blast radius: ~30 LoC (3 error classes)

- [ ] FIND-021 (M) `query-builder.ts:537` — limit()/offset()/paginate() accept NaN, Infinity, negative, and unsafe integers
  - Source: [sonnet:security, codex] (merged SEC-7 + CODEX-8)
  - Fix: Validate Number.isSafeInteger, non-negative offset, positive limit; add configurable MAX_LIMIT guard
  - Rationale: OWASP A05 DoS via unbounded LIMIT; NaN/Infinity compile to invalid SQL or wrong window
  - Blast radius: ~15 LoC

- [ ] FIND-007 (M) `orm-instance.ts:577` — listAncestors/listDescendants default maxDepth=100, accept Infinity without cap
  - Source: [sonnet:security]
  - Fix: Cap maxDepth to MAX_RECURSION_DEPTH=1000; validate maxDepth >= 1; enforce same cap in validateRecursiveInclude
  - Rationale: OWASP A05 DoS via unbounded WITH RECURSIVE CTE
  - Blast radius: ~10 LoC

- [ ] FIND-008 (M) `filters.ts:737` — coalesce(fields, as) does not validateIdentifier on field names or alias
  - Source: [sonnet:security]
  - Fix: Add validateIdentifier(f, 'column') per field and for alias
  - Blast radius: ~8 LoC

- [ ] FIND-009 (M) `query-builder.ts:812` — buildPkCondition uses Object.entries keys as field names without schema validation
  - Source: [sonnet:security]
  - Fix: Validate each composite PK key against model.tables[this.from]?.columns known PK columns
  - Blast radius: ~10 LoC

- [ ] FIND-010 (M) `orm-instance.ts:713` — insert/update/delete/upsert/updateAll/deleteAll string overloads skip validateIdentifier
  - Source: [sonnet:security]
  - Fix: Call validateIdentifier(table, 'table') in each string overload before constructing builder
  - Blast radius: ~15 LoC (6 entry points)

- [ ] FIND-011 (M) `query-builder.ts:573` — join(string, opts) does not validate string table name before storing in joinIntents
  - Source: [sonnet:security]
  - Fix: Call validateIdentifier on string argument; alternatively validate against model's known table/relation names
  - Blast radius: ~8 LoC

---

## PR Bundle 2: Planner correctness — M (4 findings)

- [ ] FIND-012 (M) `planner.ts:661` — NOT IN → notExists rewrite ignores NULL semantics (nullable FK columns)
  - Source: [codex]
  - Fix: Only rewrite NOT IN to notExists after proving selected subquery column is non-nullable; otherwise preserve NOT(IN-subquery) shape
  - Rationale: Silent wrong-result bug — three-valued SQL NULL semantics changed silently
  - Blast radius: ~25 LoC

- [ ] FIND-013 (M) `planner.ts:946` — Recursive includes force cte strategy before dialectCapabilities.supportsRecursiveCTE validation
  - Source: [codex]
  - Fix: Route recursive branch through selectSmartStrategy(relation, opts.dialectCapabilities, true) or explicitly check supportsRecursiveCTE
  - Rationale: Plan claims recursive CTE strategy on dialects that declared it unsupported
  - Blast radius: ~15 LoC

- [ ] FIND-014 (M) `planner.ts:964` — Auto include planning silently drops include.limit when join fallback chosen
  - Source: [codex]
  - Fix: Thread include.limit presence into determineIncludeStrategy; throw or choose limit-capable strategy when none exists
  - Rationale: Per-parent include limit is a result-shaping semantic; join returns too many child rows silently
  - Blast radius: ~20 LoC

- [ ] FIND-015 (M) `query-builder.ts:1862` — Lenient ambiguity resolution picks error.options[0] — insertion order decides query semantics
  - Source: [codex]
  - Fix: Do not auto-resolve ambiguous relations without an explicit hint; or require documented deterministic priority field on relations
  - Rationale: Schema insertion order change silently switches which relation is queried
  - Blast radius: ~15 LoC

---

## PR Bundle 3: Query-builder correctness — M (5 findings)

- [ ] FIND-016 (M) `query-builder.ts:893` — exists()/existsDump()/existsWithHooks skip AmbiguousPlanError handling used by all()
  - Source: [codex]
  - Fix: Use shared planning helper that catches AmbiguousPlanError and calls handleAmbiguity for all three exists paths
  - Rationale: Same ambiguous query auto-resolves for all() but throws for exists() — violates strict-mode contract
  - Blast radius: ~20 LoC

- [ ] FIND-017 (M) `query-builder.ts:1050` — stream() compiles SQL before beforeQuery hooks run; hook-modified intents discarded
  - Source: [codex]
  - Fix: Move planning/compilation inside the lazy first-next path after runBeforeQueryHooks
  - Rationale: Hook-aware all()/exists() allow beforeQuery to transform intent; stream() silently ignores hook modifications
  - Blast radius: ~30 LoC

- [ ] FIND-018 (M) `query-builder.ts:1189` — paginate() count query built from scratch, missing distinct/groupBy/join/include-filter state
  - Source: [codex]
  - Fix: Build count from full query intent with only limit/offset/order removed; or count a subquery of the compiled base query
  - Rationale: Totals wrong for distinct, groupBy, having, joins, include-filtered, hook-aware, or transaction-scoped queries
  - Blast radius: ~40 LoC

- [ ] FIND-019 (M) `query-builder.ts:1321` — cursorPaginate casts expression-based orderBy to string when no field property exists
  - Source: [codex]
  - Fix: Reject expression orderBy for cursorPaginate unless it has a stable output alias; use that alias for cursor encoding and predicates
  - Rationale: Expression ordering builds cursors under undefined key; cursor predicate omitted → repeated or skipped pages
  - Blast radius: ~25 LoC

- [ ] FIND-020 (M) `query-builder.ts:1334` — Backward cursor pagination changes comparison operator but keeps original ORDER BY direction
  - Source: [codex]
  - Fix: For backward fetches, invert each orderBy direction in DB query, fetch limit+1, reverse returned page before exposing
  - Rationale: Returns earliest rows below cursor rather than adjacent previous page
  - Blast radius: ~20 LoC

---

## PR Bundle 4: Schema-bridge correctness — M (5 findings)

- [ ] FIND-022 (M) `schema-bridge.ts:729` — Missing range types (tsrange, int8range, numrange); time/jsonb silently downgraded
  - Source: [codex]
  - Fix: Add missing range types to GeneratedColumnType, SchemaColumnTypeSchema, ColumnTypeToTS, generatedTypeToColumnType, mapSchemaColumnType; preserve time and jsonb
  - Rationale: Valid schema types rejected or silently downgraded before reaching ModelIR
  - Blast radius: ~50 LoC

- [ ] FIND-023 (M) `schema-bridge.ts:997` — convertColumn validates but does not copy index/references.onDelete/parentRole/childRole into GeneratedColumn
  - Source: [codex]
  - Fix: Conditionally copy index and all references subfields when building result.references
  - Rationale: Resolved schemas lose FK actions, recursive role metadata, and column index metadata during bridging
  - Blast radius: ~30 LoC

- [ ] FIND-024 (M) `schema-bridge.ts:1123` — Schema accumulator validators allow __proto__/constructor keys; accumulators use plain objects
  - Source: [codex]
  - Fix: Reject prototype-pollution keys in record validators; use Object.create(null) for all string-keyed accumulators
  - Rationale: Crafted schema can mutate accumulator prototypes or drop entries before ModelIR construction
  - Blast radius: ~20 LoC

- [ ] FIND-025 (M) `schema-bridge.ts:1128` — With-config table branch detects by columns property being object, misparsing legit column named "columns"
  - Source: [codex]
  - Fix: Detect with-config shape by requiring a discriminator (e.g. Array.isArray(tableObj.primaryKey)), or preserve Valibot union branch result
  - Rationale: Valid table with column named "columns" is routed through wrong branch and corrupted
  - Blast radius: ~20 LoC

- [ ] FIND-026 (M) `schema-bridge.ts:493` — buildRelationIR ignores targetKey and sourceKey from generated relation definitions
  - Source: [codex]
  - Fix: Carry sourceKey/targetKey into RelationIR or resolve them into explicit join-key metadata
  - Rationale: Relations against non-default keys planned as if joining through target PK → wrong joins
  - Blast radius: ~25 LoC

---

## PR Bundle 5: Performance — M (7 findings, plus 3 L)

- [ ] FIND-050 (M) `result-hydrator.ts:147` — hydrateJoinIncludes O(N×R×K) key scan + keysToDelete array per row
  - Source: [sonnet:perf, sonnet:perf] (merged PERF-9 + PERF-11)
  - Fix: Pre-scan first row's keys once to build Map<relation, string[]> key groups; reuse across rows; delete keys immediately in first loop rather than collecting
  - Rationale: 60K string comparisons on 1000×3×20; 3K array allocations per query removed
  - Blast radius: ~30 LoC

- [ ] FIND-051 (M) `planner.ts:274` — plan() allocates 3 spread+freeze arrays even for zero-include queries
  - Source: [sonnet:perf]
  - Fix: Use Object.freeze(state.decisions) directly without [...spread] — local array, no external reference
  - Rationale: 3 avoidable array allocations per query at 0 semantic cost
  - Blast radius: ~6 LoC

- [ ] FIND-052 (M) `planner.ts:337` — plan() exit scans decisions.find() for ambiguity — second pass over already-traversed array
  - Source: [sonnet:perf]
  - Fix: Set state.hasAmbiguity = true inside processInclude when ambiguity decision pushed; check flag at exit
  - Rationale: O(N) → O(1); negligible on small queries, measurable with 10+ includes
  - Blast radius: ~5 LoC

- [ ] FIND-053 (M) `planner.ts:1452` — extractCTEs calls decisions.find() and ctes.some() in a loop over relations — O(R×D)
  - Source: [sonnet:perf]
  - Fix: Build Map<string, PlanDecision> from decisions once before loop; Set<string> for CTE names
  - Rationale: O(R×D + R×C) → O(D + C + R)
  - Blast radius: ~15 LoC

- [ ] FIND-054 (M) `result-hydrator.ts:73` — hydrateIncludes builds intermediate array via .map().filter() per include per result set
  - Source: [sonnet:perf]
  - Fix: Replace with single for-loop pushing to pre-allocated array; skip null/undefined entries inline
  - Rationale: N×results-length extra array slots; ~15% fewer GC events on large result hydration
  - Blast radius: ~8 LoC

- [ ] FIND-055 (M) `result-hydrator.ts:128` — nested include hydration uses Array.from(map.values()).flat() materializing all children
  - Source: [sonnet:perf]
  - Fix: Replace with loop collecting into pre-allocated array; or pass Map values iterator directly
  - Rationale: O(total_children) allocation avoidable at each nested include level
  - Blast radius: ~8 LoC

- [ ] FIND-056 (M) `result-hydrator.ts:541` — extractKeyValue uses JSON.stringify for composite Map key per row per include
  - Source: [sonnet:perf]
  - Fix: Replace JSON.stringify(values) with values.join('\u0000') — 5× faster, collision-safe for PK values
  - Rationale: 9K JSON.stringify calls per query (3 calls × 1000 rows × 3 includes) → simple join
  - Blast radius: ~3 LoC

- [ ] FIND-057 (L) `result-hydrator.ts:479` — buildNestedHierarchy spreads every row for mutable node creation
  - Source: [sonnet:perf]
  - Fix: Mutate row objects in-place (already DB-result copies); add tree-linking property directly
  - Blast radius: ~10 LoC

- [ ] FIND-058 (L) `planner.ts:636` — optimizeInToExists AND/OR cases traverse array twice (map + every)
  - Source: [sonnet:perf]
  - Fix: Track changed flag during map pass; skip every() check entirely
  - Blast radius: ~6 LoC

- [ ] FIND-059 (L) `query-builder.ts:1444` — applyRelationHints calls Object.keys().length === 0 per query
  - Source: [sonnet:perf]
  - Fix: Track hint count as private field; check field instead
  - Blast radius: ~5 LoC

---

## PR Bundle 6: API / types hardening — M (9 findings, 2 L)

- [ ] FIND-030 (M) `orm-instance-types.ts:288` — OrmInstance.tables uses `any` for TRelations generic parameter
  - Source: [sonnet:api]
  - Fix: Replace `any` with concrete `RowToRelationRefs<K, DB>` or `Record<never, never>`
  - Rationale: Relation property accesses on table refs return `any` — type hole at the core public API boundary
  - Blast radius: ~15 LoC

- [ ] FIND-031 (M) `orm-instance-types.ts:359` — into/modify/removeFrom/upsertInto return unparameterized builders, discarding table row types
  - Source: [sonnet:api]
  - Fix: Parameterize return types with inferred row type: `into<T extends TableRef>(t: T): InsertBuilder<InferTableRow<T>>`
  - Rationale: Entire purpose of TableRef API is type propagation; lost at entry point
  - Blast radius: ~40 LoC

- [ ] FIND-032 (M) `mutation-builders.ts:408` — .returning() columns param not tied to R generic — false type promises
  - Source: [sonnet:api]
  - Fix: Add `R extends Record<string,unknown>` constraint; tie columns to `(keyof R & string)[]`
  - Blast radius: ~20 LoC

- [ ] FIND-033 (M) `mutation-builders.ts:210` — `return undefined as T` unsound when caller instantiates InsertBuilder<string> without .returning()
  - Source: [sonnet:api]
  - Fix: Two-state generic (InsertBuilder<TRow, TReturning = void>); execute() overloaded per state
  - Blast radius: ~50 LoC (medium complexity)

- [ ] FIND-034 (M) `query-builder.ts:226` — columns() implementation returns QueryBuilder<unknown> despite overloads promising TResult
  - Source: [sonnet:api]
  - Fix: Align implementation return type to QueryBuilder<TResult>
  - Blast radius: ~5 LoC

- [ ] FIND-035 (M) `orm-instance-types.ts:723` — OrmInstanceInternal exported publicly despite @internal JSDoc tag
  - Source: [sonnet:api]
  - Fix: Remove from dx/index.ts exports; add dependency-cruiser rule
  - Blast radius: callers-need-adjustment (audit downstream packages)

- [ ] FIND-036 (M) `set-operation-builder.ts:92` — SetOperationBuilderImpl exported publicly despite @internal tag
  - Source: [sonnet:api]
  - Fix: Remove from dx/index.ts; only export SetOperationBuilder interface
  - Blast radius: callers-need-adjustment

- [ ] FIND-037 (M) `query-builder-types.ts:268` — SelectExpressionResult.execute() defaults to unknown; no narrowing guidance
  - Source: [sonnet:api]
  - Fix: Change default to Record<string, unknown>; add JSDoc example with explicit typing
  - Blast radius: none (no callers impacted)

- [ ] FIND-038 (M) `set-operation-builder.ts:164` — dump() fakes PlanReport with empty rootTable via `as unknown as PlanReport`
  - Source: [sonnet:api]
  - Fix: Add discriminant field to Dump (planAvailable: boolean) or create SetOperationDump with plan: null
  - Blast radius: callers-need-adjustment

- [ ] FIND-039 (L) `index.ts:219` — SchemaValidationError exported twice as two different classes
  - Source: [sonnet:api]
  - Fix: Deprecate legacy SchemaValidationError from schema-dsl.js; make it extend new SchemaError
  - Blast radius: none

- [ ] FIND-040 (L) `conventions.ts:53` — IRREGULAR_PLURALS and DEFAULT_CONVENTIONS exported as mutable objects
  - Source: [sonnet:api]
  - Fix: Object.freeze() both; add Readonly<> type annotation
  - Blast radius: none

---

## PR Bundle 7: Docs update — S (7 M findings + selected L)

- [ ] FIND-060 (M) `CLAUDE.md:149` — compile-only adapter example uses direct adapter.compile() pattern
  - Source: [sonnet:docs] — DOC-1
  - Fix: Replace with ORM dump() pattern: `const dump = await orm.select('users').dump()`
  - Blast radius: 1 doc block

- [ ] FIND-061 (M) `CLAUDE.md:200` — fullTextSearch/textScore not mentioned in Query Features table
  - Source: [sonnet:docs] — DOC-2
  - Fix: Add row for `fullTextSearch(), textScore()` from @dbsp/core; link to how-to-use-full-text-search.md
  - Blast radius: 1 table row

- [ ] FIND-062 (M) `CLAUDE.md:209` — how-to-use-full-text-search.md and how-to-understand-result-hydration.md missing from Guides row
  - Source: [sonnet:docs] — DOC-3
  - Fix: Add both guides to the Guides row
  - Blast radius: 1 table cell

- [ ] FIND-063 (M) `docs/guides/how-to-use-case-expressions.md:14` — caseWhen() two exported forms conflated without distinction
  - Source: [sonnet:docs] — DOC-4
  - Fix: Document both forms; clarify import path for each; recommend fluent builder
  - Blast radius: ~15 lines in guide

- [ ] FIND-064 (M) `docs/guides/how-to-use-joins.md:59` — generated SQL form not explained (parenthesized FROM + outer alias)
  - Source: [sonnet:docs] — DOC-8
  - Fix: Add note that this is exact compiler output; explain outer alias
  - Blast radius: ~5 lines

- [ ] FIND-065 (M) `docs/guides/how-to-use-recursive-cte.md:19` — .execute() documented as alias for .all() — unverified
  - Source: [sonnet:docs] — DOC-13
  - Fix: Verify in raw-cte-builder.ts; update if wrong
  - Blast radius: ~5 lines

- [ ] FIND-066 (M) `packages/adapter-pgsql/README.md:39` — compile-only example shows `{ sql, parameters }` destructure
  - Source: [sonnet:docs] — DOC-23
  - Fix: Update to ORM dump() pattern
  - Blast radius: 1 doc block

- [ ] FIND-067 (L) `docs/guides/how-to-use-full-text-search.md:330` — truncated sentence
  - Source: [sonnet:docs] — DOC-9
  - Fix: Complete: "...it is more explicit, type-safe, and consistent with the ORM pattern."

- [ ] FIND-068 (L) `docs/guides/how-to-use-case-expressions.md:175` — CaseBuilderImpl listed in Key Files as if public
  - Source: [sonnet:docs] — DOC-5
  - Fix: Remove CaseBuilderImpl from Key Files list

- [ ] FIND-069 (L) `CLAUDE.md:181` — DropIndexOptions missing schema? field in DDL helpers table
  - Source: [sonnet:docs] — DOC-15
  - Fix: Add `schema?` to options summary

- [ ] FIND-070 (L) `CLAUDE.md:205` — "IN subquery" label misleading (actually compiles to ANY())
  - Source: [sonnet:docs] — DOC-25
  - Fix: Update label to "IN subquery (ANY)"; update SQL comment

- [ ] FIND-071 (L) Various guides — HNSW params shown as strings in extensions guide, numbers in ddl-helpers guide
  - Source: [sonnet:docs] — DOC-18
  - Fix: Use numbers consistently: `m: 16, ef_construction: 64`

---

## PR Bundle 8: SOLID refactor — XL (deferrable follow-up PR)

- [ ] FIND-080 (S) `orm-instance.ts:402` — createOrmInstance god-object: 13 positional params, 25 methods
  - Source: [sonnet:solid] — SOLID-1
  - Fix: Introduce QueryContext value-object; split HierarchyApi mixin
  - Blast radius: 494 LoC

- [ ] FIND-081 (S) `negotiate-features.ts:59` — negotiateFeatures 15 hard-coded DDL checks, CC=75 (OCP violation)
  - Source: [sonnet:solid] — SOLID-2
  - Fix: FeatureChecker[] registry; each DDL feature = pure function entry
  - Blast radius: 131 LoC

- [ ] FIND-082 (S) `query-builder.ts:89` — QueryBuilderImpl 1957 LoC, 40 methods, 13 params (SRP violation)
  - Source: [sonnet:solid] — SOLID-3
  - Fix: Extract PaginationMixin, StreamMixin, HookExecutor; replace ctor params with QueryBuilderContext struct
  - Blast radius: 2046 LoC

- [ ] FIND-083 (M) `query-builder.ts:1461` — applyHintToInclude copy-pasted verbatim between query-builder.ts and intent-builder.ts
  - Source: [sonnet:solid] — SOLID-4
  - Fix: Extract to include-utils.ts; both classes import
  - Blast radius: 29 LoC

- [ ] FIND-084 (M) `model-impl.ts:126` — buildRelationsBySourceIndex / buildRelationsByTargetIndex structural clones
  - Source: [sonnet:solid] — SOLID-5
  - Fix: Merge into buildRelationIndex(relations, keyFn) called twice
  - Blast radius: 40 LoC

- [ ] FIND-085 (M) `filters.ts:562` — rawExists / rawNotExists structural clones (9 LoC each)
  - Source: [sonnet:solid] — SOLID-6
  - Fix: Extract resolveSubqueryIntent helper; both delegate to it
  - Blast radius: 18 LoC

- [ ] FIND-086 (M) `query-builder.ts:405` — forUpdate/forShare/forNoKeyUpdate/forKeyShare structural clones
  - Source: [sonnet:solid] — SOLID-7
  - Fix: Thin wrappers calling this.lock(strength)
  - Blast radius: 40 LoC

- [ ] FIND-087 (M) `query-builder.ts:1971` — union/intersect/except set-operation clones (6 methods)
  - Source: [sonnet:solid] — SOLID-8
  - Fix: Extract createSetOperation(op, other, all) helper
  - Blast radius: 83 LoC

- [ ] FIND-088 (M) `cte-builder.ts:188` — CteBuilder.all()/dump() and RawCteQueryBuilder.all()/dump() structural clones
  - Source: [sonnet:solid] — SOLID-9
  - Fix: AbstractCteBuilder base class or executeBuilderQuery() utility
  - Blast radius: 50 LoC

- [ ] FIND-089 (M) `planner.ts:881` — processInclude 219 LoC, CC=42 (7 distinct responsibilities)
  - Source: [sonnet:solid] — SOLID-10
  - Fix: Decompose into resolveRelationOrWarn, determineStrategy, emitIncludeDecision, emitJoinDecision
  - Blast radius: 219 LoC

- [ ] FIND-090 (M) `negotiate-features.ts:47` — NegotiationResult exported but zero external callers
  - Source: [sonnet:solid] — SOLID-11
  - Fix: Remove export or move to packages/types as public API
  - Blast radius: 5 LoC

- [ ] FIND-091 (M) `query-builder.ts:312` — sum()/avg() structural clones; count/min/max similar pattern
  - Source: [sonnet:solid] — SOLID-12
  - Fix: Extract addAggregate(fn, field, as) helper
  - Blast radius: 80 LoC

- [ ] FIND-092 (M) `hydration-utils.ts:15` — hydrateJsonAggIncludes 113 LoC, CC=69 (3 distinct tasks)
  - Source: [sonnet:solid] — SOLID-13
  - Fix: Extract buildRelationInfoMap, findActualColumnName; slim coordinator loop
  - Blast radius: 113 LoC

- [ ] FIND-093 (M) `typed-query-builder.ts:66` — FromBuilder/TypedOrm/RecursiveQueryBuilder exported with zero callers
  - Source: [sonnet:solid] — SOLID-14
  - Fix: Confirm no re-exports in index.ts; remove dead exports
  - Blast radius: 30 LoC

- [ ] FIND-094 (M) `query-builder.ts:1807` — buildExistsIntent/existsDump/exists() 5 method structural clones between QueryBuilderImpl and TypedQueryBuilder
  - Source: [sonnet:solid] — SOLID-15
  - Fix: TypedQueryBuilder extends or delegates to QueryBuilderImpl for these methods
  - Blast radius: 80 LoC

- [ ] FIND-095 (M) `assertion-parser.ts:116` — parseAssertionFile 84 LoC, CC=50 (5 concerns, manual index advancing)
  - Source: [sonnet:solid] — SOLID-16
  - Fix: Extract LineScanner class; thin state machine outer
  - Blast radius: 84 LoC

- [ ] FIND-096 (M) `query-builder.ts:1638` — executeWithHooksInner 164 LoC, CC=31 (9 pipeline stages, 3 copy-pasted error hook blocks)
  - Source: [sonnet:solid] — SOLID-17
  - Fix: Extract withErrorHook(phase, fn) wrapper; reduce visible stages from 9 to 4
  - Blast radius: 164 LoC

---

## Deferred (L findings, not blocking merge)

- [ ] FIND-097 (L) `adapter.ts:78` — supportsStreaming/supportsIntrospection/supportsDDLGeneration structural clones (SOLID-18) → defer to TODO.md post-merge
- [ ] FIND-098 (L) `query-builder.ts:1429` — getConfiguredAdapter/requireAdapter structural clones (SOLID-19) → defer to TODO.md
- [ ] FIND-099 (L) `mutation-builders.ts:728` — InsertBuilder.returning()/UpsertBuilder.returning() clones (SOLID-20) → defer: move to MutationBuilderBase
- [ ] FIND-100 (L) `filters.ts:794` — raw()/sql() escape-hatch no linter enforcement (SEC-11) → defer: add Biome rule
- [ ] FIND-101 (L) `orm-instance-types.ts:468` — listAncestors/listDescendants default to unknown (API-12) → fix: change to Record<string,unknown>
- [ ] FIND-102 (L) `query-builder-types.ts:70` — QueryBuilder<TResult = unknown> default (API-16) → fix: change to Record<string,unknown>
- [ ] FIND-103 (L) `query-builder.ts:1783` — mainResults as unknown as R cast in include hydration (API-13) → tag as tech debt with TODO comment
- [ ] FIND-104 (L) `intent-ast.ts:12` — wildcard re-export of @dbsp/types (API-14) → fix: explicit named re-exports
- [ ] FIND-105 (L) `dx/index.ts:174` — IntentBuilder exported without @internal tag (API-15) → add @internal, remove from public surface
- [ ] FIND-106 (L) Various docs L findings (DOC-5, DOC-6/16 buildTableDDL, DOC-7 isDistinctFrom, DOC-9 truncated, DOC-10 PolicyIR, DOC-11 createOrm dual-API, DOC-14 extensions README path, DOC-17 schema-versioning cross-ref, DOC-19 API example promotes string-based select, DOC-20 SQL quoting, DOC-21 dump/intent, DOC-22 default LEFT JOIN, DOC-24 raw intent in joins Example 5) → bundle in docs PR or defer
- [ ] FIND-107 (L) Planner minor allocs: generateDecisionId type.replace() (PERF-6), applyRelationHints Object.keys() per query (PERF-13), clone() hints spread (PERF-14) → defer to perf follow-up

---

## Full finding list (sortable)

| FIND-ID | Source-ID | Severity | Bundle | File | Concern |
|---------|-----------|----------|--------|------|---------|
| FIND-001 | SEC-5 | S | 1 | `orm-instance.ts:574` | Security |
| FIND-002 | SEC-1 | M | 1 | `orm-instance.ts:521` | Security |
| FIND-003 | SEC-2 | M | 1 | `orm-instance.ts:870` | Security |
| FIND-004 | SEC-3 | M | 1 | `query-builder.ts:1255` | Security |
| FIND-005 | SEC-4 | M | 1 | `object-filter.ts:290` | Security |
| FIND-006 | SEC-6 | M | 1 | `errors.ts:280` | Security |
| FIND-007 | SEC-8 | M | 1 | `orm-instance.ts:577` | Security |
| FIND-008 | SEC-9 | M | 1 | `filters.ts:737` | Security |
| FIND-009 | SEC-10 | M | 1 | `query-builder.ts:812` | Security |
| FIND-010 | SEC-12 | M | 1 | `orm-instance.ts:713` | Security |
| FIND-011 | SEC-13 | M | 1 | `query-builder.ts:573` | Security |
| FIND-012 | CODEX-1 | M | 2 | `planner.ts:661` | Codex |
| FIND-013 | CODEX-2 | M | 2 | `planner.ts:946` | Codex |
| FIND-014 | CODEX-3 | M | 2 | `planner.ts:964` | Codex |
| FIND-015 | CODEX-10 | M | 2 | `query-builder.ts:1862` | Codex |
| FIND-016 | CODEX-4 | M | 3 | `query-builder.ts:893` | Codex |
| FIND-017 | CODEX-5-stream | M | 3 | `query-builder.ts:1050` | Codex |
| FIND-018 | CODEX-5-paginate | M | 3 | `query-builder.ts:1189` | Codex |
| FIND-019 | CODEX-6 | M | 3 | `query-builder.ts:1321` | Codex |
| FIND-020 | CODEX-7 | M | 3 | `query-builder.ts:1334` | Codex |
| FIND-021 | SEC-7+CODEX-8 | M | 1 | `query-builder.ts:537` | Security+Codex (merged) |
| FIND-022 | CODEX-11 | M | 4 | `schema-bridge.ts:729` | Codex |
| FIND-023 | CODEX-13 | M | 4 | `schema-bridge.ts:997` | Codex |
| FIND-024 | CODEX-12 | M | 4 | `schema-bridge.ts:1123` | Codex |
| FIND-025 | CODEX-14 | M | 4 | `schema-bridge.ts:1128` | Codex |
| FIND-026 | CODEX-15 | M | 4 | `schema-bridge.ts:493` | Codex |
| FIND-030 | API-1 | M | 6 | `orm-instance-types.ts:288` | API |
| FIND-031 | API-2 | M | 6 | `orm-instance-types.ts:359` | API |
| FIND-032 | API-3 | M | 6 | `mutation-builders.ts:408` | API |
| FIND-033 | API-4 | M | 6 | `mutation-builders.ts:210` | API |
| FIND-034 | API-5 | M | 6 | `query-builder.ts:226` | API |
| FIND-035 | API-6 | M | 6 | `orm-instance-types.ts:723` | API |
| FIND-036 | API-7 | M | 6 | `set-operation-builder.ts:92` | API |
| FIND-037 | API-8 | M | 6 | `query-builder-types.ts:268` | API |
| FIND-038 | API-9 | M | 6 | `set-operation-builder.ts:164` | API |
| FIND-039 | API-10 | L | 6/defer | `index.ts:219` | API |
| FIND-040 | API-11 | L | 6/defer | `conventions.ts:53` | API |
| FIND-050 | PERF-9+PERF-11 | M | 5 | `result-hydrator.ts:147` | Perf (merged) |
| FIND-051 | PERF-1 | M | 5 | `planner.ts:274` | Perf |
| FIND-052 | PERF-2 | M | 5 | `planner.ts:337` | Perf |
| FIND-053 | PERF-3 | M | 5 | `planner.ts:1452` | Perf |
| FIND-054 | PERF-7 | M | 5 | `result-hydrator.ts:73` | Perf |
| FIND-055 | PERF-8 | M | 5 | `result-hydrator.ts:128` | Perf |
| FIND-056 | PERF-10 | M | 5 | `result-hydrator.ts:541` | Perf |
| FIND-057 | PERF-15 | L | 5/defer | `result-hydrator.ts:479` | Perf |
| FIND-058 | PERF-5 | L | 5/defer | `planner.ts:636` | Perf |
| FIND-059 | PERF-13 | L | 5/defer | `query-builder.ts:1444` | Perf |
| FIND-060 | DOC-1 | M | 7 | `CLAUDE.md:149` | Docs |
| FIND-061 | DOC-2 | M | 7 | `CLAUDE.md:200` | Docs |
| FIND-062 | DOC-3 | M | 7 | `CLAUDE.md:209` | Docs |
| FIND-063 | DOC-4 | M | 7 | `how-to-use-case-expressions.md:14` | Docs |
| FIND-064 | DOC-8 | M | 7 | `how-to-use-joins.md:59` | Docs |
| FIND-065 | DOC-13 | M | 7 | `how-to-use-recursive-cte.md:19` | Docs |
| FIND-066 | DOC-23 | M | 7 | `adapter-pgsql/README.md:39` | Docs |
| FIND-067 | DOC-9 | L | 7 | `how-to-use-full-text-search.md:330` | Docs |
| FIND-068 | DOC-5 | L | 7 | `how-to-use-case-expressions.md:175` | Docs |
| FIND-069 | DOC-15 | L | 7 | `CLAUDE.md:181` | Docs |
| FIND-070 | DOC-25 | L | 7 | `CLAUDE.md:205` | Docs |
| FIND-071 | DOC-18 | L | 7 | `how-to-use-extensions.md:41` | Docs |
| FIND-080 | SOLID-1 | S | 8 | `orm-instance.ts:402` | SOLID |
| FIND-081 | SOLID-2 | S | 8 | `negotiate-features.ts:59` | SOLID |
| FIND-082 | SOLID-3 | S | 8 | `query-builder.ts:89` | SOLID |
| FIND-083 | SOLID-4 | M | 8 | `query-builder.ts:1461` | SOLID |
| FIND-084 | SOLID-5 | M | 8 | `model-impl.ts:126` | SOLID |
| FIND-085 | SOLID-6 | M | 8 | `filters.ts:562` | SOLID |
| FIND-086 | SOLID-7 | M | 8 | `query-builder.ts:405` | SOLID |
| FIND-087 | SOLID-8 | M | 8 | `query-builder.ts:1971` | SOLID |
| FIND-088 | SOLID-9 | M | 8 | `cte-builder.ts:188` | SOLID |
| FIND-089 | SOLID-10 | M | 8 | `planner.ts:881` | SOLID |
| FIND-090 | SOLID-11 | M | 8 | `negotiate-features.ts:47` | SOLID |
| FIND-091 | SOLID-12 | M | 8 | `query-builder.ts:312` | SOLID |
| FIND-092 | SOLID-13 | M | 8 | `hydration-utils.ts:15` | SOLID |
| FIND-093 | SOLID-14 | M | 8 | `typed-query-builder.ts:66` | SOLID |
| FIND-094 | SOLID-15 | M | 8 | `query-builder.ts:1807` | SOLID |
| FIND-095 | SOLID-16 | M | 8 | `assertion-parser.ts:116` | SOLID |
| FIND-096 | SOLID-17 | M | 8 | `query-builder.ts:1638` | SOLID |
| FIND-097 | SOLID-18 | L | defer | `adapter.ts:78` | SOLID |
| FIND-098 | SOLID-19 | L | defer | `query-builder.ts:1429` | SOLID |
| FIND-099 | SOLID-20 | L | defer | `mutation-builders.ts:728` | SOLID |
| FIND-100 | SEC-11 | L | defer | `filters.ts:794` | Security |
| FIND-101 | API-12 | L | defer | `orm-instance-types.ts:468` | API |
| FIND-102 | API-16 | L | defer | `query-builder-types.ts:70` | API |
| FIND-103 | API-13 | L | defer | `query-builder.ts:1783` | API |
| FIND-104 | API-14 | L | defer | `intent-ast.ts:12` | API |
| FIND-105 | API-15 | L | defer | `dx/index.ts:174` | API |
| FIND-106 | DOC-6/10/11/14/16/17/19/20/21/22/24/7/12 | L | defer | Various docs | Docs |
| FIND-107 | PERF-4/6/12/14 | L | defer | Various planner/builder | Perf |
