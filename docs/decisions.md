# Architecture Decisions

Decisions archived from workflow — newest first.

---

## Session marathon 2026-03-20 — Expression primitives, extensions, DDL, refactors

### EXT-001 — Expression primitives + pgvector
- Option C hybrid: generic primitives (op/fn/ref/param/cast/literal/unary) in core + typed wrappers in adapter
- Primitives are PUBLIC API in @dbsp/core — not internal-only
- Extensions as modules in adapter-pgsql/src/extensions/ (not separate packages)
- Implicit conversion in op/fn: string=ref, number/array/boolean=param
- Input validation regex on operator/function/type names (security)
- Compiler always parenthesizes custom ops (from /llm consensus)
- param()=$N binding vs literal()=inline SQL value (from /llm)
- Custom fn() does NOT trigger GROUP BY (from /llm Gemini)
- compileExpressionIntent: recursive dispatcher shared by SELECT/WHERE/ORDER BY
- exprRef barrel alias to avoid collision with schema DSL ref()

### EXT-002 — ParadeDB extension
- Uses positional args via fn() — ParadeDB accepts both named and positional
- bm25Search() shares param intent reference across all field parse() calls

### EXT-NAMED-PARAMS — Named argument expressions
- NamedArgExpr AST node for PostgreSQL `name => value` syntax
- namedArg() validates name against FUNCTION_NAME_PATTERN (security)
- ParadeDB parse() updated to use proper named-arg syntax

### JOIN-TYPE — include() with join type
- `join?: 'inner' | 'left'` on IncludeOptions (not `mode` — too generic)
- `join: 'inner'` forces planner to use join strategy + INNER JOIN
- Default 'left' preserves existing behavior (backward compatible)
- Filters root rows when combined with where (unlike default include behavior)

### DDL-RLS — Row-Level Security policies (2026-03-20)

- PolicyIR in types (generic model) — not adapter-specific
- SQL predicates as strings (same escape hatch as IndexIR.where)
- rlsEnabled + policies on TableIR (same pattern as indexes, checks, foreignKeys)
- Capability flag supportsDDLRowLevelSecurity for multi-dialect
- NOT abstracting Oracle VPD or MSSQL predicates — fundamentally different mechanisms
- Policies replaced (DROP + CREATE), not altered — simplifies diff logic
- Phase ordering: RLS enable (phase 17) before policies (phase 18)

---

## EDGE-001-002 — Remove WASM from prod + internalize pgsql-deparser (2026-03-20)

- Replace parseSync (WASM) with a pure-TS recursive descent expression parser for sql() escape hatch
- Move libpg-query + pgsql-parser to devDependencies (tests only, used as comparison baseline)
- Remove WASM copy from tsup onSuccess hook
- Internalize pgsql-deparser — write a focused TS deparser for the ~33 AST node types dbsp produces
- Move pgsql-deparser to devDependencies (used as comparison baseline for deparser tests)

---

## CAPS — Multi-adapter capability negotiation (2026-03-19)

- DDL flags go on DialectCapabilities (not AdapterCapabilities) — dialect-level, not adapter-level
- 15 individual flags (split from 10 per /llm consensus: advancedIndexes and deferredConstraints too coarse)
- Flag semantics: `supportsDDL*` = "adapter can handle this IR feature" (not "same SQL as PG"). Partial support valid.
- Default UnsupportedFeatureBehavior = 'warning' (emit + skip). User can set 'error' for strict mode
- Per-feature override via FeatureBehaviorConfig { default, overrides?: Record<DDLFeature, behavior> }
- `createDialectCapabilities(overrides)` factory helper for adapter authors (fills safe defaults)
- FeatureTranslator<F> with type-safe DDLFeatureElementMap — design only, no concrete implementation
- CAPS-005 = design only. Translation implementation deferred to adapter-mysql/sqlite stories
- CAPS-VERSION (version-aware capabilities) deferred — not needed until 2nd adapter
- Tier 1 (full): PG, MySQL, SQLite, DuckDB. Tier 2 (best-effort): Oracle, MSSQL, CouchDB
- ForeignKeyIR uses `references.table` (not `targetTable`), `deferred` (not `deferrable`)

---

## DDL-COMPLETE — Complete DDL migration system (2026-03-18)

- Single monolithic story (not split into multiple)
- VIEWs and TRIGGERs deferred to future story
- FK auto-index added to migrate path for consistency with generateDDL (single-column only)
- 16-phase topological ordering (up from 12) for extensions, enums, sequences, check constraints, comments
- All new IR fields optional on existing interfaces (backward compat)
- CHECK expression: use pg_get_constraintdef(oid, false) for server-side canonical form
- Index introspection: use pg_index + pg_am + pg_opclass + pg_get_expr, NOT pg_indexes.indexdef regex
- Index opclass: per-column via pg_opclass join, non-default only (opcdefault=false)
- Index WITH params: from pg_class.reloptions
- Idempotent DDL: CREATE INDEX IF NOT EXISTS + DO $$ EXCEPTION WHEN duplicate_object for constraints
- ENUM ALTER TYPE ADD VALUE has transaction visibility caveats — emit outside transaction or document limitation
- ENUM value insertion position matters — track BEFORE/AFTER for ordered enums
- Identity vs SERIAL coexist — never auto-convert, explicit opt-in only
- Partition strategy change = error, child management deferred to DDL-PARTITION-MGMT
- ENUM value removal = destructive flag (PG limitation)
- Introspection parallelized: 10 queries via Promise.all

---

## DDL-FK-IDX — emit FK + indexes for new tables in migration SQL (2026-03-18)

- Fix in compareSchemata: emit add_foreign_key + create_index changes for new tables before the continue statement
- No changes to generateCreateTableSQL — composite UNIQUE handled via CREATE UNIQUE INDEX path
- Topological order preserved naturally via existing getPhase() dispatcher (create_table=5, add_fk=9, create_index=11)

---

## BATCH-001 — Batch unnest API for INSERT/UPDATE with array parameters (2026-03-18)

- Compilation-level strategy switch (VALUES vs unnest) — not API-level. Threshold: 50 rows default, configurable, 0 = force unnest
- Batch UPDATE via new .batchSet() method (fundamentally different SQL pattern from single SET)
- ANY() as new filter helper + NQL keyword (not reusing in())
- CTE builder: withCte().fromUnnest().withIndex() — new builder, not extending recursive builder
- Schema-driven type inference via ModelIR column types — runtime fallback only when no schema
- WITH ORDINALITY instead of generate_series for CTE index
- Sparse batches: group by shape, emit one INSERT per group. Missing required column = build error
- Array cardinality validation before SQL generation — never rely on PG silent NULL-padding
- Composite PK support in batchSet via string | string[]
- maxBatchSize: optional guard in CompileOptions, throw if exceeded
- Dual-path CTE: design study only, implementation deferred
- NQL WITH syntax deferred to NQL-WITH story
- pgsql-deparser normalizes type casts to CAST($N AS type[]) form (not $N::type[])
- CTE query uses regex param renumbering to shift outer query params after CTE params

---

## AGG-001 — FILTER clause support in aggregates (2026-03-18)

- Reuse existing `funcCall()` helper's `filter?: Node` param (sets `agg_filter` on FuncCall AST) — no new AST work
- Added `filter?: WhereIntent` to `AggregateExpressionIntent` — compiled via same pipeline as WHERE clauses
- NQL grammar extension for FILTER out of scope — API/intent only for now
- DX builder `.filter()` returns immutable copy via spread pattern (consistent with existing builders)

---

## DX-050 — dbType escape hatch for schema DSL (2026-03-18)

- Reuse existing `ColumnIR.originalDbType` field (populated by introspection) — no new IR field needed
- Case-insensitive comparison in schema-diff via `.toLowerCase()`
- Fallback to base type comparison when `originalDbType` absent on either side
- Used `areTypesEquivalent()` for base type fallback (existing function handles type aliases)
- No `dbType` validation — developer-only input, same trust level as table/column names
