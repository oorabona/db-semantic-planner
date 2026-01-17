---
doc-meta:
  status: draft
  scope: adapter
  type: design
  created: 2026-01-06
  updated: 2026-01-11
---

# Adapter Scope Overview

## Purpose

The **adapter** scope (`packages/adapter-kysely`) bridges abstract query plans to concrete SQL execution:

1. **Compiler** - Transform PlanReport into SQL + parameters
2. **Engine** - Execute queries via Kysely
3. **Multi-tenant** - Runtime schema switching (`orm.withSchema()`)
4. **Observability** - `dump()` API for debugging

## Architecture Constraint

```
┌─────────────────────────────────────────────────────────────┐
│                  packages/adapter-kysely                    │
│                                                             │
│  Imports from: packages/core (ModelIR, IntentAST, PlanReport)
│  MUST NOT import from: packages/dx                          │
│                                                             │
│  PlanReport → Compiler → SQL + params → Kysely → Results    │
└─────────────────────────────────────────────────────────────┘
```

---

## Public API Contracts

### Dump (Observability Output)

```typescript
/**
 * Complete observability output for any query.
 * Produced by compile() without executing.
 */
interface Dump {
  /** Planner decisions with reasoning */
  plan: PlanReport;

  /** Compiled SQL string (from Kysely CompiledQuery.sql) */
  sql: string;

  /** Bound parameters (from Kysely CompiledQuery.parameters) */
  params: readonly unknown[];

  /** Optional metadata for correlation */
  meta?: DumpMeta;
}

interface DumpMeta {
  /** Tenant schema if multi-tenant */
  tenant?: string;

  /** Optional query label for logging */
  queryName?: string;

  /** Correlation ID for distributed tracing */
  correlationId?: string;

  /** Timestamp when compiled */
  compiledAt?: Date;
}
```

### ORM Context API

```typescript
interface OrmContext {
  /**
   * Create a tenant-scoped context.
   * Under the hood: Kysely db.withSchema(schemaName)
   */
  withSchema(schemaName: string): TenantOrmContext;

  /**
   * Start a query on a model.
   */
  query<T>(model: Model<T>): QueryBuilder<T>;

  /**
   * Access raw Kysely instance (escape hatch).
   */
  readonly kysely: Kysely<any>;
}

interface TenantOrmContext extends OrmContext {
  /** Current tenant schema */
  readonly tenant: string;
}
```

### QueryBuilder API

```typescript
interface QueryBuilder<T> {
  select(fields: (keyof T)[]): this;
  where(condition: WhereIntent): this;
  include(relation: string, options?: IncludeOptions): this;
  orderBy(field: keyof T, direction?: 'asc' | 'desc'): this;
  limit(n: number): this;
  offset(n: number): this;

  /**
   * Compile without executing - returns Dump.
   * Uses Kysely .compile() internally.
   */
  compile(): Dump;

  /**
   * Alias for compile() with better semantics.
   */
  dump(): Dump;

  /**
   * Execute and return results.
   */
  execute(): Promise<T[]>;

  /**
   * Execute and return first result or undefined.
   */
  findFirst(): Promise<T | undefined>;

  /**
   * Execute and return first result or throw.
   */
  findFirstOrThrow(): Promise<T>;

  /**
   * Execute and return all results.
   */
  findMany(): Promise<T[]>;
}
```

---

## Multi-tenant API

**Chosen pattern:** `orm.withSchema(schemaName)`

```typescript
// Create ORM instance
const orm = createOrm({ kysely: db, model: schema });

// Get tenant-scoped context
const tenantOrm = orm.withSchema('tenant_acme');

// All queries use that schema
const users = await tenantOrm.query(User).findMany();
// SQL: SELECT * FROM "tenant_acme"."users"

// Compile to inspect
const dump = tenantOrm.query(User).where(eq('active', true)).dump();
console.log(dump.sql);    // SELECT * FROM "tenant_acme"."users" WHERE "active" = $1
console.log(dump.params); // [true]
console.log(dump.meta?.schema); // 'tenant_acme'
```

### Security Requirements

**Schema name validation (MANDATORY):**

```typescript
// Allow-list pattern for identifiers
const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateSchemaName(name: string): void {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new InvalidIdentifierError(`Invalid schema name: ${name}`);
  }
  if (name.length > 63) { // PostgreSQL limit
    throw new InvalidIdentifierError(`Schema name too long: ${name}`);
  }
}
```

**Never** concatenate raw schema names into SQL. Always use Kysely's `.withSchema()`.

---

## Observability: dump() Semantics

### What dump() Returns

| Field | Source | Purpose |
|-------|--------|---------|
| `plan` | Semantic Planner | Decisions + reasoning + warnings |
| `sql` | Kysely `CompiledQuery.sql` | Exact SQL that would execute |
| `params` | Kysely `CompiledQuery.parameters` | Bound parameter values |
| `meta.schema` | withSchema() context | Schema name if multi-tenant |
| `meta.queryName` | User-provided | Labeling for logs |
| `meta.correlationId` | User-provided | Distributed tracing |

### Deterministic Output Rules

1. **Stable SQL**: Same intent → same SQL string (reproducible)
2. **Consistent aliasing**: Table aliases follow pattern `t0`, `t1`, `t2`...
3. **Ordered params**: Parameters in SQL order ($1, $2, $3...)
4. **Reproducible plan**: Decisions ordered by processing sequence

### explain() API (Implemented)

```typescript
interface QueryBuilder<T> {
  // ... existing methods ...

  /**
   * Run EXPLAIN ANALYZE and return execution plan.
   * Requires database connection.
   */
  explain(options?: { analyze?: boolean; format?: 'text' | 'json' }): Promise<ExplainResult>;
}

interface ExplainResult {
  plan: string;         // Raw EXPLAIN output
  executionTime?: number;
  rowsReturned?: number;
}
```

**Status:** ✅ Implemented in ADAPTER-004 (Enhanced Observability)

---

## Dialect Capabilities (Implemented)

### Status

Multi-dialect support is implemented via capability checks (DIALECT-001, CORE-004).
PostgreSQL remains the primary tested dialect.

### Capabilities Matrix (Draft)

| Capability | PostgreSQL | MySQL 8+ | SQLite 3.35+ | MSSQL | MVP Required |
|------------|------------|----------|--------------|-------|--------------|
| `supportsCTE` | Yes | Yes | Yes | Yes | Yes |
| `supportsExplain` | Yes | Yes | Yes | Yes | Yes (implemented) |
| `supportsWithSchema` | Yes | No* | No | Yes | Yes |
| `supportsLateralJson` | Yes | No | No | No | No |
| `supportsTransactionalDdl` | Yes | No | No | Yes | No |
| `supportsReturning` | Yes | No | No | Yes | No |
| `supportsNullsFirstLast` | Yes | 8.0+ | 3.30+ | Yes | No |

\* MySQL uses database switching, not schema

### Capability Interface

```typescript
interface DialectCapabilities {
  supportsCTE: boolean;
  supportsExplain: boolean;
  supportsWithSchema: boolean;
  supportsLateralJson: boolean;
  supportsTransactionalDdl: boolean;
  supportsReturning: boolean;
  supportsNullsFirstLast: boolean;

  // Future additions...
}

// Planner strategies gated by capabilities
function selectStrategy(caps: DialectCapabilities): Strategy {
  if (caps.supportsLateralJson) {
    return 'lateral-json-agg';
  }
  return 'separate-queries';
}
```

---

## Golden Query Tests (SQL Snapshots)

Adapter must compile these intents to exact SQL:

### Q1: Filter to-many → EXISTS

```typescript
// Intent
const dump = orm.query(Product)
  .where(exists('images', {
    where: and(
      eq('locale', 'FR'),
      eq('type', 'main'),
      eq('approved', true)
    )
  }))
  .dump();
```

**Expected SQL (PostgreSQL):**

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

**Expected params:** `['FR', 'main', true]`

### Q2: Coverage by category → CTE + ratio

```typescript
// Intent
const dump = orm.query(Category)
  .select(['id', 'name'])
  .withComputed('coverage', ratio(
    countDistinct('products.id', { where: eq('products.active', true) }),
    countDistinct('products.id')
  ))
  .dump();
```

**Expected SQL (PostgreSQL):**

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

**Expected params:** `[true]`

### Q4: Multi-tenant schema-per-tenant

```typescript
// Intent
const dump = orm.withSchema('acme').query(User)
  .where(eq('active', true))
  .dump();
```

**Expected SQL (PostgreSQL):**

```sql
SELECT "t0".*
FROM "acme"."users" AS "t0"
WHERE "t0"."active" = $1
```

**Expected params:** `[true]`
**Expected meta.schema:** `'acme'`

---

## Out of Scope

- **No multi-dialect correctness guarantee**: PostgreSQL is primary target
- **No cost-based optimization**: Heuristics only
- **No connection pool management**: Deferred to Kysely
- **No migrations**: Schema assumed to exist
- **No change tracking**: Read-focused API

**Implemented features (previously planned):**
- ✅ **Streaming/cursor support**: `stream()` method with AsyncIterator (STREAMING-001)
- ✅ **EXPLAIN/ANALYZE**: `explain()` method (ADAPTER-004)
- ✅ **Multi-dialect capabilities**: Dialect detection with capability checks (DIALECT-001)

---

## Kysely Plugin Gotcha

If implementing Kysely plugins that pass state between `transformQuery` and `transformResult`:

```typescript
// BAD: Memory leak risk
const stateMap = new Map<string, State>();

// GOOD: Use WeakMap keyed by query object
const stateMap = new WeakMap<object, State>();

// In plugin:
transformQuery(args) {
  const queryId = args.queryId; // or use args.node as key
  stateMap.set(queryId, { ... });
}

transformResult(args) {
  const state = stateMap.get(args.queryId);
  // Note: transformResult may not be called (cancelled query)
}
```

**Why:** `transformQuery` may be called without matching `transformResult` (query cancelled, error thrown). Using `WeakMap` prevents memory leaks.

---

## Dependencies

- `packages/core` (ModelIR, IntentAST, PlanReport)
- `kysely` (peer dependency)

## Dependents

- `packages/dx` imports adapter for execution

## Implementation Specs

- [ADAPTER-001-kysely-dump-compile-execute.md](../specs/ADAPTER-001-kysely-dump-compile-execute.md) - Compile/dump/execute specification
- ADAPTER-002-multi-tenant.md (planned)
