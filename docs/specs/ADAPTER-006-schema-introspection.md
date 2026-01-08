---
doc-meta:
  status: canonical
  scope: adapter
  type: specification
  created: 2026-01-08
  updated: 2026-01-08
---

# Specification: ADAPTER-006 Schema Introspection

## 1. User Stories

### US-001: Zero-Config Schema Discovery

```
AS A developer using db-semantic-planner
I WANT to auto-generate ModelIR from my existing database
SO THAT I don't have to manually duplicate schema definitions
```

**ACCEPTANCE:** `introspect(db)` returns complete ModelIR matching database structure.

### US-002: Automatic Relation Inference

```
AS A developer with an existing database
I WANT relations to be inferred from foreign keys
SO THAT I can query with includes() without manual configuration
```

**ACCEPTANCE:** FK constraints are converted to bidirectional relations (belongsTo + hasMany).

### US-003: Hierarchy Pattern Detection

```
AS A developer building hierarchical data applications
I WANT automatic detection of adjacency/edge-table patterns
SO THAT I can use RecursiveQueryBuilder without manual configuration
```

**ACCEPTANCE:** Self-referential FK detected as adjacency; table with 2 FKs to same target detected as edge-table.

---

## 2. Business Rules

### Invariants

| Rule | Description |
|------|-------------|
| INV-001 | Introspection is read-only (no schema modifications) |
| INV-002 | Output ModelIR is valid (passes validateModelIR) |
| INV-003 | defineSchema() continues to work unchanged |

### Relation Inference Rules

| FK Pattern | Inferred Relations |
|------------|-------------------|
| `A.b_id → B.id` | `A belongsTo B` + `B hasMany A` |
| `A.parent_id → A.id` | `A belongsTo A (parent)` + `A hasMany A (children)` + `hierarchy: adjacency` |
| `Edge(a_id, b_id) → T.id` | `hierarchy: edge-table` with nodeTable=T, edgeTable=Edge |

### Hierarchy Detection Algorithm

```
FOR each table T:
  IF T has self-referential FK (T.col → T.pk):
    Mark as ADJACENCY hierarchy candidate

FOR each table E:
  IF E has exactly 2 FKs to same target table T:
    Mark as EDGE-TABLE hierarchy
    E is edge table, T is node table
    FK1 column = parent reference
    FK2 column = child reference
```

### Preconditions

| Rule | Description |
|------|-------------|
| PRE-001 | Kysely instance must be connected |
| PRE-002 | Database must have introspection support (PostgreSQL, MySQL, SQLite) |

### Effects

| Rule | Description |
|------|-------------|
| EFF-001 | `introspect(db)` returns ModelIR |
| EFF-002 | `introspect(db, options)` applies filtering |
| EFF-003 | Hierarchy metadata attached to relevant relations |

---

## 3. Technical Impact

### Adapter Package (packages/adapter-kysely)

**New files:**

| File | Purpose |
|------|---------|
| `introspection.ts` | Main `introspect()` function |
| `introspection.test.ts` | Unit tests |

**New types:**

```typescript
/** Options for database introspection */
export interface IntrospectionOptions {
  /** Tables to exclude (glob patterns supported) */
  readonly exclude?: readonly string[];

  /** Tables to include (default: all) */
  readonly include?: readonly string[];

  /** Schema name to introspect (default: public/dbo) */
  readonly schema?: string;

  /** Naming convention for relation names */
  readonly relationNaming?: 'camelCase' | 'snake_case';
}

/** Hierarchy pattern detected during introspection */
export interface DetectedHierarchy {
  readonly type: 'adjacency' | 'edge-table';
  readonly nodeTable: string;
  readonly edgeTable?: string;      // Only for edge-table
  readonly parentColumn: string;
  readonly childColumn?: string;    // Only for edge-table
  readonly nodeIdColumn: string;
}

/** Extended ModelIR with hierarchy metadata */
export interface IntrospectedModelIR extends ModelIR {
  readonly hierarchies: readonly DetectedHierarchy[];
  readonly introspectedAt: Date;
  readonly warnings: readonly string[];
}
```

**Exports:**

```typescript
// packages/adapter-kysely/src/index.ts
export { introspect } from './introspection.js';
export type {
  IntrospectionOptions,
  DetectedHierarchy,
  IntrospectedModelIR
} from './introspection.js';
```

### Core Package (packages/core)

**No changes required.** `defineSchema()` remains the programmatic API.

---

## 4. API Design

### 4.1 Basic Usage

```typescript
import { Kysely, PostgresDialect } from 'kysely';
import { introspect } from '@db-semantic-planner/adapter-kysely';
import { createPlanner } from '@db-semantic-planner/core';

// Connect to database
const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool })
});

// Introspect schema (zero config)
const model = await introspect(db);

// Use with planner
const planner = createPlanner(model);
```

### 4.2 With Options

```typescript
const model = await introspect(db, {
  exclude: ['_migrations', '_prisma*', 'pg_*'],
  schema: 'public',
  relationNaming: 'camelCase'
});
```

### 4.3 Accessing Hierarchy Metadata

```typescript
const model = await introspect(db);

// Check for adjacency hierarchies
const adjacencyTables = model.hierarchies
  .filter(h => h.type === 'adjacency')
  .map(h => h.nodeTable);

// Check for edge-table hierarchies
const edgeTables = model.hierarchies
  .filter(h => h.type === 'edge-table')
  .map(h => ({ node: h.nodeTable, edge: h.edgeTable }));
```

### 4.4 Dual Mode: Introspect OR Define

```typescript
// Option A: Introspect from existing DB
const model = await introspect(db);

// Option B: Define programmatically (unchanged API)
const model = defineSchema({
  tables: [...],
  relations: [...]
});

// Both produce valid ModelIR for planner
const planner = createPlanner(model);
```

---

## 5. Acceptance Criteria (BDD Scenarios)

### Scenario 1: Basic Table Introspection

```gherkin
Scenario: Introspect tables with columns and primary keys
  Given a PostgreSQL database with:
    | Table | Columns | PK |
    | users | id, name, email | id |
    | posts | id, title, author_id | id |
  When I call introspect(db)
  Then ModelIR contains 2 tables
  And users table has columns [id, name, email]
  And users table has primaryKey "id"
```

### Scenario 2: Foreign Key to Relation

```gherkin
Scenario: FK constraint becomes bidirectional relations
  Given posts.author_id references users.id
  When I call introspect(db)
  Then relations include:
    | name | type | source | target |
    | author | belongsTo | posts | users |
    | posts | hasMany | users | posts |
```

### Scenario 3: Adjacency Hierarchy Detection

```gherkin
Scenario: Self-referential FK detected as adjacency pattern
  Given categories table with:
    | Column | FK |
    | id | - |
    | name | - |
    | parent_id | categories.id |
  When I call introspect(db)
  Then hierarchies include:
    | type | nodeTable | parentColumn |
    | adjacency | categories | parent_id |
```

### Scenario 4: Edge-Table Hierarchy Detection

```gherkin
Scenario: Junction table with 2 FKs to same table detected
  Given role_edges table with:
    | Column | FK |
    | id | - |
    | parent_role_id | roles.id |
    | child_role_id | roles.id |
  When I call introspect(db)
  Then hierarchies include:
    | type | nodeTable | edgeTable | parentColumn | childColumn |
    | edge-table | roles | role_edges | parent_role_id | child_role_id |
```

### Scenario 5: Exclude Tables

```gherkin
Scenario: Excluded tables not in ModelIR
  Given database has tables [users, posts, _migrations]
  When I call introspect(db, { exclude: ['_migrations'] })
  Then ModelIR has 2 tables
  And _migrations is not included
```

### Scenario 6: defineSchema Still Works

```gherkin
Scenario: Programmatic schema definition unchanged
  Given defineSchema({ tables: [...], relations: [...] })
  When used with createPlanner()
  Then behavior is identical to before ADAPTER-005
```

---

## 6. Implementation Plan (Vertical Slices)

### Block 1: Core Introspection (M)

**Package:** `packages/adapter-kysely`

- Create `introspection.ts` with `introspect()` function
- Call `db.introspection.getTables()` to get TableMetadata[]
- Map TableMetadata to TableIR (name, columns, primaryKey)
- Extract ForeignKeyIR from column constraints
- Add `IntrospectionOptions` type with exclude/include
- Return `IntrospectedModelIR`

**Tests:** 8 unit tests (basic introspection, columns, PKs, filtering)
**Acceptance criteria covered:** #1, #5

### Block 2: Relation Inference (M)

**Package:** `packages/adapter-kysely`

- For each FK: create belongsTo relation (FK owner → FK target)
- For each FK: create hasMany relation (FK target → FK owner)
- Handle naming conventions (author_id → author, user_id → user)
- Support composite FKs

**Tests:** 8 unit tests (relation inference, naming, composite)
**Acceptance criteria covered:** #2

### Block 3: Hierarchy Detection (M)

**Package:** `packages/adapter-kysely`

- Detect self-referential FKs → adjacency pattern
- Detect tables with 2+ FKs to same target → edge-table pattern
- Populate `hierarchies` array in IntrospectedModelIR
- Add hierarchy metadata to relevant relations

**Tests:** 8 unit tests (adjacency, edge-table, edge cases)
**Acceptance criteria covered:** #3, #4

### Block 4: Integration & Export (S)

**Package:** `packages/adapter-kysely`

- Export from index.ts
- Add regression test for defineSchema()
- Documentation strings

**Tests:** 4 unit tests (export, regression, types)
**Acceptance criteria covered:** #6

---

## 7. Test Strategy

### Unit Tests (packages/adapter-kysely)

| Area | Tests | Coverage |
|------|-------|----------|
| Table introspection | 4 | Tables, columns, PKs |
| Filtering | 4 | Include, exclude, patterns |
| Relation inference | 6 | belongsTo, hasMany, naming |
| Composite keys | 2 | Composite PK, composite FK |
| Adjacency detection | 4 | Self-ref FK, parent column |
| Edge-table detection | 4 | 2 FKs to same table |
| Edge cases | 4 | Empty DB, no PK, circular |
| **Total** | **~28** | |

### Integration Tests

| Scenario | Coverage |
|----------|----------|
| Introspect → Planner → Query | Full pipeline |
| RecursiveQueryBuilder with detected hierarchy | Hierarchy usability |

---

## 8. Definition of Done

- [ ] All blocks implemented
- [ ] All BDD scenarios have passing tests
- [ ] 28+ unit tests passing
- [ ] TypeScript strict mode passes
- [ ] Biome lint passes
- [ ] Exported from `@db-semantic-planner/adapter-kysely`
- [ ] defineSchema() regression tests pass

---

## 9. Dependencies

| Block | Depends On |
|-------|------------|
| Block 2 | Block 1 |
| Block 3 | Block 1 |
| Block 4 | Block 1, 2, 3 |

---

## 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Kysely introspection API varies by dialect | Multi-dialect support | Focus on PostgreSQL MVP, test adapter pattern |
| Complex naming conventions | Ambiguous relation names | Provide `relationNaming` option |
| Performance on large schemas | Slow startup | Cache introspection result |

---

## 11. Example: Before vs After

### Before (Manual Schema Definition)

```typescript
// 50+ lines of manual definition 😱
const model = defineSchema({
  tables: [
    {
      name: 'users',
      columns: [
        { name: 'id', type: 'uuid' },
        { name: 'name', type: 'text' },
        { name: 'email', type: 'text' },
      ],
      primaryKey: 'id',
      foreignKeys: []
    },
    {
      name: 'posts',
      columns: [...],
      primaryKey: 'id',
      foreignKeys: [
        { columns: ['author_id'], references: { table: 'users', columns: ['id'] } }
      ]
    },
    // ... more tables
  ],
  relations: [
    { name: 'author', type: 'belongsTo', source: 'posts', target: 'users', ... },
    { name: 'posts', type: 'hasMany', source: 'users', target: 'posts', ... },
    // ... more relations
  ]
});
```

### After (Zero-Config Introspection)

```typescript
// 1 line! ✨
const model = await introspect(db);

// Hierarchies auto-detected
console.log(model.hierarchies);
// [{ type: 'adjacency', nodeTable: 'categories', parentColumn: 'parent_id' }]
```
