---
doc-meta:
  status: canonical
  scope: adapter
  type: specification
  created: 2026-01-06
  updated: 2026-01-07
---

# ADAPTER-001: Kysely Dump/Compile/Execute Specification

## Overview

This spec defines the compile, dump, and execute APIs for the Kysely adapter. These APIs provide full observability into query planning and compilation, enabling debugging, testing, and logging.

**Package:** `packages/adapter-kysely`
**Depends on:** `packages/core` (ModelIR, IntentAST, PlanReport)
**Enables:** Q1, Q2, Q4 golden tests (SQL snapshot validation)

---

## Public API Signatures

### Type Definitions

```typescript
// packages/adapter-kysely/src/dump.ts

import type { PlanReport } from '@db-semantic-planner/core';

/**
 * Metadata for correlation and debugging
 */
export interface DumpMeta {
  /** Tenant schema name (if multi-tenant) */
  tenant?: string;

  /** User-provided query label */
  queryName?: string;

  /** Correlation ID for distributed tracing */
  correlationId?: string;

  /** When the query was compiled */
  compiledAt?: Date;
}

/**
 * Complete observability output for any query.
 * Produced by compile()/dump() without executing.
 */
export interface Dump {
  /**
   * Planner decisions with reasoning.
   * From @db-semantic-planner/core Semantic Planner.
   */
  plan: PlanReport;

  /**
   * Compiled SQL string.
   * Source: Kysely CompiledQuery.sql
   */
  sql: string;

  /**
   * Bound parameter values.
   * Source: Kysely CompiledQuery.parameters
   * Order matches $1, $2, $3... in SQL.
   */
  params: readonly unknown[];

  /**
   * Optional metadata for logging/tracing.
   */
  meta?: DumpMeta;
}
```

### ORM Context API

```typescript
// packages/adapter-kysely/src/orm-context.ts

import type { Kysely } from 'kysely';
import type { ModelIR } from '@db-semantic-planner/core';

/**
 * Options for creating an ORM context
 */
export interface CreateOrmOptions {
  /** Kysely instance (must be connected) */
  kysely: Kysely<any>;

  /** Model schema definition */
  model: ModelIR;

  /** Enable strict mode for ambiguity detection (default: false) */
  strictMode?: boolean;
}

/**
 * Main ORM context (public schema / no tenant)
 */
export interface OrmContext {
  /**
   * Create a tenant-scoped context.
   * Uses Kysely db.withSchema(schemaName) internally.
   *
   * @throws InvalidIdentifierError if schemaName is invalid
   */
  forTenant(schemaName: string): TenantOrmContext;

  /**
   * Start a query on a model.
   */
  query<T>(model: ModelRef<T>): QueryBuilder<T>;

  /**
   * Access raw Kysely instance (escape hatch).
   */
  readonly kysely: Kysely<any>;

  /**
   * Access model schema.
   */
  readonly model: ModelIR;
}

/**
 * Tenant-scoped ORM context
 */
export interface TenantOrmContext extends OrmContext {
  /** Current tenant schema name */
  readonly tenant: string;
}

/**
 * Create the ORM context
 */
export function createOrm(options: CreateOrmOptions): OrmContext;
```

### QueryBuilder API

```typescript
// packages/adapter-kysely/src/query-builder.ts

import type { Dump, DumpMeta } from './dump';
import type { WhereIntent, IncludeOptions, OrderByIntent } from '@db-semantic-planner/core';

/**
 * Fluent query builder with compile/dump/execute methods
 */
export interface QueryBuilder<T> {
  /**
   * Select specific fields (default: all)
   */
  select<K extends keyof T>(fields: K[]): QueryBuilder<Pick<T, K>>;

  /**
   * Add filter conditions
   */
  where(condition: WhereIntent): QueryBuilder<T>;

  /**
   * Include related data
   */
  include(relation: string, options?: IncludeOptions): QueryBuilder<T>;

  /**
   * Add ordering
   */
  orderBy<K extends keyof T>(
    field: K,
    direction?: 'asc' | 'desc'
  ): QueryBuilder<T>;

  /**
   * Limit results
   */
  limit(n: number): QueryBuilder<T>;

  /**
   * Offset results
   */
  offset(n: number): QueryBuilder<T>;

  /**
   * Set query metadata for dump output
   */
  withMeta(meta: Partial<DumpMeta>): QueryBuilder<T>;

  // --- Observability Methods ---

  /**
   * Compile without executing.
   * Returns full Dump with plan, sql, params.
   * Uses Kysely .compile() internally.
   */
  compile(): Dump;

  /**
   * Alias for compile() with clearer intent.
   */
  dump(): Dump;

  // --- Execution Methods ---

  /**
   * Execute and return all results.
   */
  execute(): Promise<T[]>;

  /**
   * Execute and return first result or undefined.
   */
  findFirst(): Promise<T | undefined>;

  /**
   * Execute and return first result or throw.
   * @throws NotFoundError if no results
   */
  findFirstOrThrow(): Promise<T>;

  /**
   * Execute and return all results.
   * Alias for execute().
   */
  findMany(): Promise<T[]>;
}
```

---

## Deterministic Output Rules

### SQL Generation

1. **Stable SQL**: Same QueryIntent → same SQL string (byte-for-byte identical)
2. **Consistent aliasing**: Tables use `t0`, `t1`, `t2`... in order of appearance
3. **Quoted identifiers**: All identifiers double-quoted (`"table"`, `"column"`)
4. **Parameter ordering**: Parameters numbered in SQL order (`$1`, `$2`, `$3`...)

### Aliasing Convention

```
Root table:     t0
First join:     t1
Second join:    t2
CTE alias 1:    cte0 (or semantic name like "products_base")
CTE alias 2:    cte1 (or semantic name like "products_active")
```

### Explicit Aliasing Control (Implementation Note)

**Critical:** The compiler MUST explicitly set table aliases using Kysely's `.as()` method to guarantee deterministic output:

```typescript
// CORRECT: Explicit alias control
db.selectFrom('products')
  .as('t0')  // Explicit alias
  .innerJoin('categories', 'categories.id', 't0.categoryId')
  .as('t1')  // Explicit alias

// WRONG: Let Kysely auto-generate aliases
db.selectFrom('products')
  .innerJoin('categories', 'categories.id', 'products.categoryId')
// Kysely may use internal alias generation that varies
```

**Why:** Kysely's internal alias generation is not guaranteed to be deterministic across versions. By explicitly setting aliases, we control the output and enable:
- SQL snapshot testing (byte-for-byte comparison)
- Reproducible debugging (same SQL every time)
- Simpler CTE reference (known alias names)

### Example Deterministic Output

```typescript
// Input (same every time)
const dump1 = orm.query(Product).where(eq('active', true)).dump();
const dump2 = orm.query(Product).where(eq('active', true)).dump();

// Output (identical every time)
expect(dump1.sql).toBe(dump2.sql);
expect(dump1.params).toEqual(dump2.params);
expect(dump1.plan.decisions).toEqual(dump2.plan.decisions);
```

---

## Kysely Integration

### compile() Implementation

```typescript
// Pseudocode for compile()
class QueryBuilderImpl<T> implements QueryBuilder<T> {
  compile(): Dump {
    // 1. Convert QueryBuilder state to IntentAST
    const intent = this.toIntent();

    // 2. Run through semantic planner (from core)
    const planReport = this.planner.plan(intent, this.model);

    // 3. Build Kysely query from plan
    const kyselyQuery = this.compiler.toKysely(planReport, this.kyselyDb);

    // 4. Use Kysely's compile() to get SQL + params
    const compiled = kyselyQuery.compile();

    // 5. Return Dump
    return {
      plan: planReport,
      sql: compiled.sql,
      params: compiled.parameters,
      meta: {
        tenant: this.tenant,
        queryName: this.queryName,
        correlationId: this.correlationId,
        compiledAt: new Date(),
      },
    };
  }
}
```

### Kysely CompiledQuery

Kysely's `.compile()` returns:

```typescript
interface CompiledQuery {
  sql: string;           // e.g., 'SELECT "t0".* FROM "products" AS "t0" WHERE "t0"."active" = $1'
  parameters: unknown[]; // e.g., [true]
  query: unknown;        // Internal node (not used)
}
```

We use `sql` and `parameters` directly in `Dump`.

---

## Multi-tenant Integration

### forTenant() Implementation

```typescript
// Pseudocode for forTenant()
function forTenant(schemaName: string): TenantOrmContext {
  // 1. Validate schema name
  validateSchemaName(schemaName);

  // 2. Create tenant-scoped Kysely instance
  const tenantKysely = this.kysely.withSchema(schemaName);

  // 3. Return new context with tenant
  return new TenantOrmContextImpl({
    kysely: tenantKysely,
    model: this.model,
    tenant: schemaName,
  });
}

// Validation
const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateSchemaName(name: string): void {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new InvalidIdentifierError(`Invalid schema name: ${name}`);
  }
  if (name.length > 63) {
    throw new InvalidIdentifierError(`Schema name too long (max 63): ${name}`);
  }
}
```

### Tenant in Dump.meta

```typescript
const dump = orm.forTenant('acme').query(User).dump();

expect(dump.meta?.tenant).toBe('acme');
expect(dump.sql).toContain('"acme"."users"');
```

---

## Acceptance Tests Mapping

### Q1: Filter to-many → EXISTS

```typescript
// Setup
const orm = createOrm({ kysely: db, model: q1Schema });

// Query
const dump = orm.query(Product)
  .where(exists('images', {
    where: and(
      eq('locale', 'FR'),
      eq('type', 'main'),
      eq('approved', true)
    )
  }))
  .dump();

// Assertions
expect(dump.plan.decisions).toContainEqual(
  expect.objectContaining({
    type: 'filter-strategy',
    choice: 'exists',
  })
);

expect(dump.sql).toBe(`SELECT "t0".* FROM "products" AS "t0" WHERE EXISTS (SELECT 1 FROM "product_images" AS "t1" WHERE "t1"."product_id" = "t0"."id" AND "t1"."locale" = $1 AND "t1"."type" = $2 AND "t1"."approved" = $3)`);

expect(dump.params).toEqual(['FR', 'main', true]);
```

### Q2: Coverage by category → CTE + ratio

```typescript
// Setup
const orm = createOrm({ kysely: db, model: q2Schema });

// Query (using hypothetical computed API)
const dump = orm.query(Category)
  .select(['id', 'name'])
  .withComputed('coverage', ratio(
    countDistinct('products.id', { where: eq('products.active', true) }),
    countDistinct('products.id')
  ))
  .dump();

// Assertions
expect(dump.plan.ctes).toHaveLength(2);
expect(dump.plan.ctes[0].name).toBe('products_base');
expect(dump.plan.ctes[1].name).toBe('products_active');

expect(dump.sql).toContain('WITH "products_base" AS');
expect(dump.sql).toContain('COUNT(DISTINCT');
expect(dump.sql).toContain('NULLIF(');

expect(dump.params).toEqual([true]);
```

### Q4: Multi-tenant query

```typescript
// Setup
const orm = createOrm({ kysely: db, model: schema });

// Query with tenant
const dump = orm.forTenant('acme').query(User)
  .where(eq('active', true))
  .dump();

// Assertions
expect(dump.meta?.tenant).toBe('acme');
expect(dump.sql).toBe(`SELECT "t0".* FROM "acme"."users" AS "t0" WHERE "t0"."active" = $1`);
expect(dump.params).toEqual([true]);
```

---

## SQL Snapshot Templates

### Basic SELECT

```sql
SELECT "t0".*
FROM "table_name" AS "t0"
```

### With WHERE

```sql
SELECT "t0".*
FROM "table_name" AS "t0"
WHERE "t0"."column" = $1
```

### With EXISTS (Q1)

```sql
SELECT "t0".*
FROM "products" AS "t0"
WHERE EXISTS (
  SELECT 1 FROM "product_images" AS "t1"
  WHERE "t1"."product_id" = "t0"."id"
    AND "t1"."locale" = $1
    AND "t1"."type" = $2
    AND "t1"."approved" = $3
)
```

### With CTE (Q2)

```sql
WITH "products_base" AS (
  SELECT "category_id", "id"
  FROM "products"
),
"products_active" AS (
  SELECT "category_id", "id"
  FROM "products"
  WHERE "active" = $1
)
SELECT
  "t0"."id",
  "t0"."name",
  COALESCE(
    CAST(COUNT(DISTINCT "pa"."id") AS FLOAT) /
    NULLIF(COUNT(DISTINCT "pb"."id"), 0),
    0
  ) AS "coverage"
FROM "categories" AS "t0"
LEFT JOIN "products_base" AS "pb" ON "pb"."category_id" = "t0"."id"
LEFT JOIN "products_active" AS "pa" ON "pa"."category_id" = "t0"."id"
GROUP BY "t0"."id", "t0"."name"
```

### With Schema (Multi-tenant)

```sql
SELECT "t0".*
FROM "schema_name"."table_name" AS "t0"
WHERE "t0"."column" = $1
```

---

## Error Types

```typescript
// packages/adapter-kysely/src/errors.ts

/**
 * Thrown when schema name fails validation
 */
export class InvalidIdentifierError extends Error {
  constructor(public readonly identifier: string) {
    super(`Invalid identifier: ${identifier}`);
    this.name = 'InvalidIdentifierError';
  }
}

/**
 * Thrown by findFirstOrThrow when no results
 */
export class NotFoundError extends Error {
  constructor(public readonly table: string) {
    super(`No record found in ${table}`);
    this.name = 'NotFoundError';
  }
}
```

---

## Implementation Notes

### Thread Safety

`Dump` objects are immutable and can be safely logged, cached, or passed between contexts.

### Memory

`compile()`/`dump()` do not retain database connections. The Kysely query builder is ephemeral.

### Performance

`compile()` should be fast (no DB round-trip). Expensive work (type checking, validation) happens at ORM creation time, not query time.

---

## File Structure

```
packages/adapter-kysely/src/
├── dump.ts             # Dump, DumpMeta interfaces
├── orm-context.ts      # OrmContext, TenantOrmContext, createOrm
├── query-builder.ts    # QueryBuilder implementation
├── compiler.ts         # PlanReport → Kysely query
├── errors.ts           # InvalidIdentifierError, NotFoundError
└── index.ts            # Public exports
```

---

## Related Specs

- CORE-001-model-ir.md (provides ModelIR for query context)
- CORE-002-intent-ast.md (provides IntentAST for planning)
- CORE-003-planner.md (provides PlanReport for compilation)
- ADAPTER-002-multi-tenant.md (details forTenant implementation)
