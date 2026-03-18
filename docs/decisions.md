# Architecture Decisions

Decisions archived from workflow — newest first.

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
