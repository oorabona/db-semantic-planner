---
doc-meta:
  status: canonical
  adversarial_applied: true
  scope: types,core,adapter
  type: specification
  target_project: /mnt/wsl/shared/dev/db-semantic-planner
  created: 2026-03-19
  updated: 2026-03-19
  complexity: COMPLEX
  time-budget: 90min
---

# Specification: CAPS — Multi-Adapter Capability Negotiation

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | types, core, adapter-pgsql |
| Complexity | COMPLEX |
| Time budget | 90 min |
| Blocks | 5 |
| BDD scenarios | 18 |
| Risk level | MEDIUM |
| Builds on | DIALECT-001 (canonical), DDL-COMPLETE (canonical) |

## 1. Problem Statement

DDL-COMPLETE added 12+ new ModelIR features (ENUM, sequences, extensions, partitioning, CHECK, identity, collation, comments, advanced indexes). These are stored in the universal ModelIR but only PostgreSQL knows how to handle them. When a future adapter (MySQL, SQLite, DuckDB) encounters these features, there is no mechanism to:
1. Detect which features the adapter supports
2. Configure what happens with unsupported features (warn vs error)
3. Translate features to dialect-specific equivalents (ENUM → CREATE TYPE vs inline ENUM)

## 2. User Stories

### US-1: Feature Detection at Schema Registration

```
AS A developer using dbsp with multiple database backends
I WANT unsupported schema features to be detected at createOrm() time
SO THAT I get early feedback instead of runtime SQL errors

ACCEPTANCE:
- createOrm() cross-checks ModelIR against DialectCapabilities
- Unsupported features emit warnings by default
- Can configure 'error' mode for strict environments
```

### US-2: Multi-Database Schema Portability

```
AS A developer maintaining a schema used across PG + MySQL
I WANT to know exactly which features are portable and which are PG-only
SO THAT I can make informed decisions about schema design

ACCEPTANCE:
- Compatibility matrix documents feature support per database
- Warning messages identify the specific unsupported feature
- Features can be silently ignored without breaking DDL generation
```

### US-3: Dialect-Specific Feature Translation

```
AS an adapter author
I WANT a standard interface for translating IR features to my dialect
SO THAT features like ENUM can work differently per database

ACCEPTANCE:
- FeatureTranslator interface defined in types package
- Each adapter can register translators for specific IR features
- Untranslated features fall through to UnsupportedFeatureBehavior
```

## 3. Business Rules

### 3.1 Invariants

- INV-01: All DDL feature flags on DialectCapabilities MUST be optional (backward compat with existing adapter code)
- INV-02: Missing capability flag = feature unsupported (safe default)
- INV-03: UnsupportedFeatureBehavior default = `'warning'`
- INV-04: Warning messages MUST identify: feature name, schema element, adapter name
- INV-05: `'ignore'` mode produces zero output (no warnings, no errors)
- INV-06: Feature negotiation MUST NOT modify the ModelIR (read-only check)
- INV-07: Existing DialectCapabilities fields MUST NOT change default values
- INV-08: POSTGRESQL_CAPABILITIES MUST set all new DDL flags to `true`
- INV-09: DDL flags split to ~15 individual flags (/llm consensus: advancedIndexes and deferredConstraints too coarse when split, disjoint DB support). Groups: schema-level (enum, sequences, extensions, partitioning), constraints (check, onUpdateFK, deferredFK), columns (identity, collation, comments), indexes (methods, opclass, include, partial, expression)
- INV-10: A capability flag = "adapter can handle this IR feature" (not "generates identical SQL to PG"). Partial/different support is valid (e.g., MySQL ENUM inline ≠ PG CREATE TYPE)
- INV-11: `createDialectCapabilities(overrides)` factory helper MUST exist for adapter authors (fills safe defaults + validates)
- INV-12: FeatureTranslator element param MUST be type-safe per DDLFeature (discriminated union, not `unknown`)

### 3.2 Preconditions

- PRE-01: DialectCapabilities must be available on the adapter (via `dialectCapabilities` property)
- PRE-02: ModelIR must be registered before negotiation runs

### 3.3 Effects

- EFF-01: `createOrm()` with `unsupportedFeatures: 'warning'` logs warnings for unsupported features
- EFF-02: `createOrm()` with `unsupportedFeatures: 'error'` throws `UnsupportedFeatureError` for first unsupported feature
- EFF-03: `generateDDL()` skips unsupported features when behavior = `'warning'` or `'ignore'`
- EFF-04: `compareSchemata()` ignores unsupported features (no false diffs)

### 3.4 Error Handling

- ERR-01: `UnsupportedFeatureError` extends `Error` with `feature`, `adapter`, `element` fields
- ERR-02: When behavior = `'error'`, throw on FIRST unsupported feature (fail-fast)
- ERR-03: When behavior = `'warning'`, collect ALL warnings (not fail-fast)

## 4. Technical Design

### 4.1 Architecture Decision

Extend existing `DialectCapabilities` (not `AdapterCapabilities`) because:
- DDL features are SQL dialect features, not adapter-level capabilities
- `DialectCapabilities` already has the pattern (boolean flags + syntax variants)
- `POSTGRESQL_CAPABILITIES` is the natural place to declare PG support
- Existing adapters that don't set the new flags get `undefined` = unsupported (safe default per INV-02)

### 4.2 Type Changes

#### `packages/types/src/dialects.ts` — DialectCapabilities extension (~15 flags, /llm consensus)

```typescript
// DDL Feature Support (CAPS-001) — split per /llm consensus (Codex + Copilot HIGH agreement)
// Schema-level features
/** ENUM types (PG: CREATE TYPE, MySQL: inline ENUM(), SQLite: CHECK) */
readonly supportsDDLEnumTypes?: boolean;
/** Sequences (PG: CREATE SEQUENCE, MySQL: N/A uses AUTO_INCREMENT) */
readonly supportsDDLSequences?: boolean;
/** Extensions (PG: CREATE EXTENSION, others: N/A or load_extension) */
readonly supportsDDLExtensions?: boolean;
/** Table partitioning (PG/MySQL: PARTITION BY, SQLite: N/A) */
readonly supportsDDLPartitioning?: boolean;

// Constraint features
/** CHECK constraints (PG/MySQL 8.0.16+/SQLite: CHECK) */
readonly supportsDDLCheckConstraints?: boolean;
/** ON UPDATE actions on FK (CASCADE, SET NULL, etc.) */
readonly supportsDDLOnUpdateFK?: boolean;
/** DEFERRABLE INITIALLY DEFERRED on FK constraints */
readonly supportsDDLDeferredFK?: boolean;

// Column features
/** Identity columns — GENERATED {ALWAYS|BY DEFAULT} AS IDENTITY */
readonly supportsDDLIdentityColumns?: boolean;
/** Column collation (COLLATE) */
readonly supportsDDLCollation?: boolean;
/** COMMENT ON TABLE/COLUMN (PG: COMMENT ON, MySQL: inline COMMENT) */
readonly supportsDDLComments?: boolean;

// Index features (split per Codex/Copilot: disjoint DB support)
/** Non-btree index methods (GIN, GiST, HASH, BRIN, HNSW) */
readonly supportsDDLIndexMethods?: boolean;
/** Per-column operator class (gin_trgm_ops, vector_cosine_ops) */
readonly supportsDDLIndexOpclass?: boolean;
/** INCLUDE non-key columns (PG11+, Oracle 18c+, MSSQL) */
readonly supportsDDLIndexInclude?: boolean;
/** Partial indexes (WHERE clause) */
readonly supportsDDLPartialIndexes?: boolean;
/** Expression/functional indexes */
readonly supportsDDLExpressionIndexes?: boolean;
```

#### `packages/types/src/adapter.ts` — New types

```typescript
/** Behavior when schema uses features the adapter doesn't support */
export type UnsupportedFeatureBehavior = 'error' | 'warning' | 'ignore';

/** Per-feature behavior overrides (global default + optional per-feature) */
export interface FeatureBehaviorConfig {
  /** Global default behavior (default: 'warning') */
  readonly default: UnsupportedFeatureBehavior;
  /** Per-feature overrides. Example: { checkConstraint: 'error', comment: 'ignore' } */
  readonly overrides?: Partial<Record<DDLFeature, UnsupportedFeatureBehavior>>;
}

/** Error thrown when behavior = 'error' and unsupported feature detected */
export class UnsupportedFeatureError extends Error {
  constructor(
    readonly feature: string,
    readonly adapter: string,
    readonly element: string,
  ) {
    super(`Unsupported feature "${feature}" on adapter "${adapter}" for "${element}"`);
    this.name = 'UnsupportedFeatureError';
  }
}

/** Warning emitted when behavior = 'warning' */
export interface FeatureWarning {
  readonly feature: string;
  readonly adapter: string;
  readonly element: string;
  readonly message: string;
}
```

#### `packages/types/src/adapter.ts` — FeatureTranslator interface (CAPS-005)

```typescript
/**
 * Interface for translating IR features to dialect-specific SQL.
 * Adapters register translators to handle features their way.
 * Example: EnumIR → CREATE TYPE in PG, inline ENUM(...) in MySQL, CHECK IN(...) in SQLite.
 */
/** Type-safe element map: DDLFeature → IR type (INV-12) */
export interface DDLFeatureElementMap {
  enum: EnumIR;
  sequence: SequenceIR;
  extension: string;
  partition: PartitionIR;
  checkConstraint: CheckConstraintIR;
  onUpdateFK: ForeignKeyIR;
  deferredFK: ForeignKeyIR;
  identity: ColumnIR;
  collation: ColumnIR;
  comment: { target: 'table' | 'column'; name: string; comment: string };
  indexMethod: IndexIR;
  indexOpclass: IndexIR;
  indexInclude: IndexIR;
  partialIndex: IndexIR;
  expressionIndex: IndexIR;
}

export interface FeatureTranslator<F extends DDLFeature = DDLFeature> {
  /** Which IR feature this translator handles */
  readonly feature: F;
  /** Generate SQL for this feature. Return null to skip (use default behavior). */
  translate(element: DDLFeatureElementMap[F], context: TranslationContext): string[] | null;
}

/** Aligned with DialectCapabilities flags (1:1 mapping) */
export type DDLFeature =
  | 'enum' | 'sequence' | 'extension' | 'partition'
  | 'checkConstraint' | 'onUpdateFK' | 'deferredFK'
  | 'identity' | 'collation' | 'comment'
  | 'indexMethod' | 'indexOpclass' | 'indexInclude'
  | 'partialIndex' | 'expressionIndex';

export interface TranslationContext {
  readonly schemaName?: string;
  readonly tableName?: string;
  readonly dialectCapabilities: DialectCapabilities;
}
```

### 4.3 Core Changes

#### `packages/core/src/dx/orm.ts` — createOrm options

```typescript
export interface CreateOrmOptions<T> {
  model: T;
  adapter: Adapter;
  /** Behavior when schema uses features the adapter doesn't support. Default: 'warning' */
  unsupportedFeatures?: UnsupportedFeatureBehavior | FeatureBehaviorConfig;
}
```

#### `packages/core/src/dx/negotiate-features.ts` — New file

Feature negotiation function that:
1. Walks the ModelIR
2. For each DDL feature used, checks `dialectCapabilities.supportsDDL*`
3. Emits warnings or throws based on `UnsupportedFeatureBehavior`

### 4.4 Adapter Changes

#### `packages/core/src/dialects/index.ts` — POSTGRESQL_CAPABILITIES

Add all new DDL flags set to `true`.

#### `packages/adapter-pgsql/src/ddl/ddl-generator.ts` + `migration-sql.ts`

Check `dialectCapabilities` before generating dialect-specific SQL. Skip features where capability is `false`/`undefined`.

## 5. Acceptance Criteria (BDD)

### Scenario Group: Feature Detection (CAPS-001)

```gherkin
@priority:high @type:nominal
Scenario: SC-01 PostgreSQL adapter declares all DDL capabilities
  Given a PgsqlAdapter instance
  When I read dialectCapabilities
  Then supportsDDLEnumTypes = true
  And supportsDDLSequences = true
  And supportsDDLPartitioning = true
  And all 15 DDL flags = true

@priority:high @type:nominal
Scenario: SC-02 Missing capability flag defaults to unsupported
  Given a DialectCapabilities object without supportsDDLEnumTypes
  When feature negotiation checks for ENUM support
  Then the feature is treated as unsupported

@priority:high @type:edge
Scenario: SC-03 Existing adapters without new flags still work
  Given an adapter with old DialectCapabilities (no DDL flags)
  When createOrm() is called with a schema using ENUMs
  Then a warning is emitted (not an error)
  And the ORM instance is created successfully
```

### Scenario Group: Warning Behavior (CAPS-002)

```gherkin
@priority:high @type:nominal
Scenario: SC-04 Default warning mode emits warnings
  Given createOrm({ unsupportedFeatures: 'warning' })
  And a schema with ENUMs on an adapter without supportsDDLEnumTypes
  When createOrm() initializes
  Then console.warn is called with feature "enum", adapter name, element name
  And the ORM instance is returned (not thrown)

@priority:high @type:nominal
Scenario: SC-05 Error mode throws on unsupported feature
  Given createOrm({ unsupportedFeatures: 'error' })
  And a schema with ENUMs on an adapter without supportsDDLEnumTypes
  When createOrm() initializes
  Then UnsupportedFeatureError is thrown
  And error.feature = "enum"
  And error.adapter = adapter name

@priority:medium @type:nominal
Scenario: SC-06 Ignore mode silently skips
  Given createOrm({ unsupportedFeatures: 'ignore' })
  And a schema with ENUMs on an adapter without supportsDDLEnumTypes
  When createOrm() initializes
  Then no warnings emitted, no errors thrown
  And the ORM instance is returned

@priority:high @type:edge
Scenario: SC-07 Warning mode collects ALL unsupported features
  Given a schema with ENUMs + sequences + extensions
  And an adapter supporting none of them
  When createOrm({ unsupportedFeatures: 'warning' }) initializes
  Then 3 warnings are emitted (one per feature type)

@priority:medium @type:nominal
Scenario: SC-08 Supported features produce no warnings
  Given a PostgreSQL adapter (all DDL flags true)
  And a schema with ENUMs + sequences + extensions
  When createOrm() initializes
  Then zero warnings emitted
```

### Scenario Group: DDL Generation with Negotiation (CAPS-003)

```gherkin
@priority:high @type:nominal
Scenario: SC-09 generateDDL skips unsupported ENUMs in warning mode
  Given an adapter with supportsDDLEnumTypes = false
  And unsupportedFeatures = 'warning'
  And a schema with ENUM types
  When generateDDL() is called
  Then no CREATE TYPE statements are emitted
  And remaining DDL (tables, indexes) is generated normally

@priority:high @type:nominal
Scenario: SC-10 generateDDL includes all features for PG
  Given a PostgreSQL adapter (all flags true)
  When generateDDL() is called on a full schema
  Then CREATE TYPE, CREATE SEQUENCE, CREATE EXTENSION all present

@priority:high @type:nominal
Scenario: SC-11 compareSchemata ignores unsupported features
  Given an adapter with supportsDDLEnumTypes = false
  And schema has ENUMs but DB doesn't
  When compareSchemata() runs
  Then no create_enum changes are emitted (feature ignored)

@priority:medium @type:edge
Scenario: SC-12 Partial support — some features supported, some not
  Given an adapter with supportsDDLCheckConstraints = true but supportsDDLEnumTypes = false
  And a schema with both CHECK constraints and ENUMs
  When generateDDL() is called
  Then CHECK constraints are generated
  And ENUM types are skipped
```

### Scenario Group: Feature Translation Interface (CAPS-005)

```gherkin
@priority:medium @type:nominal
Scenario: SC-13 FeatureTranslator interface is usable
  Given a mock translator for 'enum' feature
  When translate() is called with an EnumIR
  Then it returns dialect-specific SQL strings

@priority:medium @type:nominal
Scenario: SC-14 Translator returning null falls through to skip
  Given a translator that returns null for 'sequence'
  When the adapter processes a SequenceIR
  Then the feature is skipped (treated as unsupported)
```

### Scenario Group: Compatibility Matrix (CAPS-004)

```gherkin
@priority:high @type:nominal
Scenario: SC-15 PG supports all DDL features
  Given the POSTGRESQL_CAPABILITIES constant
  Then all 15 supportsDDL* flags are true

@priority:medium @type:nominal
Scenario: SC-16 Matrix documents MySQL limitations
  Given the MySQL compatibility section
  Then ENUM = supported (inline), sequences = unsupported, extensions = unsupported

@priority:medium @type:nominal
Scenario: SC-17 Matrix documents SQLite limitations
  Given the SQLite compatibility section
  Then ENUM = unsupported (translate to CHECK), partitioning = unsupported

@priority:low @type:nominal
Scenario: SC-18 Matrix documents Tier 2 databases
  Given the Oracle/MSSQL/CouchDB compatibility sections
  Then each has a support level documented (full/partial/none per feature)
```

**Coverage matrix:**

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | ✓ | | | |
| SC-02 | ✓ | | | |
| SC-03 | | ✓ | | |
| SC-04 | ✓ | | | |
| SC-05 | | | ✓ | |
| SC-06 | ✓ | | | |
| SC-07 | | ✓ | | |
| SC-08 | ✓ | | | |
| SC-09 | ✓ | | | |
| SC-10 | ✓ | | | |
| SC-11 | ✓ | | | |
| SC-12 | | ✓ | | |
| SC-13 | ✓ | | | |
| SC-14 | ✓ | | | |
| SC-15 | ✓ | | | |
| SC-16 | ✓ | | | |
| SC-17 | ✓ | | | |
| SC-18 | ✓ | | | |

## 6. Implementation Plan

### Block 1: DDL Feature Flags on DialectCapabilities — 20 min

**Type:** Feature slice
**Packages:** types, core, adapter-pgsql
**Files:**
- `packages/types/src/dialects.ts` — Add 17 optional `supportsDDL*` boolean fields to DialectCapabilities
- `packages/core/src/dialects/index.ts` — Set all 17 to `true` in POSTGRESQL_CAPABILITIES
- `packages/types/src/adapter.ts` — Add `UnsupportedFeatureBehavior` type, `UnsupportedFeatureError` class, `FeatureWarning` interface

**Tests:** SC-01, SC-02, SC-03
**Exit criteria:**
- [ ] 15 new optional fields on DialectCapabilities
- [ ] POSTGRESQL_CAPABILITIES has all 15 = true
- [ ] `createDialectCapabilities(overrides)` factory helper exists (INV-11)
- [ ] Types compile cleanly

### Block 2: Feature Negotiation in createOrm — 25 min

**Type:** Feature slice
**Packages:** core
**Dependencies:** Block 1
**Files:**
- `packages/core/src/dx/negotiate-features.ts` — New file: `negotiateFeatures(model, capabilities, behavior)` function
- `packages/core/src/dx/orm.ts` — Add `unsupportedFeatures` to CreateOrmOptions, call `negotiateFeatures` in createOrm
- `packages/core/src/dx/orm-instance.ts` — Pass behavior through to ORM instance

**Tests:** SC-04, SC-05, SC-06, SC-07, SC-08
**Exit criteria:**
- [ ] `negotiateFeatures()` walks ModelIR and checks each feature
- [ ] Warning mode emits all warnings
- [ ] Error mode throws on first unsupported feature
- [ ] Ignore mode produces no output

### Block 3: DDL Generation Respects Capabilities — 20 min

**Type:** Feature slice
**Packages:** adapter-pgsql
**Dependencies:** Block 1
**Files:**
- `packages/adapter-pgsql/src/ddl/ddl-generator.ts` — Check `dialectCapabilities` before each DDL pass (ENUM, sequence, extension, comment, etc.)
- `packages/adapter-pgsql/src/ddl/migration-sql.ts` — Same checks in `changeToUpSQL` for unsupported change kinds
- `packages/adapter-pgsql/src/ddl/schema-diff.ts` — Skip comparison for unsupported features

**Tests:** SC-09, SC-10, SC-11, SC-12
**Exit criteria:**
- [ ] Unsupported features skipped in DDL generation
- [ ] Unsupported features ignored in schema comparison
- [ ] PG generates everything (regression)

### Block 4: Compatibility Matrix Documentation — 15 min

**Type:** Documentation
**Packages:** docs
**Dependencies:** Block 1 (needs final flag list)
**Files:**
- `docs/specs/CAPS-compatibility-matrix.md` — Full feature × database matrix

**Content:**

| Feature | PostgreSQL | MySQL 8+ | SQLite 3.35+ | DuckDB | Oracle | MSSQL | CouchDB |
|---------|-----------|----------|-------------|--------|--------|-------|---------|
| ENUM types | CREATE TYPE | inline ENUM() | — (CHECK) | CREATE TYPE | — (CHECK) | — (CHECK) | N/A |
| Sequences | CREATE SEQUENCE | — (AUTO_INCREMENT) | — (AUTOINCREMENT) | CREATE SEQUENCE | CREATE SEQUENCE | CREATE SEQUENCE | N/A |
| Extensions | CREATE EXTENSION | — | load_extension() | — | — | — | N/A |
| Partitioning | PARTITION BY | PARTITION BY | — | — | PARTITION BY | PARTITION | N/A |
| CHECK | CHECK | CHECK (8.0.16+) | CHECK | CHECK | CHECK | CHECK | N/A |
| Identity | GENERATED AS IDENTITY | — (AUTO_INCREMENT) | — (AUTOINCREMENT) | GENERATED | GENERATED | IDENTITY | N/A |
| Collation | COLLATE | COLLATE | COLLATE | COLLATE | NLS_SORT | COLLATE | N/A |
| Comments | COMMENT ON | COMMENT (inline) | — | COMMENT ON | COMMENT ON | sp_addextendedproperty | N/A |
| Index methods | GIN,GiST,HASH,BRIN | BTREE,HASH | — | — | BITMAP | — | N/A |
| Opclass | per-column | — | — | — | — | — | N/A |
| INCLUDE columns | PG11+ | — | — | — | Oracle 18c+ | SQL2016+ | N/A |
| Partial indexes | WHERE | — | WHERE (3.9+) | — | — | WHERE | N/A |
| Expression indexes | ✓ | ✓ (8.0.13+) | ✓ | ✓ | function-based | computed columns | N/A |
| ON UPDATE FK | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | N/A |
| Deferred FK | DEFERRABLE | — | DEFERRABLE | — | DEFERRABLE | — | N/A |

Tier classification:
- **Tier 1** (full support target): PostgreSQL, MySQL, SQLite, DuckDB
- **Tier 2** (best-effort): Oracle, MSSQL
- **Tier 3** (document-only): CouchDB (document DB, no DDL)

**Tests:** SC-15, SC-16, SC-17, SC-18
**Exit criteria:**
- [ ] Matrix covers all 15 DDL features × 7 databases
- [ ] Translation notes for each partial-support cell

### Block 5: FeatureTranslator Interface Design — 10 min

**Type:** Interface design (no implementation)
**Packages:** types
**Dependencies:** Block 1
**Files:**
- `packages/types/src/adapter.ts` — Add `FeatureTranslator`, `DDLFeature`, `TranslationContext` types

**Tests:** SC-13, SC-14 (type-level tests only)
**Exit criteria:**
- [ ] Interface compiles
- [ ] Can be implemented by a mock in tests
- [ ] No adapter implementation required yet

## 7. Test Strategy

### Test pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 14 | Feature detection, negotiation, DDL skip logic |
| Integration | 4 | createOrm + adapter + schema end-to-end |
| E2E | 0 | No DB needed (compile-only testing) |

### Test files

| Block | Test file | Tests |
|-------|-----------|-------|
| 1 | `packages/core/src/dialects/dialects.test.ts` | SC-01, SC-02, SC-03 |
| 2 | `packages/core/src/dx/negotiate-features.test.ts` | SC-04→SC-08 |
| 3 | `packages/adapter-pgsql/src/ddl/ddl.test.ts` (extend) | SC-09→SC-12 |
| 5 | `packages/types/src/adapter.test.ts` | SC-13, SC-14 |

### Test data

- Mock adapter with configurable capabilities (set specific flags false)
- Minimal ModelIR with one of each DDL feature (enum, sequence, extension, etc.)
- Spy on `console.warn` for warning mode tests

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Breaking existing adapters | H | L | All new fields optional (INV-01), undefined = unsupported |
| Performance overhead in createOrm() | L | L | Negotiation is O(features × tables), runs once at init |
| Incorrect compatibility matrix | M | M | Research-based, mark uncertain cells with `?`, iterate |
| FeatureTranslator over-engineering | M | M | Design only (CAPS-005), defer implementation to adapter stories |

## 9. Definition of Done

- [ ] All 5 blocks implemented
- [ ] All 18 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration)
- [ ] Lint/typecheck pass across all packages
- [ ] Compatibility matrix published
- [ ] /review clean (no blocking findings)
- [ ] POSTGRESQL_CAPABILITIES regression: all existing tests still pass
