---
doc-meta:
  status: canonical
  scope: core
  type: specification
  created: 2026-01-06
  updated: 2026-01-07
---

# CORE-001: ModelIR Specification

## Overview

ModelIR (Model Intermediate Representation) is the schema definition format for db-semantic-planner. It represents database tables, columns, and relations with planning metadata that guides the semantic planner.

**Package:** `packages/core`
**Enables:** Q1, Q2, Q3 golden tests (provides schema for all queries)

---

## Public API Signatures

### Type Definitions

```typescript
// packages/core/src/model-ir.ts

/** Column data types supported by the planner */
export type ColumnType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'json'
  | 'uuid'
  | 'bigint';

/** Foreign key delete behavior */
export type OnDeleteAction = 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';

/** Relation types */
export type RelationType = 'hasOne' | 'hasMany' | 'belongsTo' | 'belongsToMany';

/** Cardinality for planning */
export type Cardinality = 'one' | 'many';

/** Optionality for join type inference */
export type Optionality = 'required' | 'optional';

/** Strategy for including related data */
export type IncludeStrategy = 'join' | 'separate' | 'auto';

/** Strategy for filtering by relation */
export type FilterStrategy = 'exists' | 'join' | 'auto';

/** Default join type when joining */
export type JoinDefault = 'left' | 'inner' | 'auto';
```

### Core Interfaces

```typescript
/**
 * Column definition
 */
export interface ColumnIR {
  /** Column name in database */
  name: string;

  /** Data type for TypeScript inference */
  type: ColumnType;

  /** Whether NULL is allowed */
  nullable: boolean;

  /** Default value (optional) */
  default?: unknown;
}

/**
 * Foreign key constraint
 */
export interface ForeignKeyIR {
  /** Local columns that form the FK */
  columns: string[];

  /** Referenced table and columns */
  references: {
    table: string;
    columns: string[];
  };

  /** Delete behavior */
  onDelete?: OnDeleteAction;
}

/**
 * Table definition
 */
export interface TableIR {
  /** Table name in database */
  name: string;

  /** Column definitions */
  columns: ColumnIR[];

  /** Primary key (single column or composite) */
  primaryKey: string | string[];

  /** Foreign key constraints */
  foreignKeys: ForeignKeyIR[];
}

/**
 * Relation definition with planning metadata
 */
export interface RelationIR {
  /** Relation name (used in queries) */
  name: string;

  /** Relation type */
  type: RelationType;

  /** Source table name */
  source: string;

  /** Target table name */
  target: string;

  /** Junction table for M:N relations */
  through?: string;

  /** Foreign key column(s) on the "many" side */
  foreignKey?: string | string[];

  // --- Planning Hints ---

  /** Cardinality affects strategy selection */
  cardinality: Cardinality;

  /** Optionality affects LEFT vs INNER join */
  optionality: Optionality;

  // --- Strategy Defaults (can be overridden per-query) ---

  /**
   * How to fetch related data when included.
   * - 'join': Use JOIN (efficient for to-one)
   * - 'separate': Use separate query (avoids row explosion for to-many)
   * - 'auto': Planner decides based on cardinality
   * @default 'auto'
   */
  includeStrategy: IncludeStrategy;

  /**
   * How to filter by this relation.
   * - 'exists': Use EXISTS subquery (no row multiplication)
   * - 'join': Use JOIN (may cause row explosion on to-many)
   * - 'auto': Planner decides (defaults to EXISTS for to-many)
   * @default 'auto'
   */
  filterStrategy: FilterStrategy;

  /**
   * Default join type when joining.
   * - 'left': LEFT JOIN (keep parent even if no child)
   * - 'inner': INNER JOIN (parent must have child)
   * - 'auto': Inferred from optionality + filters
   * @default 'auto'
   */
  joinDefault: JoinDefault;
}

/**
 * Complete model intermediate representation
 */
export interface ModelIR {
  /** Table definitions indexed by name */
  tables: Map<string, TableIR>;

  /** Relation definitions indexed by "source.name" */
  relations: Map<string, RelationIR>;

  // --- Helper Methods ---

  /** Get table by name */
  getTable(name: string): TableIR | undefined;

  /** Get relation by qualified name "source.relationName" */
  getRelation(qualifiedName: string): RelationIR | undefined;

  /** Get all relations from a source table */
  getRelationsFrom(sourceTable: string): RelationIR[];

  /** Get all relations to a target table */
  getRelationsTo(targetTable: string): RelationIR[];

  /** Check if relation path is ambiguous (multiple relations to same target) */
  isAmbiguous(sourceTable: string, targetTable: string): {
    ambiguous: boolean;
    options: string[];
  };
}
```

### Builder API

```typescript
/**
 * Column definition shorthand: type name string
 */
export type ColumnDef = ColumnType;

/**
 * Table definition: column name → column type
 */
export type TableDef = Record<string, ColumnDef>;

/**
 * Single relation definition (returned by hasOne, hasMany, etc.)
 */
export interface RelationDef {
  type: RelationType;
  target: string;
  foreignKey?: string | string[];
  through?: string;
  hints?: RelationHints;
}

/**
 * Relations definition for a set of tables.
 * Maps table name → relation name → relation definition
 */
export type RelationsDef<T extends Record<string, TableDef>> = {
  [TableName in keyof T]?: Record<string, RelationDef>;
};

/**
 * Reference to a model for type-safe queries.
 * Created from the schema builder result.
 */
export interface ModelRef<T> {
  readonly __modelType: T;
  readonly tableName: string;
}

/**
 * Schema definition builder (thenable pattern)
 */
export interface SchemaBuilder<T extends Record<string, TableDef>> {
  /**
   * Define relations between tables
   */
  relations<R extends RelationsDef<T>>(relations: R): SchemaBuilderWithRelations<T, R>;
}

export interface SchemaBuilderWithRelations<T, R> {
  /**
   * Build the final ModelIR (immutable after this)
   */
  build(): ModelIR;
}

/**
 * Entry point for schema definition
 */
export function defineSchema<T extends Record<string, TableDef>>(
  tables: T
): SchemaBuilder<T>;

// --- Relation Helpers ---

/**
 * Optional hints to override default planner strategies
 */
export interface RelationHints {
  /** Override include strategy: 'join' | 'separate' | 'auto' */
  includeStrategy?: IncludeStrategy;
  /** Override filter strategy: 'exists' | 'join' | 'auto' */
  filterStrategy?: FilterStrategy;
  /** Override join type: 'left' | 'inner' | 'auto' */
  joinDefault?: JoinDefault;
  /** Override optionality: 'required' | 'optional' */
  optionality?: Optionality;
}

export function hasOne(
  target: string,
  options: { foreignKey: string | string[] },
  hints?: RelationHints
): RelationDef;

export function hasMany(
  target: string,
  options: { foreignKey: string | string[] },
  hints?: RelationHints
): RelationDef;

export function belongsTo(
  target: string,
  options: { foreignKey: string | string[] },
  hints?: RelationHints
): RelationDef;

export function belongsToMany(
  target: string,
  options: { through: string; foreignKey?: string; otherKey?: string },
  hints?: RelationHints
): RelationDef;
```

---

## Deterministic Rules

### Relation Naming

Relations are indexed by qualified name: `${sourceTable}.${relationName}`

```typescript
// Example: products.category
const rel = model.getRelation('products.category');
```

### Strategy Inference

When strategy is `'auto'`, planner applies these rules:

| Cardinality | Include Default | Filter Default |
|-------------|-----------------|----------------|
| `'one'` | `'join'` | `'join'` |
| `'many'` | `'separate'` | `'exists'` |

### Join Type Inference

When joinDefault is `'auto'`:

| Optionality | Has Filter on Relation | Join Type |
|-------------|------------------------|-----------|
| `'required'` | Any | `INNER` |
| `'optional'` | No | `LEFT` |
| `'optional'` | Yes | `INNER` |

---

## Minimal Examples

### Basic Schema Definition

```typescript
import { defineSchema, hasOne, hasMany, belongsTo } from '@dbsp/core';

const schema = defineSchema({
  products: {
    id: 'number',
    name: 'string',
    categoryId: 'number',
    active: 'boolean',
  },
  categories: {
    id: 'number',
    name: 'string',
  },
  productImages: {
    id: 'number',
    productId: 'number',
    url: 'string',
    locale: 'string',
    type: 'string',
    approved: 'boolean',
  },
})
.relations({
  products: {
    category: belongsTo('categories', { foreignKey: 'categoryId' }),
    images: hasMany('productImages', { foreignKey: 'productId' }),
  },
  categories: {
    products: hasMany('products', { foreignKey: 'categoryId' }),
  },
  productImages: {
    product: belongsTo('products', { foreignKey: 'productId' }),
  },
})
.build();
```

### Accessing Model Data

```typescript
// Get table
const productsTable = schema.getTable('products');
// { name: 'products', columns: [...], primaryKey: 'id', foreignKeys: [...] }

// Get relation
const imagesRel = schema.getRelation('products.images');
// { name: 'images', type: 'hasMany', source: 'products', target: 'productImages', ... }

// Get all relations from products
const productRelations = schema.getRelationsFrom('products');
// [{ name: 'category', ... }, { name: 'images', ... }]

// Check ambiguity (for Q3)
const ambiguity = schema.isAmbiguous('users', 'posts');
// { ambiguous: true, options: ['createdPosts', 'editedPosts'] }
```

### Custom Strategy Hints

```typescript
const schema = defineSchema({
  users: { id: 'number', name: 'string' },
  posts: {
    id: 'number',
    title: 'string',
    createdById: 'number',
    editedById: 'number',
  },
})
.relations({
  users: {
    // Force JOIN even for to-many (user knows data is small)
    createdPosts: hasMany('posts', { foreignKey: 'createdById' }, {
      filterStrategy: 'join',
      includeStrategy: 'join',
    }),
    editedPosts: hasMany('posts', { foreignKey: 'editedById' }),
  },
})
.build();
```

---

## Acceptance Tests Mapping

| Golden Test | ModelIR Component | Validation |
|-------------|-------------------|------------|
| Q1: EXISTS filter | `RelationIR.filterStrategy` | Planner reads strategy, defaults to EXISTS for hasMany |
| Q2: CTE ratio | `RelationIR` + `getRelationsFrom` | Planner traverses relations for aggregation |
| Q3: Ambiguity | `ModelIR.isAmbiguous()` | Returns options array when multiple relations to same target |

### Q1 Schema Fixture

```typescript
// For Q1: Products with images filtered by locale
const q1Schema = defineSchema({
  products: { id: 'number', name: 'string' },
  productImages: {
    id: 'number',
    productId: 'number',
    locale: 'string',
    type: 'string',
    approved: 'boolean',
  },
})
.relations({
  products: {
    images: hasMany('productImages', { foreignKey: 'productId' }),
    // filterStrategy defaults to 'exists' because cardinality is 'many'
  },
})
.build();
```

### Q2 Schema Fixture

```typescript
// For Q2: Categories with product coverage
const q2Schema = defineSchema({
  categories: { id: 'number', name: 'string' },
  products: {
    id: 'number',
    categoryId: 'number',
    active: 'boolean',
  },
})
.relations({
  categories: {
    products: hasMany('products', { foreignKey: 'categoryId' }),
  },
})
.build();
```

### Q3 Schema Fixture

```typescript
// For Q3: Ambiguous relations
const q3Schema = defineSchema({
  users: { id: 'number', name: 'string' },
  posts: {
    id: 'number',
    title: 'string',
    createdById: 'number',
    editedById: 'number',
  },
})
.relations({
  users: {
    createdPosts: hasMany('posts', { foreignKey: 'createdById' }),
    editedPosts: hasMany('posts', { foreignKey: 'editedById' }),
  },
})
.build();

// Test ambiguity detection
const result = q3Schema.isAmbiguous('users', 'posts');
expect(result.ambiguous).toBe(true);
expect(result.options).toEqual(['createdPosts', 'editedPosts']);
```

---

## Implementation Notes

### Immutability

`ModelIR` is **immutable after `.build()`**:

```typescript
const schema = defineSchema({ ... }).relations({ ... }).build();

// These throw or are no-ops
schema.tables.set('newTable', { ... }); // Error: Cannot modify
```

Use `Object.freeze()` or return read-only proxies.

### Validation

`.build()` validates:

1. All FK references point to existing tables
2. All relation targets exist
3. Circular relations are flagged (warning, not error)
4. Primary keys are defined for all tables

### TypeScript Inference

Type inference is provided **at build time** through the builder pattern, not at runtime from the ModelIR object.

The builder infers:

1. Table names as string literal union
2. Column names per table
3. Relation names per table

```typescript
// Type inference comes from builder generics, not from ModelIR
const tables = {
  users: { id: 'number', name: 'string' },
  posts: { id: 'number', title: 'string', userId: 'number' },
} as const;

const schema = defineSchema(tables)
  .relations({
    users: {
      posts: hasMany('posts', { foreignKey: 'userId' }),
    },
    posts: {
      author: belongsTo('users', { foreignKey: 'userId' }),
    },
  })
  .build();

// Type inference at compile time (from builder generics)
type TableNames = keyof typeof tables; // 'users' | 'posts'
type UserColumns = keyof typeof tables.users; // 'id' | 'name'

// Note: schema.tables is a Map<string, TableIR> at runtime
// Compile-time types come from the builder, not from schema.tables
```

**Important:** `ModelIR.tables` is a `Map<string, TableIR>` at runtime for O(1) lookups. Compile-time type inference comes from the original `tables` definition passed to `defineSchema()`.

---

## File Structure

```
packages/core/src/
├── model-ir.ts         # Interfaces and types
├── schema-builder.ts   # defineSchema, hasOne, hasMany, etc.
├── model-impl.ts       # ModelIR implementation
└── index.ts            # Public exports
```

---

## Related Specs

- CORE-002-intent-ast.md (uses ModelIR for query validation)
- CORE-003-planner.md (uses ModelIR for strategy decisions)
- ADAPTER-001-kysely-dump-compile-execute.md (compiles plans from ModelIR)
