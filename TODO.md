# db-semantic-planner TODO

> Consolidated 2026-02-05 from BACKLOG*.md + audit findings + legacy TODOs

## In Progress

- [x] ✅ **INCLUDE-WHERE-EXPR** [Adapter] Fix `op().eq()` expressions in `include({ where })` silently dropped — `convertWhereToDecisions()` in `plan-decision-extractor.ts` now handles `case 'expression'` (same as `convertWhereCondition`); 5 regression tests in `include-where-regex.test.ts` (2026-03-24)

- [x] ✅ **OUTERREF-NOTEXISTS** [Adapter] Fix `outerRef('col')` in `notExists({ where: neq/eq(...) })` serialized as JSON parameter instead of column reference — `convertWhereToDecisions()` (SELECT/ORM path, plan-decision-extractor.ts) and `convertWhereCondition()` (mutation path, intent-to-decisions.ts) now detect `SubqueryRefIntent { kind: 'ref' }` and convert to `FieldRef { kind: 'fieldRef', scope: 'outer' }` before creating decision; `compileValueOrFieldRef` then routes to `columnRef()`; 3 regression tests in `outerref-in-notexists.test.ts` (2026-03-24)

- [x] ✅ **NOTEXISTS-AND** [Adapter] Fix `notExists()` inside `and()` generating duplicate NOT EXISTS clauses — `stripExistsFromDecision()` replaces flat filter in `compileSelect` with recursive strip that removes exists/notExists from whereAnd/whereOr/whereNot containers too; 7 regression tests in `notexists-in-and.test.ts`, 2903 adapter + 2197 core tests pass (2026-03-24)

- [x] ✅ **NOTEXISTS-INVERSE** [Core/Adapter] Fix `notExists('callee_calls')` resolving to wrong table — planner correctly uses `model.getRelation()` to resolve inverse hasMany relation name to real target table; test gap filled with 10 regression tests in `notexists-inverse-relation.test.ts` (2026-03-24)
- [x] ✅ **GROUPBY-INCLUDE-JOIN** [Adapter] Fix `include(join) + groupBy()` — joined table hydration columns not in GROUP BY cause PostgreSQL error; `compileSelect` now strips `columns` from join `includeStrategy` when `hasGroupBy`; 5 regression tests in `groupby-include-join.test.ts` (2026-03-24)
- [x] ✅ **NULLS-LAST-EXPR** [Core] Fix `orderBy(op(...), dir, { nulls: 'last' })` — ExpressionRef/ExpressionSpec branches in `orderBy()` now propagate `options.nulls`; added `options` param to TypeScript overloads in `query-builder-types.ts`; 6 regression tests in `orderby-expr-nulls.test.ts` (2026-03-24)
- [x] ✅ **NOTEXISTS-JOIN** [Core/Adapter] Add `include` option to `exists()`/`notExists()` for JOIN inside subquery — `notExists('rel', { include: { alias: { join: 'inner' } }, where: ... })` generates `NOT EXISTS (SELECT 1 FROM target JOIN joined ON fk WHERE ...)` via both DELETE mutation path and SELECT ORM path; FK resolution from ModelIR; 9 tests in `notexists-join.test.ts`, 954 adapter unit tests pass, TSC clean (2026-03-23)

- [x] ✅ **GROUPBY-REL** [Adapter] Fix `groupBy(['id', 'relation.col'])` with INNER JOIN — dotted column names in `groupBy` case of `compileSelect` now split on `.` to produce `columnRef(col, table)` instead of wrong `columnRef('rel.col', rootTable)`; 3 regression tests in `groupby-relation.test.ts` (2026-03-23)
- [x] ✅ **FN-REF-DOT** [Adapter] Verify `fn('min', ref('rel.col'))` resolves JOIN alias — `ref` case in `compileExpressionIntent` already splits on `.`; no code change needed; 5 confirmation tests in `fn-relation-col.test.ts` using `exprRef()` (correct API alias for expression col refs) (2026-03-23)

- [x] ✅ **ORM-TABLES-TYPE** [Core] Fix `orm.from(table).columns([...]).all()` type inference — added `RowToColumnRefs<TTable, TRow>` utility type in `orm-instance-types.ts`, updated `tables` from `TableRef<K, any, any>` to `TableRef<K, RowToColumnRefs<K, DB[K]>, any>`; zero runtime changes; 2 new type-level tests (SC-17, SC-18); 2184 core tests pass, TSC clean (2026-03-23)

- [x] ✅ **DX-040-SURFACE** [Core] Add `orm.tables` + `orm.from(tableRef)` to OrmInstance — exposes pre-built tables proxy, from() extracts table name via TABLE_META and delegates to QueryBuilder; `select()` deprecated in type; `InferTables` exported from index; 10 tests, 2160 tests pass, TSC clean (2026-03-23)

- [x] ✅ **LIKE-ESCAPE** [Core/Adapter] Add `escape` option to `like()` — `like('col', 'pat', { escape: '\\' })` → `WHERE col LIKE $1 ESCAPE $2`; modified WhereLikeIntent, filters.ts, intent-to-decisions, likeHandler, deparseAExpr, mapToHandlerDecision; 10 tests (2026-03-23)
- [x] ✅ **NULLS-LAST** [Core] Add `orderBy('col', 'desc', { nulls: 'last' })` overload — threads through query-builder.ts (already supported in array/intent layer); 4 tests (2026-03-23)

- [x] ✅ **REF-VS-REF** [Adapter/Core] Fix `op('!=', exprRef('a'), exprRef('b'))` producing `__expr != __expr` — added `instanceof ExpressionRef` detection in `query-builder.ts` `where()` + standalone boolean expression support in `custom-expression.ts`; 4 regression tests (2026-03-23)
- [x] ✅ **WINDOW-FN-BARE** [Adapter] Fix `wCount().as('total')` (no partitionBy/orderBy) not emitting `OVER()` clause — set `frameOptions: 1034` in `buildWindowDef()` for empty window; 3 regression tests (2026-03-23)
- [x] ✅ **NESTED-INSUBQUERY** [Adapter] Fix 2-level nested inSubquery compilation — `mapInSubqueryCondition` in compiler.ts recursively converts `in+subquery` PlanDecisions before `mapToHandlerDecision` strips the subquery field; 3 regression tests (2026-03-23)

- [x] ✅ **CORE-SET-OPS** [Core] Add `.union()`, `.unionAll()`, `.intersect()`, `.except()` to QueryBuilder — 19 tests, typecheck clean (2026-03-21)
- [x] ✅ **ADAPTER-PARAM-CAST** [Adapter] Explicit parameter type casting in WHERE/IN comparisons — emits CAST($N AS type) when originalDbType is set in ModelIR, 14 tests, no existing test regressions (2026-03-21)
- [x] ✅ **SEC-DDL** [Adapter] Fix 5 DDL security findings: validateSqlExpression + validateDbTypeName in validate.ts; quoteIdentifier, formatDefaultValue, generateCreatePolicy hardened in ddl-generator.ts; mapColumnType and resolveColumnPgType validated; 26 security tests — 2811 tests pass, 0 new TS errors (2026-03-22)
- [x] ✅ **BATCH-INSERT-NULLABLE-INT** [Adapter] Fix schema-driven int4[] inference for nullable integer columns in batch unnest inserts — remove RANGE_TYPES filter in getColumnTypes(), extend mapToPgBaseType() with ColumnType aliases, prefer originalDbType; 4 regression tests added (2026-03-22)
- [x] ✅ **REF-IN-FILTER** [Adapter] Fix buildColumnRef() to split dotted column names — ref('alias.col') in filter(isNotNull()) now produces alias.col instead of root.alias.col; 5 regression tests added (2026-03-22)
- [x] ✅ **DOUBLE-ALIAS** [Adapter] Fix duplicate JOIN aliases when include('def.file') + include('file') both resolve to alias 'file' — add usedJoinAliases Set in PlanCompiler, deduplicate with _N suffix before handler.compile(); 3 regression tests added (2026-03-22)

- [ ] 🟡 **GUI-026** [GUI] Dirty tab confirmation + session persistence + app close guard — Priority: P1
  - [ ] GUI-026a: Confirm before closing dirty tab (call confirmUnsavedChanges)
  - [ ] GUI-026b: Confirm before closing app with dirty tabs (Tauri window close event)
  - [ ] GUI-026c: Persist editor tabs across sessions (Zustand persist middleware)

(GUI-025 archived → docs/historic/done-2026-02.md)

(Archived → docs/historic/done-2026-02.md)

---

## Bugs

- [x] ✅ **BATCH-INSERT-NULLABLE-INT** [Adapter] `getColumnTypes()` filtered RANGE_TYPES only → nullable int columns got `text[]`. Fix: removed filter, all column types now in type map. 4 regression tests in `batch-insert-nullable-int.test.ts`. (2026-03-22)

- [x] ✅ **REF-IN-FILTER** [Core] `buildColumnRef()` didn't split qualified names → `ref('alias.col')` produced 3-part name. Fix: split on `.` like expression handler. 5 regression tests in `ref-in-filter.test.ts`. (2026-03-22)
- [x] ✅ **DOUBLE-ALIAS** [Core] Join aliases derived from leaf relation name only → collision. Fix: `usedJoinAliases` Set in PlanCompiler, suffix dedup `_1`. 3 regression tests in `double-alias.test.ts`. (2026-03-22)
- [x] ✅ **RAW-IN-COLUMNS** [Core] rawHandler read `value` (undefined) instead of `args[0]` + WASM TypeCast hack. Fix: read `args[0]`, RawSQL deparser node (no WASM). 5 regression tests in `raw-in-columns.test.ts`. (2026-03-22)
- [x] ✅ **INCLUDE-2HOP-FILE** [Core] `.include('symbol.file', {join})` 2-hop join — outer `symbol` wrapper got no explicit join → json_agg strategy → inner `file` join ON clause referenced `symbols` not in outer FROM. Fix: `parseDotNotationInclude` propagates `join` option to ALL intermediate wrappers. 4 regression tests in `include-2hop-file.test.ts`. (2026-03-22)
- [x] ✅ **NESTED-INSUBQUERY** [Adapter] `mapToHandlerDecision()` dropped `subquery` field → nested inSubquery compiled with wrong handler. Fix: `mapInSubqueryCondition()` recursive method preserves subquery chain. 3 regression tests in `nested-insubquery.test.ts`. (2026-03-23)
- [x] ✅ **DISTINCT-VECTOR** [Adapter] `.distinct()` with `.include()` — join include pushed all joined columns (incl. `vector(1024)`) into SELECT DISTINCT. Fix: `compileSelect` detects `intent.distinct===true` and clears `columns` from join includeStrategy decisions (keeps JOIN for filtering). 4 regression tests in `distinct-include.test.ts`. (2026-03-22)
- [x] ✅ **GTE-IN-DELETE** [Core] `normalizeToDecision` for `kind:'in'` returned `values:` but `inHandler` reads `value:` → key mismatch silently discarded inArray values. Fix: `values:` → `value:`. 4 regression tests in `gte-in-delete.test.ts`. (2026-03-22)
- [x] ✅ **INCLUDE-NULLABLE-FK** [Adapter] Param type casting via `resolveColumnPgType()` + `originalDbType` → `CAST($N AS type)`. Fix covers all WHERE comparisons. 14 regression tests in `param-type-cast.test.ts`. (2026-03-22)
- [x] ✅ **INTRO-OIDVECTOR** [Adapter] `introspect()` opclass join cast `oidvector → int2[]` rejected by PG — fixed to `oidvector → oid[]` in index catalog query (2026-03-21)
- [x] ✅ **INTRO-INDEXES** [Adapter] `introspect()` index catalog query had `$1` accidentally replaced with a JS `//` comment inside a template literal — PostgreSQL received the raw comment text as SQL, failing with `syntax error at or near "Indexes"`. Fixed: restored `WHERE n.nspname = $1`. Regression tests added. (2026-03-21)
- [x] ✅ **FN-REF-ALIAS** [Core/Adapter] Investigated: `exprRef('col')` inside `fn()` already compiles to unqualified `col` (no root table prefix). Root cause confirmed: `case 'ref'` in `compileExpressionIntent` correctly emits `columnRef(col, undefined)`. 6 regression tests added in `fn-ref-alias.test.ts` locking the correct behavior. (2026-03-21)
- [x] ✅ **REF-STAR** [Core] `star()` primitive added — `fn('count', star())` → `COUNT(*)`. `array(...items)` primitive added — `ARRAY[item1, item2, ...]`. Both exported from `@dbsp/core`. `booleanSearch()` updated to use `namedArg('should', array(...exprs))`. (2026-03-21)
- [x] ✅ **FN-JSON-BUILD** [Adapter] Investigated: NOT a bug. `compileExpressionIntent` correctly compiles all arg counts for `customFn` via recursive map. Nested `fn()` works. Root cause of user confusion: bare string args in `fn()` become `ref()` (column refs) via implicit conversion — users must use `literal('name')` for string literal keys. 4 regression tests added in `custom.test.ts` documenting the correct pattern and the implicit conversion trap. (2026-03-21)
- [x] ✅ **FN-FILTER** [Core/Adapter] Added `.filter(condition)` to `ExpressionRef` for aggregate FILTER clause support on `fn()` expressions. `CustomFnExpressionIntent` gets `filter?: WhereIntent`. FILTER compilation handled in `compiler.ts` `selectCustomExpression` branch (avoids circular deps). 9 new tests. (2026-03-21)
- [x] ✅ **SUBQ-AS-EXPR** [Core/Adapter] Added `SubqueryExpression.asExpr(alias)` and `SubqueryBuilder.asExpr(alias)` — scalar subqueries usable as SELECT columns. `SubqueryExpressionIntent` (`kind: 'subquery'`) now handled in `compileExpressionIntent`, producing `SubLink { EXPR_SUBLINK }` AST. Inner compiler injected via `ctx.compileSubquery` callback in `selectCustomExpression` branch. Inner `$N` params renumbered by `paramOffset` to avoid collision with outer params. 9 new tests in `subquery-select.test.ts`. (2026-03-21)
- [x] ✅ **WCOUNT-STAR** [Core] `wCount()` now accepts optional field — `wCount()` with no arg produces `COUNT(*) OVER(...)`, `wCount('id')` produces `COUNT("id") OVER(...)`. `WindowFunctionKind.aggregate.field` made optional, `exactOptionalPropertyTypes`-safe via conditional spread. 3 builder tests + 2 compiler SQL tests added. (2026-03-21)
- [x] ✅ **RELATION-COL-RESULT** [Adapter] `relationColumn('file', 'path', 'file_path')` in `.columns([...])` with join strategy — user alias `file_path` was dropped. Root cause: `relationColumnsMap` stored only column names (not aliases), `mapToHandlerDecision` did not propagate `columnAliases`, and `joinIncludeHandler` used `relation.col` fallback unconditionally. Fixed: `RelationColumnEntry` preserves aliases, `columnAliases` field added to `PlanDecision`/`Decision`, propagated through `mapToHandlerDecision`, used in `joinIncludeHandler`. 5 new tests (3 unit + 2 integration). (2026-03-21)
- [x] ✅ **ORDERBY-RELATION-COL** [Core/Adapter] `orderBy(relationColumn('callerFile', 'path'))` generated literal `"calls.__expr"` SQL. Two-part fix: (1) `orderBy()` in `QueryBuilderImpl` checked `instanceof ExpressionRef` but not plain `ExpressionSpec` — added `isExpressionSpec()` branch to produce `OrderByIntent.expression`. (2) `compileExpressionIntent` in `custom.ts` had no `'relationColumn'` case — added case that resolves alias from `state.aliases` (falls back to relation name, which is the SQL JOIN alias). `ExpressionRef` + `ExpressionSpec` overloads added to public `QueryBuilder` interface. 5 regression tests in `orderby-relation-col.test.ts`. (2026-03-21)
- [x] ✅ **INCLUDE-WHERE-SCOPE** [Adapter] `include('file', { join: 'inner', where: eq('project_id', pid) })` — WHERE conditions were dropped in `toJoinIncludeDecision()`. Fix: (1) extract `where` → `conditions` scoped to join alias, (2) forward `joinType` from planner decision, (3) skip `_compiledFilterWhere` pre-compilation for join strategy, (4) fold conditions into root WHERE via `dispatchWhere` with correct alias. 7 new tests. (2026-03-21)
- [x] ✅ **DELETE-NOT-EXISTS** [Adapter] `notExists()` / `exists()` in `delete().where()` — `normalizeToDecision` had no case for `kind='exists'/'notExists'`, operator fell back to `'='`, routed to wrong handler. Fix: added `case 'exists'/'notExists'` in `normalizeToDecision` + removed `requiredColumn` hard-fail for `sourceColumn` in `buildExistsSubquery` (fallback to PK convention). 4 regression tests. (2026-03-21)
- [x] ✅ **ORDERBY-RELATION-COL** [Adapter] duplicate entry — see fix above (2026-03-21)
- [x] ✅ **INCLUDE-COUNT** [Adapter] `include(join) + .count()` — join include pushed column ResTargets into SELECT, mixing COUNT(*) with non-aggregate columns → PostgreSQL rejected. Fix: in `compileSelect` (adapter-compiler-select.ts), detect aggregate-only intent (no `fields`) and clear `columns` from join `includeStrategy` decisions — JOIN is kept for filtering, SELECT stays COUNT(*) only. 7 regression tests in `include-count.test.ts`. (2026-03-21)
- [x] ✅ **INCLUDE-2HOP-COLS** [Adapter] `relationColumn('callee.file', 'path', 'file_path')` threw "Unknown column 'path' in relation 'callee'" — `relationColumnsMap` used root segment as key, injecting 2nd-hop columns into the 1st-hop include decision. Fix: use full path as map key (`'callee.file'`) and resolve via suffix match (`'.file'`) when injecting into leaf `includeStrategy` decisions. 8 regression tests in `include-2hop-cols.test.ts`. (2026-03-21)
- [x] ✅ **INCLUDE-WHERE-SCOPE-2HOP** [Adapter] `include('symbol.file', { join: 'inner', where: eq('project_id', pid) })` — WHERE scope fix (INCLUDE-WHERE-SCOPE) only works for 1-hop includes. On 2-hop (`symbol.file`), the WHERE condition still leaks — `getUnresolvedParents` returns rows from ALL projects instead of just the target. Reproducer: `orm.select('symbol_parents').include('symbol', {join:'inner'}).include('symbol.file', {join:'inner', where: eq('project_id', 1)})` returns parents from project 2 as well. Astix integration test: `orm-migration.spec.ts > getUnresolvedParents`. — Priority: P0 Fixed: `resolveIncludeByPath(intentPath)` in `toJoinIncludeDecision` replaces flat `find()`; traverses nested include tree via `context.intentPath`. 3 regression tests in `include-where-2hop.test.ts`. (2026-03-21)
- [x] ✅ **DELETE-NOTEXISTS-ALIAS** [Adapter] `orm.delete('embeddings').where(notExists('symbol')).returning(['id'])` — the generated SQL uses the relation alias `"symbol"` as table name instead of the actual table name `"symbols"`. PG error: `relation "symbol" does not exist`. The DELETE-NOT-EXISTS fix resolved the routing, but the table name resolution still uses the schema alias. Astix integration test: `orm-migration.spec.ts > deleteOrphanEmbeddings`. — Priority: P1 Fixed: `resolveExistsIntent()` in `compileDelete` uses `model.getRelation()` to map relation name to real table; `normalizeToDecision` reads `raw.targetTable` first. 4 regression tests in `delete-notexists-alias.test.ts` + `mutations.test.ts`. (2026-03-21)
- [x] ✅ **ORDERBY-COMPUTED-EXPR** [Adapter] `orderBy(op('-', ref('end_line'), ref('start_line')), 'asc')` — computed arithmetic expressions in ORDER BY are not supported. `getSymbol` (line-based branch) needs `ORDER BY (end_line - start_line) ASC` to return the narrowest enclosing symbol. Current workaround: stays on orm.raw(). — Priority: P2 Verified: NOT a bug. `op()` with `exprRef()` args already handled by `compileExpressionIntent` (kind=op). Bug was caller using schema DSL `ref()` instead of `exprRef()`. 4 regression tests in `orderby-computed-expr.test.ts`. (2026-03-21)
- [x] ✅ **INCLUDE-2HOP** [Adapter] `include('callee.file')` resolved FK on ROOT table instead of intermediate table. Fixed: `toJoinIncludeDecision` now propagates `sourceTable`; `mapToHandlerDecision` uses `pd.sourceTable ?? rootTable` for `deriveFkColumns`; `PlanCompiler` tracks `joinAliasMap` (targetTable→alias) so 2nd-hop `currentAlias` resolves to the intermediate alias (e.g., `callee`) not the root. 2 regression tests added. (2026-03-21)

---

## Feature Requests — from astix code-health migration (2026-03-23)

> 67 `orm.raw()` calls remain. 11 in code-health.ts blocked by missing dbsp features.
> Inventory: `astix/docs/orm-raw-inventory.md`

| Feature | Priority | Unblocks | Description |
|---------|----------|----------|-------------|
| **AGG-JOINED-COL** | P1 | 4 checks (highCoupling, godFunctions, largeFiles, unresolvedCalls) | `count(ref('joinedRelation.id'))` / `min(ref('joinedRelation.path'))` — aggregate functions on columns from JOINed tables, usable in SELECT + HAVING |
| **NOTEXISTS-MULTI-JOIN** | P1 | 3 checks (deadCode, unusedExports, orphanFiles) | `notExists('relation', { where: ... })` with JOINs inside the subquery + outer-column references. Currently notExists only follows 1 FK with 1 WhereIntent. |
| **CASE-INTENT** | P2 | 1 check (unusedDeps) | `caseWhen(condition, thenExpr).else(elseExpr)` — conditional expressions in SELECT columns |
| ~~**LIKE-ESCAPE**~~ | ~~P2~~ | ~~1 check (unusedVariables)~~ | ~~`like('col', pattern, { escape: '\\' })` — escape character for LIKE WHERE clauses~~ ✅ Done 2026-03-23 |
| ~~**NULLS-LAST-EXPR**~~ | ~~P2~~ | ~~1 check (complexFunctions)~~ | ~~`orderBy(op(...), 'asc', { nulls: 'last' })` — NULLS LAST on computed expression in ORDER BY~~ ✅ Done 2026-03-24 (Issue 10: `orderBy` ExpressionRef/ExpressionSpec branches now propagate `options.nulls`) |
| ~~**REF-VS-REF**~~ | ~~P1~~ | ~~1 check (circularImports)~~ | ~~`op('!=', ref('col_a'), ref('col_b'))` — same-table column-to-column comparison in `.where()` compiles to `__expr != __expr` instead of `"col_a" != "col_b"`~~ ✅ Done 2026-03-23 |
| **WINDOW-FN** | P2 | 1 check (unresolvedTypeBindings) + others | `wCount()` / `COUNT(*) OVER()` in SELECT columns — window functions not supported in `.columns()` builder |

---

## P0 — Core Features Required by astix ORM Migration (2026-03-15)

> Re-assessment 2026-03-20: 108 `orm.raw()` calls. Inventory: `astix/docs/orm-raw-inventory.md`
> After rigorous audit: dbsp already covers ~94/108 calls via existing features.
> Remaining raw: DDL (10) + system catalogs (4) = always raw by design.
> Migration work is ASTIX-SIDE (use include/returning/notExists/distinct), not new dbsp features.

### Assessment summary (2026-03-20)
> - §1 JOINs (~50): ✅ Covered by `include('relation', { select, where })` — all FK relations declared
> - §2 WITH RECURSIVE (9): ✅ Covered by recursive includes (DX-017)
> - §3 CTE mutations (8): ✅ Covered by `.delete().returning()` — count client-side, no CTE needed
> - §4 UPDATE...FROM unnest (5): ✅ Covered by `batchSet()` (BATCH-001)
> - §5 DDL (10): 🚫 Always raw by design
> - §6 pgvector (2): ✅ EXT-001 (cosineDistance etc.) + include for JOINs
> - §7 ParadeDB (4): ✅ EXT-002 (bm25Search etc.) + include for JOINs
> - §8 sql() in set (4): ✅ UPSERT-RAW (sql('now()') in .set())
> - §9 NOT EXISTS (4): ✅ `notExists('relation')` works on delete builder — FK declared
> - §10 System catalogs (4): 🚫 Always raw by design
> Only DISTINCT ON (PostgreSQL-specific) is a minor gap — .distinct() covers most cases.

(DISTINCT-ON, F-001→003 archived → docs/historic/done-2026-03.md)

(DX-050 archived → docs/historic/done-2026-03.md)
(CTE-001 archived → docs/historic/done-2026-03.md)
(BATCH-001 archived → docs/historic/done-2026-03.md)
(AGG-001 archived → docs/historic/done-2026-03.md)
(DDL-FK-IDX archived → docs/historic/done-2026-03.md)
(DDL-COMPLETE archived → docs/historic/done-2026-03.md)
(SCHEMA-DSL-EXT archived → docs/historic/done-2026-03.md)
- [ ] 💡 **DDL-VIEWS** [Adapter] VIEW support — CREATE/DROP VIEW, materialized views, introspection, diff. — Priority: P1 (deferred from DDL-COMPLETE)
- [ ] 💡 **DDL-TRIGGERS** [Adapter] TRIGGER support — CREATE/DROP TRIGGER, trigger functions, introspection, diff. — Priority: P2 (deferred from DDL-COMPLETE)
- [ ] 💡 **DDL-PARTITION-MGMT** [Adapter] Partition child table management — CREATE TABLE ... PARTITION OF ... FOR VALUES, partition addition/removal/split. Parent PARTITION BY handled in DDL-COMPLETE. — Priority: P2 (deferred from /adversarial DDL-COMPLETE)
- [ ] 💡 **DDL-EXT-SCHEMA** [Adapter] Extension schema qualification — CREATE EXTENSION ... SCHEMA pg_catalog. — Priority: L (deferred from /adversarial DDL-COMPLETE)
(DDL-VALIDATE, DDL-RLS archived → docs/historic/done-2026-03.md)
- [ ] 💡 **DDL-DOMAINS** [Adapter] Custom domain types — CREATE DOMAIN with constraints. — Priority: L (from /llm Copilot DDL-COMPLETE)
(DDL-OPCLASS-INTRO, DDL-ENUM-DEPCHECK, DDL-SEQ-DRY archived → docs/historic/done-2026-03.md)
(CAPS-VERSION, UPSERT-RAW, EDGE-001, EDGE-002 archived → docs/historic/done-2026-03.md)
- [ ] 💡 **NQL-WITH** [NQL] WITH ... AS (...) non-recursive CTE syntax in NQL parser — deferred from BATCH-001. — Priority: P1 (from /adversarial 2026-03-18)
(BATCH-DRY-001/002, BATCH-FIX-001/002, JOIN-TYPE, EDGE-FLOAT, EXT-001, EXT-002, EXT-NAMED-PARAMS archived → docs/historic/done-2026-03.md)

---

## P1 — Multi-Adapter Capability Negotiation (2026-03-19)

> ModelIR = universal representation. Each adapter interprets features per its capabilities.
> Unsupported features: configurable behavior (warn+skip OR error/throw).
> Tier 1 (OSS baseline): PostgreSQL, MySQL, SQLite, DuckDB. Tier 2 (best-effort): Oracle, MSSQL, CouchDB.

(CAPS-001→005 archived → docs/historic/done-2026-03.md)
(EDGE-001, EDGE-002, EDGE-002/F-001, EDGE-002/F-002, EDGE-002/LINT archived → docs/historic/done-2026-03.md)
(DX-WARMUP obsolete, EDGE-FLOAT, EXT-001, EXT-TEMPLATE, EXT-NAMED-PARAMS, CAPS-DRY-001, CAPS-DOC-001 archived → docs/historic/done-2026-03.md)
- [ ] 💡 **EXT-PARAM-DEDUP** [Core] Param deduplication — same expression in SELECT+WHERE+ORDER BY produces 3 params instead of 1. — Priority: L (from /adversarial EXT-001)

---

## P0 — Architecture Assessment Findings (2026-03-14)

> From astix-powered architecture audit. God functions + monolithic classes = growth bottleneck.

### CRITICAL — Decompose god functions

- [x] ✅ **ARCH-001** [Adapter] Decompose `convertSelect` — 13 expression handlers extracted into dispatch map, 245→78 LOC. (2026-03-19)
- [x] ✅ **ARCH-002** [Adapter] Decompose `PgsqlAdapter` compilation domain — 15 methods (568 LOC) extracted into 4 modules (adapter-compiler-select, -includes, -mutations, -recursive) + deps type. pgsql-adapter.ts: 1985→745 LOC. 2416 tests pass. (2026-03-19)
- [x] ✅ **ARCH-003** [Adapter] Decompose `compileSelect` — 7 helpers extracted (createHandlerContext, createHandlerState, compileSelectTarget, compileIncludeDecision, compileWhereDecision, flushPendingJoins, buildSelectStmt), 439→122 LOC. (2026-03-19)

### HIGH — GUI + handler duplication

- [ ] 🔧 **ARCH-004** [GUI] Refactor `App.tsx` (1056 LOC, complexity **171**) — extract into sub-components (Editor, ResultsPanel, SettingsPanel) + custom hooks (useQueryExecution, useResultsViewer). — Priority: H
(ARCH-005, ARCH-006 archived → docs/historic/done-2026-03.md)

### MEDIUM — Code health findings (2026-03-14)

- [ ] 🐛 **ARCH-CH1** [GUI] `packages/gui/src/lib/log-utils.ts` is orphan — no incoming imports or calls. Verify if dead code and remove. — Priority: M
- [ ] 💡 **ARCH-CH2** [Adapter] 450 dead_code findings — mostly expression handlers (`countHandler`, `sumHandler`...) flagged because they're consumed via dynamic dispatch (`handlers[type]`). Investigate: are they truly dead, or is this an astix false positive from unresolved computed property access? — Priority: M
- [ ] 💡 **ARCH-CH3** [Core] 4 circular import cycles detected:
  - `handlers/index.ts` ↔ `handlers/where/index.ts` (barrel re-exports)
  - `column-validator.ts` ↔ `types.ts` (mutual type deps)
  - 5-file DX cluster: `filters → orm-instance-types → query-builder-types → types → window-functions`
  - 5-file Intent AST cluster: `expression → include → query → select → where` (by design — recursive AST)
  Priority: L (first two fixable, last two by-design)

### MEDIUM — Design debt

- [ ] 💡 **ARCH-007** [Core] Document result hydration design — brittle column aliasing (dot separator convention), row explosion risks, recursive include depth. Needs design doc before adding features. — Priority: M
- [ ] 💡 **ARCH-008** [Core] Add hook composition utilities (compose, pipe) + priority ordering (CRITICAL/HIGH/NORMAL/LOW). Current: implicit FIFO/LIFO only. — Priority: M
- [ ] 💡 **ARCH-009** [Core] Schema versioning + diffing — detect changes between schema versions for migration generation. Currently manual. — Priority: M
- [ ] 💡 **ARCH-010** [GUI] IPC error handling — JSON over stdio can fail silently. Add retry logic, timeout management, message queue for out-of-order responses. — Priority: M
- [ ] 💡 **ARCH-011** [Docs] Create PATTERNS.md — document Handler/Factory/Plugin/Strategy/Builder usage conventions. Inconsistent terminology confuses contributors. — Priority: M

---

## P1 — Critical (Functional Bugs)

> These are confirmed bugs that affect correctness. Fix before new features.

### Core Correctness

(Archived → docs/historic/done-2026-02.md)

### E2E Regressions (discovered via globalSetup fix)

(Archived → docs/historic/done-2026-02.md)

### Introspection

(Archived → docs/historic/done-2026-02.md)

---

## P2 — High (Product & DX)

> MCP operability, key DX features, documentation.

### MCP Server (Category C) — Deprioritized to P4 (2026-02-12)

(E06, E06b moved to P4 — CLI binary accessible to AI agents, MCP redundant for shell contexts)
(E06c, E08 archived → docs/historic/done-2026-02.md)

### Documentation

- [ ] **DOCS-002** [Docs] Migration guides (from-prisma, from-drizzle, from-kysely)
- [ ] **DOCS-003** [Docs] Pattern guides (multi-tenant, recursive queries, window functions)

(E11, E11b archived → docs/historic/done-2026-02.md)

### DX Convenience (Category A)

(E17c moved to P4 — GUI explorer prioritized over CLI wizard)
(E17, E17b archived → docs/historic/done-2026-02.md)

### Infrastructure

(E09, E09b, E10 archived → docs/historic/done-2026-02.md)

---

## P2 — GUI Desktop Explorer (New Product)

> Tauri v2 desktop app — visual schema exploration, SQL/NQL editing, plan inspection.
> Brief: docs/briefs/gui-explorer.md | Overview: docs/plans/gui-overview.md

### MVP

(GUI-001 to GUI-009, GUI-MW archived → docs/historic/done-2026-02.md)

(GUI-F002, GUI-F003 archived → docs/historic/done-2026-02.md)

(GUI-BRIDGE archived → docs/historic/done-2026-02.md)

### Later

(GUI-010 archived → docs/historic/done-2026-02.md)
(GUI-011, GUI-012 archived → docs/historic/done-2026-02.md)
(GUI-013, GUI-014 archived → docs/historic/done-2026-02.md)
- [ ] 💡 **GUI-015** [GUI] Web version (@dbsp/web — same React frontend, HTTP/WS transport, phpMyAdmin-like)
(GUI-016, GUI-016b, GUI-016a+c archived → docs/historic/done-2026-02.md)
(GUI-MW-D01, GUI-MW-D02, GUI-MW-D04, GUI-MW-D05, GUI-MW-D06 archived → docs/historic/done-2026-02.md)
- [ ] 💡 **GUI-MW-D03** [GUI] Per-connection SSL/params overrides in dbsp.settings.json — Priority: L
- [ ] 🔧 **GUI-F004** [GUI] TauriTransport edge case tests — race condition (close during pending listen), listen() rejection, reconnect timer cleanup, double reconnect — Priority: L
- [ ] 💡 **GUI-017** [GUI] Assertion file editing with syntax highlighting (write/edit .assert.dbsp, not just run) — Priority: L
- [ ] 💡 **GUI-018** [GUI] Auto-discovery of .assert.dbsp files from project tree (scan + run all) — Priority: L
- [ ] 💡 **GUI-019** [GUI] Live assertion re-run on file change (watch mode) — Priority: L
- [ ] 💡 **GUI-020** [GUI] Assertion coverage reporting (queries with/without assertions) — Priority: L
(Log rotation configurable, toast notifications, LogPanel virtualized list archived → docs/historic/done-2026-02.md)
(GUI-022, GUI-023 archived → docs/historic/done-2026-02.md)
- [ ] 💡 **GUI-022-F002** [GUI] `generateSchema` wizard option not wired (reverse-engineer endpoint needed) — Priority: L (from /review F-002)
- [ ] 💡 **GUI-022-F003** [GUI] NQL file menu item needs Rust-side Tauri menu + `fs.write` — Priority: L (from /review F-003)
(GUI-022-F004, F007, F009, F011, F014 archived → docs/historic/done-2026-02.md)
(GUI-025 archived → docs/historic/done-2026-02.md)
(GUI-025-OOS1, GUI-025-OOS2, GUI-025-F002 archived → docs/historic/done-2026-02.md)
(GUI-025-OOS3, OOS4, OOS5 promoted back to in-scope per user decision 2026-02-25)
- [ ] 🔧 **GUI-025-F008** [GUI] Replace unsafe double-cast in TauriFileWatcher with runtime schema validation (zod/manual) — Priority: M (from /review F-008)
- [ ] 🔧 **GUI-025-F016** [GUI] buildPairedTree single-root mode should strip root prefix (currently ignores roots[0]) — Priority: M (from /review F-016)
- [ ] 🔧 **GUI-027-F003** [GUI] ProfileManager.handleSetDefault should readSettings() first to avoid stale write — Priority: M (from /review F-003)
- [ ] 🔧 **GUI-027-F008** [GUI] `/mnt/**` scope in Tauri capabilities is dev-only — document or gate behind dev profile — Priority: M (from /review F-008)
- [ ] 🔧 **GUI-025-F018** [GUI] Auto-reload file watcher should skip dirty tabs (check tab.dirty before overwrite) — Priority: M (from /review F-018)
- [ ] 🔧 **GUI-024-F009** [GUI] Extract AppLogPopover to own file + test AC-1/AC-2 (expand icon, popover→modal wiring) — Priority: M (from /review F-009)
- [ ] 🔧 **GUI-021** [GUI] Authorization check on schema.apply sidecar endpoint (desktop-only, lower risk) — Priority: M (from /review F-007)
- [ ] 🔧 **CLI-001** [CLI] Integration test for rollback flow with real DB (SC-16) — Priority: M (from /review F-002)
(GUI-027 archived → docs/historic/done-2026-02.md)
(GUI-027-UX archived → docs/historic/done-2026-03.md)
  - [-] ⏭️ GUI-027-v2: Multi-connection per tab routing — deferred to v2
- [ ] 💡 **GUI-028** [GUI] Keychain integration (store:// URI) — activate Tauri plugin-store for secure password storage, opt-in vs default — Priority: L (needs /ideate on GUI-027 first)
(GUI-F005, GUI-F006, GUI-F007 archived → docs/historic/done-2026-02.md)

---

## P3 — Medium (SQL Features)

> Language features with clear use cases but lower urgency.

### NQL Language (Category B)

(E13, E13b, E13c, E13d, E13e, E13f archived → docs/historic/done-2026-02.md)

### Full-Text Search

- [ ] **E14** [Core] FTSIntent type + planner support — Effort: L
- [ ] **E14b** [Adapter] FTS Compiler (PostgreSQL) + ranking — Effort: L

### Locking & Transactions

(E15, E15b archived → docs/historic/done-2026-02.md)

### CLI Data Plane

(Archived → docs/historic/done-2026-02.md)

---

## P2.5 — Type Rationalization (Refactoring)

> Structural type health: 233→0 production casts remaining, contracts centralized, god files split.

(All R01 tasks archived → docs/historic/done-2026-02.md)

(R02 archived → docs/historic/done-2026-02.md)

---

## P4 — Low (Code Health)

> Tech debt to tackle when pain becomes real. No urgency.

### DRY Refactors (Category D)

(All archived → docs/historic/done-2026-02.md)

### SRP / God Classes

(#16, #17, #19, #34 archived → docs/historic/done-2026-02.md)
- [-] ⏭️ **#18** [SRP] PgsqlAdapter — DEFERRED: well-structured, low entropy, highest blast radius

### SOLID Violations

- [-] ⏭️ **#30** [ISP] QueryBuilder<T> 33 methods — WON'T FIX: all consumers use full interface, no subset usage found (2026-02-06)

(A-22/#20, #31 archived → docs/historic/done-2026-02.md)

### Test Coverage

(#33, A-34 archived → docs/historic/done-2026-02.md)

### API Surface

(Archived → docs/historic/done-2026-02.md)

### E13-ALL Review Findings (2026-02-07)

(Archived → docs/historic/done-2026-02.md)

### DX Convenience (moved from P2, 2026-02-12)

- [-] ⏭️ **E17c** [DX] `dbsp init` wizard — deferred: GUI explorer prioritized over CLI wizard

### MCP Server (moved from P2, 2026-02-12)

- [-] ⏭️ **E06** [MCP] Implement v1 tools — deferred: CLI binary accessible, MCP redundant for shell contexts
- [-] ⏭️ **E06b** [MCP] Implement v1 resources — deferred: same rationale

### Dead Code

(All items verified as false positives 2026-02-06: A-26 NqlLimitError doesn't exist / NqlWarning is active; #21 is in use; #29 no factory found; CLI plan summary embedded)

---

## Blocked / Deferred

> Explicitly parked. Requires external dependency or not planned.

### Performance-Gated

- [-] ⏭️ [Adapter] AST object pooling — perf-gated, measure first
- [-] ⏭️ [Adapter] Async deparse optimization — perf-gated

### Dependency-Blocked

(Migration generation + Cycle detection + compileWithIncludes archived → docs/historic/done-2026-02.md)
- [-] ⏭️ [Architecture] DX-032: Conformance Test Framework — depends on multi-adapter

### Multi-Adapter (Future)

- [-] ⏭️ [Core] Future Native Adapters (adapter-mysql, adapter-sqlite)
- [-] ⏭️ [Adapter] Multi-dialect FTS (MySQL, SQLite) — depends on multi-adapter

### Explicitly Not Planned

- [-] ⏭️ [Core] Cascade delete (multi-statement) — single delete only
- [-] ⏭️ [DDL] Triggers and stored procedures — outside semantic planner scope

### Schema Diff (from khi dashboard integration)

(DDL compareSchemata fixes archived → docs/historic/done-2026-03.md)
- [ ] 🔧 [DDL] compareSchemata index awareness — schema `unique: true` and `ref()` generate implicit indexes, but ModelIR doesn't include them → 24 false `drop_index` on diff — Priority: M
- [ ] 💡 [DDL] Expose migration CLI utilities as public API — `scanMigrations()`, file I/O from @dbsp/cli currently not exportable — Priority: L

### DDL Extensions (Low Priority)

- [-] ⏭️ [DDL-001] Check constraints (`CHECK (price > 0)`) — requires expression parser
- [-] ⏭️ [DDL-002] Partial indexes / expression indexes — advanced PostgreSQL
- [-] ⏭️ [DDL-004] Sequence/auto-increment customization — DB defaults sufficient
- [-] ⏭️ [DDL-005] Column comments (`COMMENT ON COLUMN`) — documentation feature
- [-] ⏭️ [DDL-006] `onUpdate` action for FKs — uncommon in practice
- [-] ⏭️ [DDL-007] Composite indexes — needs table-level syntax design
- [ ] 💡 [DDL] Migration squash/rebase — consolidate migration files — Priority: L (from /clarify SCHEMA-EVO)
- [ ] 💡 [GUI] ER diagram visualization in schema diff — Priority: L (from /clarify SCHEMA-EVO)
- [ ] 💡 [GUI] Interactive migration editing in GUI — Priority: L (from /clarify SCHEMA-EVO)

---

## Completed

- [x] ✅ [Docs] expression primitives guide (docs/guides/how-to-use-expression-primitives.md) (2026-03-20)
- [x] ✅ [Docs] extensions guide — pgvector + ParadeDB (docs/guides/how-to-use-extensions.md) (2026-03-20)
- [x] ✅ [Docs] CLAUDE.md Query Features section added (2026-03-20)

(GUI-016, GUI-016b, SCHEMA-EVO archived → docs/historic/done-2026-02.md)
(Archived → docs/historic/done-2026-02.md)
