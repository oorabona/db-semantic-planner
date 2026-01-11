---
doc-meta:
  status: draft
  scope: core
  type: design
  created: 2026-01-06
  updated: 2026-01-11
---

# Core Scope Overview

## Purpose

The **core** scope (`packages/core`) provides the foundational, **database-agnostic** building blocks:

1. **ModelIR** - Schema/model intermediate representation
2. **IntentAST** - Intent-based query representation
3. **Semantic Planner** - Strategy selection producing `PlanReport`

## Architecture Constraint (STRICT)

```
┌─────────────────────────────────────────────────────────────┐
│                      packages/core                          │
│                                                             │
│  ⚠️  MUST NOT import from adapter-kysely or dx packages     │
│  ⚠️  Zero database-specific code                            │
│                                                             │
│  ModelIR → IntentAST → Planner → PlanReport                 │
└─────────────────────────────────────────────────────────────┘
```

The core package produces abstract plans that adapters compile to SQL.

---

## Public API Contracts

### ModelIR (Schema Intermediate Representation)

```typescript
/** Table definition with columns and relations */
interface TableIR {
  name: string;
  columns: ColumnIR[];
  primaryKey: string | string[];
  foreignKeys: ForeignKeyIR[];
}

interface ColumnIR {
  name: string;
  type: ColumnType; // 'string' | 'number' | 'boolean' | 'date' | 'json' | ...
  nullable: boolean;
  default?: unknown;
}

interface ForeignKeyIR {
  columns: string[];
  references: { table: string; columns: string[] };
  onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
}

/** Relation metadata for planning decisions */
interface RelationIR {
  name: string;
  type: 'hasOne' | 'hasMany' | 'belongsTo' | 'belongsToMany';
  source: string;        // Source table
  target: string;        // Target table
  through?: string;      // Junction table for M:N

  // Planning hints (affect strategy selection)
  cardinality: 'one' | 'many';
  optionality: 'required' | 'optional';

  // Default strategies (can be overridden per-query)
  includeStrategy: 'join' | 'separate' | 'auto';  // How to fetch when included
  filterStrategy: 'exists' | 'join' | 'auto';     // How to filter by relation
  joinDefault: 'left' | 'inner' | 'auto';         // Join type when joining
}

/** Complete model IR */
interface ModelIR {
  tables: Map<string, TableIR>;
  relations: Map<string, RelationIR>;

  // Helpers
  getTable(name: string): TableIR | undefined;
  getRelation(name: string): RelationIR | undefined;
  getRelationsFrom(table: string): RelationIR[];
  getRelationsTo(table: string): RelationIR[];
}
```

### IntentAST (Query Intent)

```typescript
/** Root query intent */
interface QueryIntent {
  type: 'select';
  from: string;                    // Root table
  select: SelectIntent;            // What to fetch
  where?: WhereIntent;             // Filters
  include?: IncludeIntent[];       // Related data
  orderBy?: OrderByIntent[];
  limit?: number;
  offset?: number;
}

interface SelectIntent {
  type: 'all' | 'fields';
  fields?: string[];               // If type === 'fields'
}

interface IncludeIntent {
  relation: string;                // Relation name
  select?: SelectIntent;
  where?: WhereIntent;
  include?: IncludeIntent[];       // Nested includes
  via?: string;                    // Disambiguation (which relation path)
}

/** Filter expressions */
type WhereIntent =
  | { type: 'eq'; field: string; value: unknown }
  | { type: 'neq'; field: string; value: unknown }
  | { type: 'gt' | 'gte' | 'lt' | 'lte'; field: string; value: unknown }
  | { type: 'like'; field: string; pattern: string }
  | { type: 'in'; field: string; values: unknown[] }
  | { type: 'isNull'; field: string }
  | { type: 'isNotNull'; field: string }
  | { type: 'and'; conditions: WhereIntent[] }
  | { type: 'or'; conditions: WhereIntent[] }
  | { type: 'not'; condition: WhereIntent }
  | { type: 'exists'; relation: string; where?: WhereIntent }  // Key for Q1
  | { type: 'relationFilter'; relation: string; where: WhereIntent };

interface OrderByIntent {
  field: string;
  direction: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}
```

### PlanReport (Planner Output)

```typescript
/** Planner decisions with reasoning */
interface PlanReport {
  rootTable: string;
  decisions: PlanDecision[];
  warnings: PlanWarning[];
  ctes: CTEDefinition[];           // For Q2 (ratio/coverage)
}

interface PlanDecision {
  id: string;                      // Unique decision ID
  type: 'join-type' | 'filter-strategy' | 'include-strategy' | 'cte-extraction';
  context: string;                 // What triggered decision
  choice: string;                  // What was chosen
  reasoning: string;               // Why (for debugging)
  alternatives?: string[];         // What else could have been chosen
}

interface PlanWarning {
  code: string;                    // e.g., 'ROW_EXPLOSION_RISK'
  message: string;
  suggestion?: string;
}

interface CTEDefinition {
  name: string;                    // CTE alias
  purpose: string;                 // Why extracted
  referencedBy: string[];          // Which parts use it
}
```

---

## Key Features

### Schema Definition (ModelIR)

- Thenable builder pattern for schema construction
- Type-safe relation definitions with planning metadata:
  - `hasOne` / `belongsTo` (cardinality: 'one')
  - `hasMany` (cardinality: 'many')
  - `belongsToMany` (M:N with junction)
- Column typing with TypeScript inference
- Planning hints per-relation (includeStrategy, filterStrategy, joinDefault)

### Query AST (IntentAST)

- Declarative query builder API
- Select specific fields or all columns
- Include related entities with nested selection
- Filter expressions including `exists` for relation filtering
- Ordering and pagination intents
- No raw SQL exposure at this layer

### Semantic Planner

Core planning decisions:

| Decision | Strategies | Default |
|----------|------------|---------|
| Filter by to-many | EXISTS vs JOIN | EXISTS (avoids row explosion) |
| Join type | LEFT vs INNER | Inferred from cardinality + filters |
| Complex queries | CTE extraction | When alias reuse needed |
| Include strategy | Join vs Separate queries | Based on cardinality |

**Intent-first philosophy:** The planner decides HOW to fetch based on WHAT you want.

---

## Out of Scope

- **No cost-based optimization**: We use heuristics, not statistics
- **No join reordering**: Relations are processed in declaration order
- **No NL-to-SQL**: No natural language parsing
- **No dialect-specific SQL generation**: Core is database-agnostic (adapters handle SQL compilation)

**Note:** Schema introspection is supported via adapter capabilities (e.g., `adapter.introspect()`) but core itself doesn't contain database drivers.

---

## Golden Query Tests

Core must support planning for these 3 acceptance tests:

### Q1: Filter to-many → EXISTS

Products with main image FR approved:

```typescript
// Intent
query(Product)
  .where(exists('images', {
    where: and(
      eq('locale', 'FR'),
      eq('type', 'main'),
      eq('approved', true)
    )
  }))
  .findMany();
```

**Expected plan decisions:**
- `filter-strategy: exists` (not join, avoids row explosion)
- Warning if `filterStrategy: 'join'` forced on to-many

### Q2: Coverage by category → CTE + ratio

Coverage percentage needing CTE for alias reuse:

```typescript
// Intent
query(Category)
  .select(['id', 'name'])
  .withComputed('coverage', ratio(
    countDistinct('products.id', { where: eq('products.active', true) }),
    countDistinct('products.id')
  ))
  .findMany();
```

**Expected plan decisions:**
- `cte-extraction: products_base` (shared subquery)
- `cte-extraction: products_active` (filtered version)
- Ratio computed from CTE references

### Q3: Strict mode ambiguity (DX scope, but core must support)

Include to-many without override when multiple paths exist:

```typescript
// User has both 'createdPosts' and 'editedPosts' to Post
query(User)
  .include('posts')  // Ambiguous!
  .findMany();
```

**Expected:**
- Planner detects ambiguity
- Returns error with available options: `['createdPosts', 'editedPosts']`
- (Error throwing handled by DX layer; core just reports)

---

## Deterministic Output Rules

1. **Stable ordering**: Decisions in `PlanReport` ordered by processing sequence
2. **Consistent IDs**: Decision IDs derived from context (reproducible)
3. **No randomness**: Same intent + same model = same plan

---

## Target Users

- Developers building applications with complex relational queries
- Teams wanting type-safe, observable database access
- Projects requiring multi-tenant data isolation

## Dependencies

- **valibot** - Runtime schema validation (CORE-005)
- Core MUST NOT import from `adapter-kysely`

**Note:** The dx layer was merged into core in ARCH-001.

## Dependents

- `packages/adapter-kysely` imports core for ModelIR, IntentAST, PlanReport
- `packages/cli` imports core for ORM and schema utilities
- `packages/schema` is a peer (core imports resolved schema types)

## Implementation Specs

- [CORE-001-model-ir.md](../specs/CORE-001-model-ir.md) - ModelIR specification
- CORE-002-intent-ast.md (planned)
- CORE-003-planner.md (planned)
