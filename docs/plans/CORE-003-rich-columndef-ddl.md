---
doc-meta:
  status: draft
  scope: core
  type: specification
  created: 2025-01-18
  updated: 2025-01-18
  complexity: COMPLEX
  time-budget: 2h
---

# Specification: Rich ColumnDef for Full DDL Support

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | core + adapter-kysely |
| Complexity | COMPLEX |
| Time budget | 2h |
| Blocks | 4 |
| BDD scenarios | 12 |
| Risk level | MEDIUM |

## 1. Problem Statement

`defineSchema()` only accepts simple type strings (`'string'`, `'number'`), losing constraint information (nullable, unique, default, FK references, indexes). This forces users to write manual DDL that can drift from TypeScript schema. We need `ColumnDef` to capture full DDL information so `generateDDL()` produces complete, accurate SQL.

## 2. User Stories

### US-01: Schema with Constraints
```
AS A developer using db-semantic-planner
I WANT to define columns with constraints (nullable, unique, default, primaryKey)
SO THAT generated DDL matches my exact requirements without manual SQL

ACCEPTANCE: defineSchema with rich ColumnDef produces correct DDL
```

### US-02: Foreign Key References
```
AS A developer defining relational schemas
I WANT to specify explicit FK references with onDelete behavior
SO THAT referential integrity is enforced at database level

ACCEPTANCE: FK constraints generated with correct table/column/onDelete
```

### US-03: Index Definition
```
AS A developer optimizing query performance
I WANT to define indexes (single and composite) in my schema
SO THAT DDL includes CREATE INDEX statements

ACCEPTANCE: Both column-level and table-level indexes generate correct DDL
```

## 3. Business Rules

### 3.1 Invariants (always true)

- INV-01: All column definitions must have a `type` property
- INV-02: Primary key columns cannot be nullable
- INV-03: All user-provided identifiers must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/`
- INV-04: FK references must point to tables defined in the same schema

### 3.2 Preconditions (required before action)

- PRE-01: Schema object must have at least one table
- PRE-02: Each table must have at least one column
- PRE-03: Each table must have a primary key (explicit or inferred from `id` column)

### 3.3 Effects (what changes)

- EFF-01: `ColumnDef` becomes an object with `type` + optional constraints
- EFF-02: `TableIR` gains `indexes: readonly IndexIR[]` property
- EFF-03: `generateDDL()` uses two-pass strategy: CREATE TABLEs, then ALTER TABLEs for FKs
- EFF-04: Schema builder extracts column-level `index: true` into `IndexIR`

### 3.4 Error Handling

- ERR-01: When `primaryKey: true` + `nullable: true` → `SchemaError: "Primary key column cannot be nullable"`
- ERR-02: When `default: null` + `nullable: false` → `SchemaError: "Cannot default to null on non-nullable column"`
- ERR-03: When `references.table` not in schema → `SchemaError: "FK references unknown table"`
- ERR-04: When multiple columns have `primaryKey: true` → `SchemaError: "Use table-level primaryKey for composite keys"`
- ERR-05: When identifier fails regex → `SchemaError: "Invalid identifier: must be alphanumeric with underscores"`

## 4. Technical Design

### 4.1 Architecture Decision

**Approach:** Extend existing types in-place, no backward compatibility layer.

**Why:**
- Project is pre-1.0, no external consumers
- Simpler codebase without union type discrimination
- All existing usages will be fixed as part of implementation

### 4.2 Data Model Changes

| Entity | Change | Migration needed |
|--------|--------|------------------|
| `ColumnDef` | Object with `type` + constraints | No (type only) |
| `IndexIR` | New interface | No (type only) |
| `TableIR` | Add `indexes` property | No (type only) |
| `DefaultValue` | New type for safe defaults | No (type only) |

### 4.3 Type Definitions

```typescript
// packages/core/src/model-ir.ts
export interface IndexIR {
  readonly name?: string;
  readonly columns: readonly string[];
  readonly unique?: boolean;
}

export interface TableIR {
  // ... existing properties
  readonly indexes: readonly IndexIR[];  // NEW
}

// packages/core/src/schema-builder.ts
export type OnDeleteAction = 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION';

export interface SqlDefault {
  readonly sql: string;
}

export type DefaultValue = string | number | boolean | null | SqlDefault;

export interface ColumnDef {
  readonly type: ColumnType;
  readonly nullable?: boolean;
  readonly unique?: boolean;
  readonly primaryKey?: boolean;
  readonly default?: DefaultValue;
  readonly index?: boolean | string;
  readonly references?: {
    readonly table: string;
    readonly column?: string;  // default: 'id'
    readonly onDelete?: OnDeleteAction;
  };
}

export interface IndexDef {
  readonly columns: readonly string[];
  readonly unique?: boolean;
  readonly name?: string;
}

export type TableDef =
  | Record<string, ColumnDef>
  | {
      readonly columns: Record<string, ColumnDef>;
      readonly primaryKey?: string | readonly string[];
      readonly indexes?: readonly IndexDef[];
    };
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: Column Constraints

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Simple column with type only
  Given a schema with `users: { id: { type: 'number' } }`
  When calling defineSchema().build()
  Then ColumnIR has type='number', nullable=false

@priority:high @type:nominal
Scenario: SC-02 Nullable column
  Given a schema with `bio: { type: 'string', nullable: true }`
  When generating DDL
  Then output contains column without NOT NULL constraint

@priority:high @type:nominal
Scenario: SC-03 Unique column
  Given a schema with `email: { type: 'string', unique: true }`
  When generating DDL
  Then output contains UNIQUE constraint

@priority:high @type:nominal
Scenario: SC-04 Column with literal default
  Given a schema with `status: { type: 'string', default: 'active' }`
  When generating DDL
  Then output contains DEFAULT 'active'

@priority:medium @type:nominal
Scenario: SC-05 Column with SQL default
  Given a schema with `createdAt: { type: 'datetime', default: { sql: 'now()' } }`
  When generating DDL
  Then output contains DEFAULT now()
  And RAW_SQL_USAGE warning is emitted
```

### Scenario Group: Primary Keys

```gherkin
@priority:high @type:nominal
Scenario: SC-06 Column-level primary key
  Given a schema with `id: { type: 'number', primaryKey: true }`
  When calling defineSchema().build()
  Then TableIR.primaryKey equals 'id'

@priority:medium @type:nominal
Scenario: SC-07 Table-level composite primary key
  Given a schema with table config `primaryKey: ['tenantId', 'id']`
  When calling defineSchema().build()
  Then TableIR.primaryKey equals ['tenantId', 'id']

@priority:high @type:error
Scenario: SC-08 Reject nullable primary key
  Given a schema with `id: { type: 'number', primaryKey: true, nullable: true }`
  When calling defineSchema().build()
  Then throws SchemaError "Primary key column cannot be nullable"
```

### Scenario Group: Foreign Keys

```gherkin
@priority:high @type:nominal
Scenario: SC-09 FK with explicit reference
  Given tables `users` and `posts` where `posts.authorId` references `users`
  And schema has `authorId: { type: 'number', references: { table: 'users' } }`
  When generating DDL
  Then output contains ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_authorId"
  And FK references "users"("id")

@priority:medium @type:nominal
Scenario: SC-10 FK with onDelete CASCADE
  Given a schema with `references: { table: 'users', onDelete: 'CASCADE' }`
  When generating DDL
  Then output contains ON DELETE CASCADE

@priority:high @type:error
Scenario: SC-11 Reject FK to unknown table
  Given a schema with only `users` table
  And `users.orgId` references `orgs` which doesn't exist
  When calling defineSchema().build()
  Then throws SchemaError "FK references unknown table 'orgs'"
```

### Scenario Group: Indexes

```gherkin
@priority:high @type:nominal
Scenario: SC-12 Column-level index
  Given a schema with `email: { type: 'string', index: true }`
  When generating DDL
  Then output contains CREATE INDEX "idx_users_email"

@priority:medium @type:nominal
Scenario: SC-13 Composite index (table-level)
  Given a schema with table config `indexes: [{ columns: ['lastName', 'firstName'] }]`
  When generating DDL
  Then output contains CREATE INDEX "idx_users_lastName_firstName"
```

**Coverage matrix:**

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | ✓ | | | |
| SC-02 | ✓ | | | |
| SC-03 | ✓ | | | |
| SC-04 | ✓ | | | |
| SC-05 | ✓ | | | ✓ (warning) |
| SC-06 | ✓ | | | |
| SC-07 | | ✓ | | |
| SC-08 | | | ✓ | |
| SC-09 | ✓ | | | |
| SC-10 | ✓ | | | |
| SC-11 | | | ✓ | |
| SC-12 | ✓ | | | |
| SC-13 | | ✓ | | |

## 6. Implementation Plan

### Block 1: Model IR Extensions — 15min
**Type:** Infrastructure
**Dependencies:** None
**Files:**
- `packages/core/src/model-ir.ts` — Add `IndexIR`, update `TableIR`

**Exit criteria:**
- [x] `IndexIR` interface defined (DONE)
- [x] `TableIR.indexes` property added (DONE)
- [ ] TypeScript compiles without errors

---

### Block 2: Schema Builder Types — 30min
**Type:** Feature slice
**Dependencies:** Block 1
**Files:**
- `packages/core/src/schema-builder.ts` — New `ColumnDef`, `TableDef`, validation

**Exit criteria:**
- [ ] `ColumnDef` interface with all constraint properties
- [ ] `TableDef` union type (simple vs config form)
- [ ] `OnDeleteAction`, `DefaultValue`, `SqlDefault` types exported
- [ ] Identifier validation regex constant

---

### Block 3: Schema Builder Logic — 45min
**Type:** Feature slice
**Dependencies:** Block 2
**Files:**
- `packages/core/src/schema-builder.ts` — Update `buildTable()`, add validations

**Exit criteria:**
- [ ] `buildTable()` handles new `ColumnDef` format
- [ ] Column-level `index: true` → `IndexIR`
- [ ] Table-level `indexes` → `IndexIR[]`
- [ ] All ERR-* validations implemented
- [ ] Unit tests for validations pass

---

### Block 4: DDL Generation Update — 30min
**Type:** Feature slice
**Dependencies:** Block 3
**Files:**
- `packages/adapter-kysely/src/ddl.ts` — Two-pass generation, indexes

**Exit criteria:**
- [ ] Two-pass DDL: CREATE TABLEs first, ALTER TABLEs for FKs
- [ ] CREATE INDEX statements generated
- [ ] Unique constraint names (fk_{table}_{col}, idx_{table}_{cols})
- [ ] All SC-* scenarios have passing tests

## 7. Test Strategy

### Test pyramid:

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 8 | Validation rules, type conversions |
| Integration | 5 | Schema → ModelIR → DDL pipeline |
| E2E | 2 | Full DDL execution against PostgreSQL |

### Test data requirements:

**Fixtures:**
- Simple schema (users with id, email)
- Complex schema (users, posts, comments with FKs)
- Circular FK schema (A ↔ B)
- Composite PK/index schema

**Mocks:**
- None needed (pure functions)

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Breaking existing tests | M | HIGH | Fix all usages in same PR |
| Type inference complexity | M | LOW | Keep types simple, test strict mode |
| Circular FK ordering | M | LOW | Two-pass DDL already designed |

## 9. Definition of Done

- [ ] All blocks implemented
- [ ] All 13 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration)
- [ ] `pnpm tsc` passes without errors
- [ ] `pnpm biome check` passes
- [ ] Existing tests fixed for new ColumnDef format
- [ ] QUICKSTART.md examples updated
