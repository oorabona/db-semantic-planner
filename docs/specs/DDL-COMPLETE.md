---
doc-meta:
  status: draft
  adversarial_applied: true
  scope: adapter-pgsql
  type: specification
  target_project: /mnt/wsl/shared/dev/db-semantic-planner
  created: 2026-03-18
  updated: 2026-03-18
  complexity: ENTERPRISE
  time-budget: 7h
---

# Specification: DDL-COMPLETE — Complete DDL Migration System

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | types (ModelIR), adapter-pgsql (DDL subsystem) |
| Complexity | ENTERPRISE |
| Time budget | ~7h |
| Blocks | 8 |
| BDD scenarios | 42 |
| Risk level | MEDIUM (extensive IR changes, backward compat required) |

## 1. Problem Statement

`dbsp migrate` only handles tables, columns, PKs, FKs, and basic indexes. Common PostgreSQL schema elements — CHECK constraints, ENUM types, index methods/expressions/partials, FK onUpdate, column collation/comments/identity, sequences, extensions, partitions, and multi-schema — are invisible to introspection and silently ignored by the diff engine. This forces users to fall back to raw SQL for anything beyond basic table structures, defeating the purpose of a managed migration system.

## 2. User Stories

**US-1:** As a dbsp user, I want CHECK constraints and ENUM types in my schema definition to be detected, compared, and migrated automatically, so that I don't need raw SQL for common domain constraints.

**US-2:** As a dbsp user, I want indexes with methods (GIN, GiST), partial WHERE clauses, and expression columns to be fully supported in migrations, so that I can optimize my queries through the schema DSL.

**US-3:** As a dbsp user, I want `dbsp migrate` to handle sequences, extensions, partitions, and multi-schema scenarios, so that I can manage my full PostgreSQL infrastructure declaratively.

## 3. Business Rules

### 3.1 Invariants

- INV-01: All new IR types must be optional on existing interfaces (backward compat — schemas without CHECK/ENUM/etc continue to work identically)
- INV-02: Introspection must roundtrip — define → introspect → compare = zero diff
- INV-03: Phase ordering must prevent FK/type dependency violations (extensions before enums before tables before FKs before indexes)
- INV-04: All generated SQL must use identifier quoting and parameterized schema names
- INV-05: ENUM value removal is not supported by PostgreSQL — must produce a clear error, not silent failure
- INV-06: FK auto-index behavior must be identical between `generateDDL` and `generateMigrationSQL` — single-column FKs only (composite FKs require explicit indexes)
- INV-07: CHECK expression comparison must use `pg_get_constraintdef(oid, false)` for server-side canonical form. JS-side normalization (strip parens, collapse whitespace) is insufficient — PG adds casts, schema qualification, etc. Compare introspected canonical form vs schema-defined expression normalized the same way.
- INV-11: Index introspection must use system catalogs (`pg_index`, `pg_am`, `pg_attribute`, `pg_opclass`) + `pg_get_expr(indpred, indrelid, false)` for predicates — NOT `pg_indexes.indexdef` regex parsing (brittle across PG versions). (/llm consensus: Codex + Copilot HIGH agreement)
- INV-12: `ALTER TYPE ... ADD VALUE` cannot be used inside a transaction in some contexts. Migration runner must emit enum value additions outside transaction blocks, or document the limitation. (/llm consensus: Codex)
- INV-13: ENUM value insertion position matters — PG enums are ordered. New values must specify `BEFORE`/`AFTER` when not appending at end. (/llm consensus: Copilot)
- INV-14: Identity vs SERIAL coexist — never auto-convert SERIAL to IDENTITY. New schemas default to IDENTITY. Introspection supports both. Conversion = explicit opt-in only. (/llm consensus: Codex + Copilot HIGH agreement)
- INV-15: Generated DDL must be idempotent — `CREATE INDEX IF NOT EXISTS` for indexes, `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$` for ADD CONSTRAINT (CHECK + FK). Prevents errors on re-run or partial migration recovery.
- INV-16: Index operator class introspection uses `pg_index.indclass` joined with `pg_opclass` — only store non-default opclasses (`opcdefault = false`). Default opclass omitted from IR.
- INV-17: Index WITH parameters introspected from `pg_class.reloptions` (array of `key=value` strings). Must roundtrip: define → introspect → compare = zero diff.
- INV-08: Before emitting `drop_enum`, verify no column references the enum type. If still referenced, emit column type changes first or error.
- INV-09: Introspection queries should be parallelized via `Promise.all` where independent (perf: 10+ queries up from 4)
- INV-10: Schema-level comparison (enums, sequences, extensions) extracted into `compareSchemaObjects()` — called before `compareSchemata` table loop

### 3.2 Preconditions

- PRE-01: PostgreSQL 12+ (partitioning syntax, identity columns)
- PRE-02: Introspection queries must use `$1` for schema name (existing pattern)

### 3.3 Effects

- EFF-01: ModelIR gains: `enums`, `sequences`, `extensions` at schema level; `checkConstraints`, `partition` on TableIR; extended IndexIR, ForeignKeyIR, ColumnIR
- EFF-02: Introspection queries expanded from 4 to ~10 system catalog queries
- EFF-03: ChangeKind union expanded from 14 to ~28 values
- EFF-04: Phase ordering expanded from 12 to 17 phases
- EFF-05: `generateDDL` and `generateMigrationSQL` emit consistent SQL for all new elements

### 3.4 Error Handling

- ERR-01: ENUM value removal → `InvalidOperationError('PostgreSQL does not support removing enum values. Workaround: create new type, migrate data, drop old type.')`
- ERR-02: ENUM value reorder → warning in diff summary (PG enum order is insertion order, cannot reorder)
- ERR-03: Partition strategy change on existing table → `InvalidOperationError('Cannot change partition strategy. Drop and recreate table.')`
- ERR-04: Extension not available on server → SQL fails at execution time (`CREATE EXTENSION IF NOT EXISTS` — PG error is clear enough)
- ERR-05: Drop enum while columns still reference it → error listing dependent columns

## 4. Technical Design

### 4.1 New Phase Ordering (17 phases)

```
Phase  0: create_extension          (before any type references)
Phase  1: create_enum, create_sequence  (before column type/default references)
Phase  2: drop_check_constraint, drop_foreign_key  (before dropping columns/tables)
Phase  3: drop_index
Phase  4: drop_column
Phase  5: drop_primary_key
Phase  6: drop_table
Phase  7: drop_enum, drop_sequence, drop_extension  (after all references removed)
Phase  8: create_table              (with PARTITION BY if applicable)
Phase  9: add_column
Phase 10: alter_column_*            (type, nullable, default, collation, identity)
Phase 11: add_primary_key
Phase 12: add_check_constraint
Phase 13: add_foreign_key
Phase 14: alter_foreign_key, alter_enum_add_value
Phase 15: create_index              (includes FK auto-index)
Phase 16: add_comment, drop_comment
```

### 4.2 New ModelIR Types

```typescript
// Schema-level (on ModelIR)
interface EnumIR {
  readonly name: string;
  readonly values: readonly string[];
  readonly schema?: string;
}

interface SequenceIR {
  readonly name: string;
  readonly dataType?: 'smallint' | 'integer' | 'bigint';
  readonly startWith?: number;
  readonly incrementBy?: number;
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly cycle?: boolean;
  readonly ownedBy?: { table: string; column: string };
}

// Table-level (on TableIR)
interface CheckConstraintIR {
  readonly name: string;
  readonly expression: string;          // Raw SQL expression: "age >= 18"
  readonly columns?: readonly string[]; // Columns referenced (for diffing)
}

interface PartitionIR {
  readonly strategy: 'range' | 'list' | 'hash';
  readonly columns: readonly string[];
  readonly expression?: string;  // For expression-based partitioning
}

// Extended IndexIR
interface IndexIR {
  readonly name?: string;
  readonly columns: readonly string[];
  readonly unique?: boolean;
  readonly method?: 'btree' | 'gin' | 'gist' | 'brin' | 'hash' | 'spgist';  // NEW
  readonly where?: string;              // NEW: partial index predicate
  readonly expressions?: readonly string[];  // NEW: expression columns (alt to columns)
  readonly include?: readonly string[]; // NEW: covering index INCLUDE columns
  readonly opclass?: Record<string, string>;  // NEW: per-column operator class (e.g., {"name": "gin_trgm_ops"})
  readonly with?: Record<string, string>;     // NEW: storage parameters (e.g., {"m": "16", "ef_construction": "64"})
}

// Extended ForeignKeyIR
interface ForeignKeyIR {
  readonly columns: readonly string[];
  readonly references: { readonly table: string; readonly columns: readonly string[] };
  readonly onDelete?: OnDeleteAction;
  readonly onUpdate?: OnDeleteAction;   // NEW: reuse same action type
  readonly deferred?: boolean;          // NEW: DEFERRABLE INITIALLY DEFERRED
}

// Extended ColumnIR
interface ColumnIR {
  // ... existing fields ...
  readonly collation?: string;          // NEW: e.g., "en_US.utf8"
  readonly comment?: string;            // NEW: COMMENT ON COLUMN
  readonly identity?: 'always' | 'byDefault'; // NEW: GENERATED {ALWAYS|BY DEFAULT} AS IDENTITY
}

// Extended TableIR
interface TableIR {
  // ... existing fields ...
  readonly checkConstraints?: readonly CheckConstraintIR[];  // NEW
  readonly partition?: PartitionIR;     // NEW
  readonly comment?: string;            // NEW: COMMENT ON TABLE
}

// Extended ModelIR
interface ModelIR {
  // ... existing fields ...
  readonly enums?: ReadonlyMap<string, EnumIR>;       // NEW
  readonly sequences?: ReadonlyMap<string, SequenceIR>; // NEW
  readonly extensions?: readonly string[];              // NEW
}
```

### 4.3 New Introspection Queries

| Query | System Table | Returns |
|-------|-------------|---------|
| CHECK constraints | `information_schema.check_constraints` + `pg_constraint` | name, expression, table |
| ENUM types | `pg_type` + `pg_enum` + `pg_namespace` | name, ordered values |
| Sequences | `pg_sequences` | name, data_type, start, increment, min, max, cycle |
| Extensions | `pg_extension` | name |
| Index details | `pg_index` + `pg_am` + `pg_opclass` (non-default via `opcdefault`) + `pg_get_expr(indpred)` | method, predicate, expressions, opclass per column |
| Index storage params | `pg_class.reloptions` (for index relation) | WITH parameters (m, ef_construction, key_field, etc.) |
| FK update rule | `information_schema.referential_constraints.update_rule` | update_rule |
| FK deferrability | `pg_constraint.condeferrable`, `pg_constraint.condeferred` | boolean |
| Column collation | `information_schema.columns.collation_name` | collation name |
| Column identity | `information_schema.columns.is_identity`, `identity_generation` | always/byDefault |
| Comments | `pg_description` + `pg_class` + `pg_attribute` | object comment |
| Partition info | `pg_partitioned_table` + `pg_class.relkind` | strategy, columns |

### 4.4 New ChangeKinds

```typescript
type ChangeKind =
  // Existing (14)
  | 'create_table' | 'drop_table'
  | 'add_column' | 'drop_column'
  | 'alter_column_type' | 'alter_column_nullable' | 'alter_column_default'
  | 'add_primary_key' | 'drop_primary_key'
  | 'add_foreign_key' | 'drop_foreign_key' | 'alter_foreign_key'
  | 'create_index' | 'drop_index'
  // New (14)
  | 'create_extension' | 'drop_extension'
  | 'create_enum' | 'alter_enum_add_value' | 'drop_enum'
  | 'create_sequence' | 'alter_sequence' | 'drop_sequence'
  | 'add_check_constraint' | 'drop_check_constraint'
  | 'alter_column_collation' | 'alter_column_identity'
  | 'add_comment' | 'drop_comment';
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: CHECK Constraints

```gherkin
@priority:high @type:nominal
SC-01: Schema with CHECK constraint generates ADD CONSTRAINT
  Given a schema defining table "users" with CHECK constraint "age_check" expression "age >= 18"
  When compareSchemata runs against empty DB
  Then diff contains add_check_constraint change with meta.check.expression = "age >= 18"
  And generateMigrationSQL produces 'ALTER TABLE "users" ADD CONSTRAINT "age_check" CHECK (age >= 18);'

@priority:high @type:nominal
SC-02: Introspected CHECK roundtrips without diff
  Given a DB with CHECK constraint "age_check" on "users"
  When introspect runs and schema matches
  Then compareSchemata produces zero changes

@priority:high @type:edge
SC-03: Removed CHECK constraint generates DROP
  Given a schema without CHECK constraint that DB has
  When compareSchemata runs
  Then diff contains drop_check_constraint change (destructive: true)

@priority:medium @type:edge
SC-04: PG-generated CHECK for NOT NULL excluded
  Given introspected CHECK constraints including system-generated ones
  When building TableIR
  Then system-generated constraints (name pattern) are filtered out
```

### Scenario Group: ENUM Types

```gherkin
@priority:high @type:nominal
SC-05: Schema with ENUM generates CREATE TYPE
  Given a schema defining enum "status" with values ['active', 'inactive', 'pending']
  When compareSchemata runs against empty DB
  Then diff contains create_enum change
  And SQL = 'CREATE TYPE "status" AS ENUM ('active', 'inactive', 'pending');'

@priority:high @type:nominal
SC-06: ENUM with new value generates ALTER TYPE ADD VALUE
  Given schema enum "status" = ['active', 'inactive', 'pending'] and DB enum = ['active', 'inactive']
  When compareSchemata runs
  Then diff contains alter_enum_add_value change with meta.value = 'pending'

@priority:high @type:error
SC-07: ENUM value removal throws error
  Given schema enum missing a value that DB has
  When compareSchemata runs
  Then throws InvalidOperationError with message about PG limitation

@priority:high @type:nominal
SC-08: ENUM used as column type introspects correctly
  Given DB column "users"."status" with type "status" (enum)
  When introspect runs
  Then ColumnIR.type = the enum name, ColumnIR.originalDbType = "status"

@priority:medium @type:edge
SC-09: create_enum phase before create_table phase
  Given new table with column using new enum type
  When generateMigrationSQL runs
  Then CREATE TYPE appears before CREATE TABLE in output
```

### Scenario Group: Index Enhancements

```gherkin
@priority:high @type:nominal
SC-10: Partial index with WHERE clause
  Given schema index with where = '"active" = true'
  When generateMigrationSQL runs
  Then SQL includes 'WHERE "active" = true'
  And introspection roundtrips without diff

@priority:high @type:nominal
SC-11: GIN index method
  Given schema index with method = 'gin' on jsonb column
  When generateMigrationSQL runs
  Then SQL includes 'USING gin'

@priority:medium @type:nominal
SC-12: Expression index
  Given schema index with expressions = ['LOWER("email")']
  When generateMigrationSQL runs
  Then SQL includes 'ON "users" (LOWER("email"))'

@priority:medium @type:edge
SC-13: Index method change detected
  Given schema index method = 'gin' but DB has 'btree'
  When compareSchemata runs
  Then diff contains drop_index + create_index (cannot ALTER INDEX method)

@priority:medium @type:nominal
SC-14: Covering index with INCLUDE
  Given schema index with include = ['name']
  When generateMigrationSQL runs
  Then SQL includes 'INCLUDE ("name")'
```

### Scenario Group: FK Enhancements

```gherkin
@priority:high @type:nominal
SC-15: FK with onUpdate CASCADE
  Given schema FK with onUpdate = 'CASCADE'
  When generateMigrationSQL runs
  Then SQL includes 'ON UPDATE CASCADE'

@priority:medium @type:nominal
SC-16: Deferred FK constraint
  Given schema FK with deferred = true
  When generateMigrationSQL runs
  Then SQL includes 'DEFERRABLE INITIALLY DEFERRED'

@priority:high @type:nominal
SC-17: FK auto-index in migrate path
  Given new table with single-column FK and no explicit index
  When generateMigrationSQL runs
  Then a create_index change is emitted for the FK column
  And behavior matches generateDDL fkAutoIndex behavior
```

### Scenario Group: Column Enhancements

```gherkin
@priority:medium @type:nominal
SC-18: Column with collation
  Given schema column with collation = 'en_US.utf8'
  When generateMigrationSQL runs
  Then CREATE TABLE includes 'COLLATE "en_US.utf8"'

@priority:medium @type:nominal
SC-19: Identity column (GENERATED ALWAYS)
  Given schema column with identity = 'always'
  When generateMigrationSQL runs
  Then SQL includes 'GENERATED ALWAYS AS IDENTITY'
  And does NOT use SERIAL

@priority:medium @type:nominal
SC-20: Identity column (BY DEFAULT)
  Given schema column with identity = 'byDefault'
  When generateMigrationSQL runs
  Then SQL includes 'GENERATED BY DEFAULT AS IDENTITY'

@priority:low @type:nominal
SC-21: Table comment
  Given schema table with comment = 'User accounts'
  When generateMigrationSQL runs
  Then SQL includes "COMMENT ON TABLE \"users\" IS 'User accounts';"

@priority:low @type:nominal
SC-22: Column comment
  Given schema column with comment = 'User email address'
  When generateMigrationSQL runs
  Then SQL includes "COMMENT ON COLUMN \"users\".\"email\" IS 'User email address';"

@priority:medium @type:edge
SC-23: Collation change detected
  Given schema collation differs from DB
  When compareSchemata runs
  Then diff contains alter_column_collation change
```

### Scenario Group: Sequences & Extensions

```gherkin
@priority:medium @type:nominal
SC-24: Extension declaration
  Given schema with extensions = ['pgvector', 'pg_trgm']
  When generateMigrationSQL runs against DB without them
  Then SQL includes 'CREATE EXTENSION IF NOT EXISTS "pgvector";' before any table SQL

@priority:medium @type:nominal
SC-25: Sequence creation
  Given schema with sequence "order_seq" (start: 1000, increment: 10)
  When generateMigrationSQL runs
  Then SQL includes 'CREATE SEQUENCE "order_seq" START WITH 1000 INCREMENT BY 10;'

@priority:medium @type:edge
SC-26: Extension already installed = no diff
  Given DB has extension "pgvector" installed and schema declares it
  When compareSchemata runs
  Then zero changes for extensions

@priority:low @type:nominal
SC-27: Sequence alteration (increment change)
  Given schema sequence increment differs from DB
  When compareSchemata runs
  Then diff contains alter_sequence change
```

### Scenario Group: Partitioning

```gherkin
@priority:medium @type:nominal
SC-28: Partitioned table creation
  Given schema table with partition = { strategy: 'range', columns: ['created_at'] }
  When generateMigrationSQL runs
  Then CREATE TABLE includes 'PARTITION BY RANGE ("created_at")'

@priority:medium @type:edge
SC-29: Partition strategy change = error
  Given schema partition strategy differs from DB
  When compareSchemata runs
  Then throws InvalidOperationError (PG cannot alter partition strategy)

@priority:low @type:nominal
SC-30: Partitioned table introspection roundtrip
  Given DB table with PARTITION BY RANGE
  When introspect → compareSchemata
  Then zero changes
```

### Scenario Group: Multi-Schema

```gherkin
@priority:low @type:nominal
SC-31: Introspect non-public schema
  Given DB with schema "tenant_1" containing tables
  When introspect(pool, { schema: 'tenant_1' })
  Then ModelIR contains tables from tenant_1 only

@priority:low @type:nominal
SC-32: Migration SQL uses schema qualification
  Given schemaName = 'tenant_1' in options
  When generateMigrationSQL runs
  Then all SQL statements use "tenant_1"."table_name" qualification
```

### Scenario Group: Consistency & Regression

```gherkin
@priority:high @type:regression
SC-33: Existing schemas without new features = zero diff
  Given a schema using only columns, PKs, FKs, basic indexes (no CHECK/ENUM/etc)
  When compareSchemata runs against matching DB
  Then zero changes (backward compat)

@priority:high @type:regression
SC-34: All existing migration-sql tests still pass
  Given existing test suite
  When running after all changes
  Then zero regressions

@priority:high @type:nominal
SC-35: generateDDL and generateMigrationSQL produce equivalent FK auto-indexes
  Given new table with single-column FK
  When both generateDDL and generateMigrationSQL run
  Then both produce an index on the FK column
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Regression |
|----------|---------|------|-------|------------|
| SC-01 | ✓ | | | |
| SC-02 | ✓ | | | |
| SC-03 | | ✓ | | |
| SC-04 | | ✓ | | |
| SC-05 | ✓ | | | |
| SC-06 | ✓ | | | |
| SC-07 | | | ✓ | |
| SC-08 | ✓ | | | |
| SC-09 | | ✓ | | |
| SC-10 | ✓ | | | |
| SC-11 | ✓ | | | |
| SC-12 | ✓ | | | |
| SC-13 | | ✓ | | |
| SC-14 | ✓ | | | |
| SC-15 | ✓ | | | |
| SC-16 | ✓ | | | |
| SC-17 | ✓ | | | |
| SC-18 | ✓ | | | |
| SC-19 | ✓ | | | |
| SC-20 | ✓ | | | |
| SC-21 | ✓ | | | |
| SC-22 | ✓ | | | |
| SC-23 | | ✓ | | |
| SC-24 | ✓ | | | |
| SC-25 | ✓ | | | |
| SC-26 | | ✓ | | |
| SC-27 | ✓ | | | |
| SC-28 | ✓ | | | |
| SC-29 | | | ✓ | |
| SC-30 | ✓ | | | |
| SC-31 | ✓ | | | |
| SC-32 | ✓ | | | |
| SC-33 | | | | ✓ |
| SC-34 | | | | ✓ |
| SC-35 | ✓ | | | |

### Scenario Group: Adversarial Hardening

```gherkin
@priority:high @type:edge @source:adversarial
SC-36: CHECK expression normalization (phantom diff prevention)
  Given DB CHECK expression "(age >= 18)" (PG-normalized with outer parens)
  And schema CHECK expression "age >= 18" (user-written without parens)
  When compareSchemata runs
  Then zero changes (normalization strips outer parens + collapses whitespace)

@priority:high @type:error @source:adversarial
SC-37: Drop ENUM fails if columns still reference it
  Given schema removes enum "status" but column "users"."status" still uses it
  When compareSchemata runs
  Then throws error listing dependent columns

@priority:high @type:nominal @source:user-feedback
SC-40: Index with operator class (gin_trgm_ops)
  Given schema index with method = 'gin' and opclass = {"name": "gin_trgm_ops"}
  When generateMigrationSQL runs
  Then SQL includes 'USING gin ("name" gin_trgm_ops)'
  And introspection roundtrips without diff (opclass from pg_opclass)

@priority:high @type:nominal @source:user-feedback
SC-41: Index with WITH parameters (HNSW)
  Given schema index with method = 'hnsw' and with = {"m": "16", "ef_construction": "64"}
  When generateMigrationSQL runs
  Then SQL includes 'WITH (m = 16, ef_construction = 64)'
  And introspection roundtrips via pg_class.reloptions

@priority:high @type:nominal @source:user-feedback
SC-42: Idempotent DDL (IF NOT EXISTS + DO block)
  Given migration with CREATE INDEX and ADD CHECK CONSTRAINT
  When generateMigrationSQL runs
  Then indexes use 'CREATE INDEX IF NOT EXISTS'
  And check constraints use 'DO $$ BEGIN ALTER TABLE ... ADD CONSTRAINT ... EXCEPTION WHEN duplicate_object THEN NULL; END $$'

@priority:medium @type:edge @source:adversarial
SC-38: Index opclass/WITH change detected as drop+recreate
  Given DB index with opclass=gin_trgm_ops but schema changed to vector_cosine_ops
  When compareSchemata runs
  Then diff contains drop_index + create_index (cannot ALTER opclass)

@priority:medium @type:edge @source:adversarial
SC-39: Empty ENUM (0 values)
  Given schema defines enum with empty value list
  When generateMigrationSQL runs
  Then SQL = 'CREATE TYPE "empty_enum" AS ENUM ();' (valid PG syntax)
```

**Totals:** 27 nominal, 10 edge, 3 error, 2 regression

## 6. Implementation Plan

### Block 1: CHECK Constraints — 60 min
**Type:** Feature slice
**Dependencies:** None
**Files:**
- `packages/types/src/model-ir.ts` — Add `CheckConstraintIR` interface, add `checkConstraints?` to `TableIR`
- `packages/adapter-pgsql/src/introspection.ts` — Add CHECK query (`pg_constraint` WHERE contype='c'), filter system-generated, build CheckConstraintIR[]
- `packages/adapter-pgsql/src/ddl/schema-diff.ts` — Add `compareCheckConstraints()`, new ChangeKinds `add_check_constraint` | `drop_check_constraint`
- `packages/adapter-pgsql/src/ddl/migration-sql.ts` — Add phases, `changeToUpSQL` cases, SQL generation
- `packages/adapter-pgsql/src/ddl/ddl-generator.ts` — Emit CHECK in `generateCreateTable` + separate ALTER TABLE
- Tests: SC-01, SC-02, SC-03, SC-04

**Exit criteria:**
- [ ] `any('age_check', 'age >= 18')` in schema → detected by introspection, compared, migrated
- [ ] Roundtrip: define → introspect → compare = 0 diff
- [ ] System-generated CHECKs filtered
- [ ] ADD CONSTRAINT uses idempotent DO block (SC-42)

### Block 2: ENUM Types — 90 min
**Type:** Feature slice
**Dependencies:** None (parallel with Block 1)
**Files:**
- `packages/types/src/model-ir.ts` — Add `EnumIR`, `enums?` on ModelIR
- `packages/adapter-pgsql/src/introspection.ts` — Add ENUM query (`pg_type` + `pg_enum`), build EnumIR map
- `packages/adapter-pgsql/src/ddl/schema-diff.ts` — Add `compareEnums()` at schema level (before table comparison), ChangeKinds `create_enum` | `alter_enum_add_value` | `drop_enum`
- `packages/adapter-pgsql/src/ddl/migration-sql.ts` — Add phases 0-1, SQL generation
- `packages/adapter-pgsql/src/ddl/ddl-generator.ts` — Emit CREATE TYPE before CREATE TABLE
- `packages/adapter-pgsql/src/ddl/type-mapping.ts` — Map enum column types
- Tests: SC-05, SC-06, SC-07, SC-08, SC-09

**Exit criteria:**
- [ ] CREATE TYPE emitted before CREATE TABLE
- [ ] ALTER TYPE ADD VALUE for new enum values
- [ ] InvalidOperationError on enum value removal
- [ ] Enum column type roundtrips correctly

### Block 3: Index Enhancements — 75 min
**Type:** Feature slice
**Dependencies:** None (parallel with Blocks 1-2)
**Files:**
- `packages/types/src/model-ir.ts` — Extend `IndexIR` with `method?`, `where?`, `expressions?`, `include?`, `opclass?`, `with?`
- `packages/adapter-pgsql/src/introspection.ts` — Use `pg_index` + `pg_am` + `pg_opclass` (non-default via `opcdefault`) + `pg_get_expr(indpred, indrelid, false)` for predicates + `pg_class.reloptions` for WITH params. NO indexdef parsing (/llm consensus).
- `packages/adapter-pgsql/src/ddl/schema-diff.ts` — Extend `compareIndexes()` to detect method/where/expression/opclass/with changes (drop+recreate if changed)
- `packages/adapter-pgsql/src/ddl/migration-sql.ts` — Extend `create_index` SQL: `CREATE INDEX IF NOT EXISTS ... USING method (col opclass) WITH (params) WHERE predicate`
- `packages/adapter-pgsql/src/ddl/ddl-generator.ts` — Same extensions for `generateCreateIndex`
- Tests: SC-10, SC-11, SC-12, SC-13, SC-14, SC-40, SC-41, SC-42

**Exit criteria:**
- [ ] `USING gin`, `WHERE active = true`, expression indexes, `INCLUDE (col)` all generate correctly
- [ ] `CREATE INDEX ... USING gin ("name" gin_trgm_ops)` generates correctly (opclass)
- [ ] `CREATE INDEX ... WITH (m=16, ef_construction=64)` generates correctly (WITH params)
- [ ] Opclass introspection via `pg_opclass` roundtrips (non-default only)
- [ ] WITH params introspection via `pg_class.reloptions` roundtrips
- [ ] Method/where/expression/opclass/with changes detected as drop+recreate
- [ ] All CREATE INDEX uses `IF NOT EXISTS`

### Block 4: FK Enhancements + Auto-Index — 45 min
**Type:** Feature slice
**Dependencies:** None
**Files:**
- `packages/types/src/model-ir.ts` — Add `onUpdate?`, `deferred?` to `ForeignKeyIR`
- `packages/adapter-pgsql/src/introspection.ts` — Add `update_rule` from referential_constraints, `condeferrable`/`condeferred` from `pg_constraint`
- `packages/adapter-pgsql/src/ddl/schema-diff.ts` — Extend `compareForeignKeys()` for onUpdate/deferred changes
- `packages/adapter-pgsql/src/ddl/migration-sql.ts` — Extend FK SQL with ON UPDATE, DEFERRABLE; add FK auto-index logic for new tables
- `packages/adapter-pgsql/src/ddl/ddl-generator.ts` — Same extensions
- Tests: SC-15, SC-16, SC-17

**Exit criteria:**
- [ ] ON UPDATE CASCADE in FK SQL
- [ ] DEFERRABLE INITIALLY DEFERRED in FK SQL
- [ ] New tables get auto-index on single-column FKs in migrate path

### Block 5: Column Enhancements — 45 min
**Type:** Feature slice
**Dependencies:** None
**Files:**
- `packages/types/src/model-ir.ts` — Add `collation?`, `comment?`, `identity?` to `ColumnIR`; `comment?` to `TableIR`
- `packages/adapter-pgsql/src/introspection.ts` — Add collation, identity, comment queries
- `packages/adapter-pgsql/src/ddl/schema-diff.ts` — Extend `compareColumnDetails()` for collation/identity; add `compareComments()`
- `packages/adapter-pgsql/src/ddl/migration-sql.ts` — Add `alter_column_collation`, `alter_column_identity`, `add_comment`, `drop_comment`
- `packages/adapter-pgsql/src/ddl/ddl-generator.ts` — Emit COLLATE, IDENTITY, COMMENT ON
- Tests: SC-18, SC-19, SC-20, SC-21, SC-22, SC-23

**Exit criteria:**
- [ ] COLLATE, GENERATED AS IDENTITY, COMMENT ON all generate correctly
- [ ] Identity columns don't use SERIAL
- [ ] Comment roundtrips through introspection

### Block 6: Sequences + Extensions — 45 min
**Type:** Feature slice
**Dependencies:** None
**Files:**
- `packages/types/src/model-ir.ts` — Add `SequenceIR`, `extensions?`, `sequences?` on ModelIR
- `packages/adapter-pgsql/src/introspection.ts` — Add `pg_sequences` and `pg_extension` queries
- `packages/adapter-pgsql/src/ddl/schema-diff.ts` — Add `compareExtensions()`, `compareSequences()` at schema level
- `packages/adapter-pgsql/src/ddl/migration-sql.ts` — Add phases 0-1, SQL for CREATE/DROP EXTENSION/SEQUENCE
- `packages/adapter-pgsql/src/ddl/ddl-generator.ts` — Emit extensions and sequences before tables
- Tests: SC-24, SC-25, SC-26, SC-27

**Exit criteria:**
- [ ] CREATE EXTENSION IF NOT EXISTS emitted before tables
- [ ] CREATE SEQUENCE with all options
- [ ] Already-installed extension = no diff

### Block 7: Partitioning (parent only) — 60 min
**Type:** Feature slice
**Dependencies:** None
**Scope:** Only parent table `PARTITION BY` clause. Partition child tables (`CREATE TABLE ... PARTITION OF ... FOR VALUES ...`) deferred to DDL-PARTITION-MGMT story.
**Files:**
- `packages/types/src/model-ir.ts` — Add `PartitionIR`, `partition?` on `TableIR`
- `packages/adapter-pgsql/src/introspection.ts` — Query `pg_partitioned_table`, detect `pg_class.relkind = 'p'`
- `packages/adapter-pgsql/src/ddl/schema-diff.ts` — Compare partition config (strategy change = error)
- `packages/adapter-pgsql/src/ddl/migration-sql.ts` — Emit PARTITION BY in CREATE TABLE
- `packages/adapter-pgsql/src/ddl/ddl-generator.ts` — Same
- Tests: SC-28, SC-29, SC-30

**Exit criteria:**
- [ ] PARTITION BY RANGE/LIST/HASH in CREATE TABLE
- [ ] Strategy change throws InvalidOperationError
- [ ] Roundtrip through introspection
- [ ] Partition child management explicitly out of scope

### Block 8: Multi-Schema + Regression — 30 min
**Type:** Feature slice + regression verification
**Dependencies:** All previous blocks
**Files:**
- `packages/adapter-pgsql/src/introspection.ts` — Accept schema array, multi-schema introspection
- `packages/adapter-pgsql/src/ddl/migration-sql.ts` — Schema-qualify all new SQL (already done per-statement)
- Regression tests across all existing test files
- Tests: SC-31, SC-32, SC-33, SC-34, SC-35

**Exit criteria:**
- [ ] `introspect(pool, { schema: 'tenant_1' })` works
- [ ] All new SQL schema-qualified
- [ ] Zero regressions on existing tests
- [ ] generateDDL ≡ generateMigrationSQL for FK auto-index

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | ~60 | Schema-diff comparison, SQL generation, type mapping |
| Integration | ~15 | Introspection queries against real PG (via Testcontainers) |
| E2E | ~5 | Full migrate dev → apply cycle |

### Test Data
- Extend existing `makeTable`/`makeModel` helpers with new IR fields
- For ENUM tests: create enum fixtures with various value sets
- For introspection tests: use Testcontainers PostgreSQL with pre-seeded schemas
- For regression: existing test fixtures unchanged

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| `pg_indexes.indexdef` parsing fragile | M | M | Use regex with fallback to raw storage; test with many index variants |
| ENUM introspection misses schema qualification | M | L | Always schema-qualify enum type names in queries |
| Phase ordering regression | H | L | Test with complex schemas combining all features |
| ModelIR breaking change | H | L | All new fields optional; existing schemas unaffected |
| CHECK expression normalization | M | M | Store raw expression; compare as string (PG may normalize differently) |

## 9. Definition of Done

- [ ] All 8 blocks implemented
- [ ] All 35 BDD scenarios have passing tests
- [ ] All existing tests pass (zero regressions)
- [ ] Lint/typecheck pass
- [ ] Documentation updated (CLAUDE.md DDL section if needed)
- [ ] /review clean (no blocking findings)
- [ ] `generateDDL` and `generateMigrationSQL` consistent for all features
