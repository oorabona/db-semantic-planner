# ADR-001: Typed Intents for Advanced Database Features

---
doc-meta:
  status: accepted
  scope: core, adapter, dx
  type: adr
  created: 2026-01-09
  decision-date: 2026-01-09
---

## Status

**ACCEPTED** (2026-01-09)

## Context

### Problem Statement

db-semantic-planner aims to be a **multi-adapter abstraction layer** supporting Kysely, Drizzle, Prisma, and potentially direct database drivers. Advanced PostgreSQL features (Full-Text Search, Range Types, Window Functions) are not natively supported by these ORMs' type-safe APIs:

| Feature | Kysely | Drizzle | Prisma |
|---------|--------|---------|--------|
| **Full-Text Search (tsvector)** | Raw SQL only | Raw SQL only | Partial (`search` op) |
| **Range Types (daterange, etc.)** | Raw SQL only | Raw SQL only | Raw SQL only |
| **Window Functions** | Native API | Native API | Raw SQL only |

### Research Evidence (2026-01-09)

**Kysely** - No FTS support:
```typescript
// Must use raw sql template
.where(sql`to_tsvector('english', ${ref('title')}) @@ to_tsquery(...)`)
```

**Drizzle** - Has FTS guide but 100% raw SQL:
```typescript
// Their "support" is just a sql wrapper
.where(sql`to_tsvector('english', ${posts.title}) @@ to_tsquery(...)`)
```

**Prisma** - Partial FTS, no Range Types:
```typescript
// Native search operator (limited)
where: { body: { search: 'cat | dog' } }
// Advanced FTS → $queryRawTyped required
```

### Constraint: Single Connection Pool

A critical constraint is **connection pool management**. Having separate adapters (e.g., `adapter-kysely` + `adapter-pg`) would create:

- 2 connection pools = 2x database connections
- Cross-pool transactions impossible
- Configuration duplication
- Connection exhaustion risk

## Decision

**We will use Typed Intents that compile to each adapter's raw SQL escape hatch.**

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  packages/core (DB-agnostic)                                    │
│                                                                 │
│  Intent AST                                                     │
│    ├── QueryIntent, WhereIntent, etc.     (existing)            │
│    ├── FTSIntent                          (NEW - typed)         │
│    ├── RangeIntent                        (NEW - typed)         │
│    ├── WindowIntent                       (NEW - typed)         │
│    └── RawIntent                          (existing - escape)   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  packages/adapter-kysely                                        │
│                                                                 │
│  compileFTS(intent: FTSIntent) {                                │
│    // Uses Kysely's sql template (SAME connection pool!)        │
│    return sql`to_tsvector(${config}, ${field})                  │
│               @@ to_tsquery(${config}, ${term})`                │
│  }                                                              │
│                                                                 │
│  compileRange(intent: RangeIntent) { ... }                      │
│  compileWindow(intent: WindowIntent) { ... }                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  packages/adapter-drizzle (future)                              │
│                                                                 │
│  compileFTS(intent: FTSIntent) {                                │
│    // Uses Drizzle's sql template (SAME connection pool!)       │
│    return sql`to_tsvector(...) @@ to_tsquery(...)`              │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  packages/adapter-prisma (future)                               │
│                                                                 │
│  compileFTS(intent: FTSIntent) {                                │
│    // Uses Prisma's $queryRaw (SAME connection pool!)           │
│    return Prisma.sql`to_tsvector(...)`                          │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
```

### Column Reference Type (Type Safety)

**Problem:** Using `field: string` weakens type safety (typos, aliasing issues, "compiles but crashes").

**Solution:** Use a typed `ColumnRef<T>` that carries table/column metadata:

```typescript
// packages/core/src/intent-ast.ts

/**
 * Typed column reference - produced by model builder / QueryBuilder.
 * Carries metadata for proper alias resolution at compile time.
 */
export interface ColumnRef<T = unknown> {
  __brand: 'ColumnRef';
  table: string;
  column: string;
  type?: T;  // Phantom type for inference
}

// DX helper to create typed refs
export function col<T>(table: string, column: string): ColumnRef<T> {
  return { __brand: 'ColumnRef', table, column } as ColumnRef<T>;
}
```

### Intent Type Definitions

```typescript
// packages/core/src/intent-ast.ts

/**
 * Full-Text Search Intent
 *
 * Maps to PostgreSQL tsquery functions:
 * - 'tsquery': to_tsquery() - strict tsquery syntax
 * - 'plain': plainto_tsquery() - simple text, ANDs words
 * - 'phrase': phraseto_tsquery() - phrase search (word proximity)
 * - 'websearch': websearch_to_tsquery() - Google-like syntax
 *
 * @see https://www.postgresql.org/docs/current/textsearch-controls.html
 */
export interface FTSIntent {
  kind: 'fts';
  field: ColumnRef<string>;           // Typed column reference
  query: string;
  config?: string;                    // 'english', 'french', 'simple', etc.
  queryMode?: 'tsquery' | 'plain' | 'phrase' | 'websearch';  // Maps to *_to_tsquery()
  prefix?: boolean;                   // Append :* for prefix matching
  ranking?: {
    enabled: boolean;
    weights?: [number, number, number, number];  // A, B, C, D weights
    normalization?: number;           // ts_rank normalization option
  };
}

/**
 * Range Type Intent
 *
 * PostgreSQL range operators:
 * - && (overlaps): ranges share any points
 * - @> (contains): left contains right
 * - <@ (contained_by): left is contained by right
 * - -|- (adjacent): ranges are adjacent
 * - << (left_of): strictly left of
 * - >> (right_of): strictly right of
 *
 * SECURITY: Range type names are allowlisted union, safe for sql.id()
 *
 * @see https://www.postgresql.org/docs/current/rangetypes.html
 */
export type RangeType = 'daterange' | 'tsrange' | 'tstzrange' | 'int4range' | 'int8range' | 'numrange';
export type RangeOperator = 'overlaps' | 'contains' | 'contained_by' | 'adjacent' | 'left_of' | 'right_of';

export interface RangeIntent {
  kind: 'range';
  field: ColumnRef;                   // Typed column reference
  type: RangeType;                    // Allowlisted - safe for sql.id()
  operator: RangeOperator;            // Allowlisted - safe for sql.raw()
  value: {
    lower: unknown;
    upper: unknown;
    bounds?: '[]' | '[)' | '(]' | '()';  // inclusive/exclusive, default '[)'
  };
}

/**
 * Window Function Intent
 *
 * SECURITY: Function names are allowlisted union, safe for sql.raw()
 *
 * Note: Frame specification deferred to P3+ (not in MVP).
 *
 * @see https://www.postgresql.org/docs/current/tutorial-window.html
 */
export type WindowFunction =
  | 'row_number' | 'rank' | 'dense_rank' | 'ntile'
  | 'sum' | 'avg' | 'count' | 'min' | 'max'
  | 'lag' | 'lead' | 'first_value' | 'last_value';

export interface WindowIntent {
  kind: 'window';
  function: WindowFunction;           // Allowlisted - safe for sql.raw()
  field?: ColumnRef;                  // For aggregate window functions
  alias: string;
  over: {
    partitionBy?: ColumnRef[];
    orderBy?: Array<{ field: ColumnRef; direction?: 'asc' | 'desc' }>;
    // frame?: ... // DEFERRED: Frame specification (ROWS/RANGE/GROUPS) to P3+
  };
}
```

### DX Layer API

```typescript
// packages/dx - User-facing API

// Full-Text Search
orm.query('articles')
  .where(fts('content', 'postgresql & tutorial', {
    config: 'english',
    ranking: { enabled: true, weights: [1, 0.4, 0.2, 0.1] }
  }))
  .orderBy(ftsRank('content', 'postgresql & tutorial'), 'desc')
  .findMany();

// Range Types
orm.query('reservations')
  .where(rangeOverlaps('booking_period', {
    lower: '2024-01-01',
    upper: '2024-01-15',
    bounds: '[)'
  }))
  .findMany();

orm.query('events')
  .where(rangeContains('event_period', new Date('2024-06-15')))
  .findMany();

// Window Functions
orm.query('transactions')
  .select(['id', 'amount', 'account_id'])
  .window('running_balance', {
    function: 'sum',
    field: 'amount',
    over: {
      partitionBy: ['account_id'],
      orderBy: [{ field: 'created_at', direction: 'asc' }]
    }
  })
  .findMany();
```

### Adapter Compilation (Kysely Example)

```typescript
// packages/adapter-kysely/src/compiler.ts

function compileFTSWhere(
  eb: ExpressionBuilder<any, any>,
  intent: FTSIntent,
  tableAlias: string
): Expression<SqlBool> {
  const config = sql.lit(intent.config || 'english');
  // Use ColumnRef for proper alias resolution
  const field = sql.ref(`${tableAlias}.${intent.field.column}`);
  const query = sql.val(intent.query);

  // Select tsquery function based on queryMode (default: plainto_tsquery for safety)
  const queryFn = {
    tsquery: 'to_tsquery',
    plain: 'plainto_tsquery',
    phrase: 'phraseto_tsquery',
    websearch: 'websearch_to_tsquery'
  }[intent.queryMode || 'plain'];

  // Prefix matching: append :* to query for prefix search
  const searchQuery = intent.prefix ? sql`${query} || ':*'` : query;

  return sql`to_tsvector(${config}, ${field}) @@ ${sql.raw(queryFn)}(${config}, ${searchQuery})`;
}

function compileFTSRankSelect(
  intent: FTSIntent,
  tableAlias: string,
  alias: string
): AliasedExpression<number, string> {
  const config = sql.lit(intent.config || 'english');
  const field = sql.ref(`${tableAlias}.${intent.field.column}`);
  const query = sql.val(intent.query);

  const queryFn = {
    tsquery: 'to_tsquery',
    plain: 'plainto_tsquery',
    phrase: 'phraseto_tsquery',
    websearch: 'websearch_to_tsquery'
  }[intent.queryMode || 'plain'];

  let rankExpr = sql`ts_rank(to_tsvector(${config}, ${field}), ${sql.raw(queryFn)}(${config}, ${query}))`;

  if (intent.ranking?.weights) {
    const weights = sql.lit(`{${intent.ranking.weights.join(',')}}`);
    rankExpr = sql`ts_rank(${weights}, to_tsvector(${config}, ${field}), ${sql.raw(queryFn)}(${config}, ${query}))`;
  }

  return rankExpr.as(alias);
}

function compileRangeWhere(
  eb: ExpressionBuilder<any, any>,
  intent: RangeIntent,
  tableAlias: string
): Expression<SqlBool> {
  // Use ColumnRef for proper alias resolution
  const field = sql.ref(`${tableAlias}.${intent.field.column}`);
  const bounds = intent.value.bounds || '[)';

  // IMPORTANT: sql.id() for the range constructor function name (identifier),
  // NOT sql.lit() which would create a string literal 'tsrange' instead of tsrange()
  // Safe because RangeType is an allowlisted union (no injection risk)
  const ctor = sql.id(intent.type);
  const rangeValue = sql`${ctor}(${sql.val(intent.value.lower)}, ${sql.val(intent.value.upper)}, ${sql.val(bounds)})`;

  // Allowlisted operators - safe for sql.raw() (closed enum, no user input)
  const operators: Record<RangeOperator, string> = {
    overlaps: '&&',
    contains: '@>',
    contained_by: '<@',
    adjacent: '-|-',
    left_of: '<<',
    right_of: '>>'
  };

  return sql`${field} ${sql.raw(operators[intent.operator])} ${rangeValue}`;
}

function compileWindowSelect(
  intent: WindowIntent,
  tableAlias: string
): AliasedExpression<unknown, string> {
  // WindowFunction is allowlisted - safe for sql.raw()
  const fn = intent.function;
  // Use ColumnRef for proper alias resolution
  const field = intent.field ? sql.ref(`${tableAlias}.${intent.field.column}`) : sql`*`;

  let overClause = sql``;

  if (intent.over.partitionBy?.length) {
    // ColumnRef[] - extract column names
    const partitionCols = intent.over.partitionBy.map(c => sql.ref(`${tableAlias}.${c.column}`));
    overClause = sql`PARTITION BY ${sql.join(partitionCols)}`;
  }

  if (intent.over.orderBy?.length) {
    const orderCols = intent.over.orderBy.map(o => {
      // ColumnRef - extract column name
      const col = sql.ref(`${tableAlias}.${o.field.column}`);
      return o.direction === 'desc' ? sql`${col} DESC` : col;
    });
    const orderClause = sql`ORDER BY ${sql.join(orderCols)}`;
    overClause = overClause ? sql`${overClause} ${orderClause}` : orderClause;
  }

  return sql`${sql.raw(fn)}(${field}) OVER (${overClause})`.as(intent.alias);
}
```

## Consequences

### Positive

1. **Single connection pool**: Each adapter uses its own ORM's connection
2. **Type-safe API**: Users never write raw SQL
3. **Multi-adapter support**: Same Intent compiles to Kysely, Drizzle, or Prisma
4. **Dialect awareness**: Can guard against unsupported features per dialect
5. **Observable**: Intents appear in PlanReport for debugging

### Negative

1. **Implementation effort**: Each adapter must implement compile functions
2. **SQL generation complexity**: Must handle dialect differences
3. **Testing burden**: Must test each adapter's compilation

### Neutral

1. **RawIntent remains**: Ultimate escape hatch for truly exotic cases
2. **Capability guards**: Must extend DialectCapabilities for new features

## Dialect Capability Extensions

```typescript
// packages/adapter-kysely/src/dialect.ts

/**
 * FTS Flavor - Different databases have different FTS implementations
 * This allows the compiler to select the right SQL generation strategy
 */
type FTSFlavor = 'none' | 'postgres-tsvector' | 'mysql-fulltext' | 'sqlite-fts5';

/**
 * Window Function Support Level
 */
type WindowFunctionSupport = 'none' | 'basic' | 'full';

interface DialectCapabilities {
  // Existing
  supportsReturning: boolean;
  supportsSchemas: boolean;
  supportsStreaming: boolean;
  supportsArrayType: boolean;
  supportsRecursiveCTE: boolean;

  // NEW for P3 features - Using flavors instead of booleans
  // This allows proper SQL generation per dialect
  ftsFlavor: FTSFlavor;                       // Which FTS implementation?
  supportsRangeTypes: boolean;                // PostgreSQL only (no flavor needed)
  windowFunctionSupport: WindowFunctionSupport; // Level of window function support
}

const POSTGRES_CAPABILITIES: DialectCapabilities = {
  // ... existing
  ftsFlavor: 'postgres-tsvector',  // to_tsvector/to_tsquery
  supportsRangeTypes: true,         // daterange, tsrange, etc.
  windowFunctionSupport: 'full',    // All window functions + frames
};

const MYSQL_CAPABILITIES: DialectCapabilities = {
  // ... existing
  ftsFlavor: 'mysql-fulltext',     // MATCH ... AGAINST syntax
  supportsRangeTypes: false,
  windowFunctionSupport: 'full',   // MySQL 8.0+ has full support
};

const SQLITE_CAPABILITIES: DialectCapabilities = {
  // ... existing
  ftsFlavor: 'sqlite-fts5',        // FTS5 virtual tables
  supportsRangeTypes: false,
  windowFunctionSupport: 'basic',  // SQLite 3.25+ (no GROUPS frame)
};

const MSSQL_CAPABILITIES: DialectCapabilities = {
  // ... existing
  ftsFlavor: 'none',               // Would need separate implementation
  supportsRangeTypes: false,
  windowFunctionSupport: 'full',
};
```

### FTS Flavor Usage in Compiler

```typescript
function compileFTSWhere(
  intent: FTSIntent,
  tableAlias: string,
  capabilities: DialectCapabilities
): Expression<SqlBool> {
  switch (capabilities.ftsFlavor) {
    case 'postgres-tsvector':
      return compilePostgresFTS(intent, tableAlias);
    case 'mysql-fulltext':
      return compileMySQLFTS(intent, tableAlias);
    case 'sqlite-fts5':
      return compileSQLiteFTS(intent, tableAlias);
    case 'none':
      throw new UnsupportedOperationError(
        'Full-text search',
        'current dialect',
        'Use PostgreSQL, MySQL, or SQLite for FTS support'
      );
  }
}
```

## Prisma Adapter Considerations

**Important:** Prisma's raw SQL mechanism (`$queryRaw`, `$queryRawUnsafe`) differs fundamentally from Kysely/Drizzle:

| Feature | Kysely/Drizzle | Prisma |
|---------|----------------|--------|
| **Scope** | Fragments (WHERE, SELECT expressions) | Entire queries only |
| **Integration** | Composable with query builder | Standalone execution |
| **Type safety** | Template tag with interpolation | `Prisma.sql` or unsafe string |

**Implication for adapter-prisma:**

```typescript
// Kysely/Drizzle approach (fragment injection)
.where(sql`to_tsvector('english', ${ref('title')}) @@ to_tsquery(...)`)

// Prisma approach (must build complete query)
const result = await prisma.$queryRaw`
  SELECT * FROM articles
  WHERE to_tsvector('english', title) @@ to_tsquery('english', ${query})
`;
```

The Prisma adapter will need to:
1. Build complete SQL strings from Intent AST (not fragments)
2. Use `Prisma.sql` template tag for parameter binding
3. Potentially fall back to native Prisma queries when possible

This is a **significant implementation difference** but doesn't change the architecture—Typed Intents remain the contract, only compilation differs.

## Intent Hierarchy Summary

```
Intent Types
├── QueryIntent (SELECT queries)
│   ├── SelectIntent
│   ├── WhereIntent
│   │   ├── WhereComparisonIntent
│   │   ├── WhereLikeIntent
│   │   ├── WhereInIntent
│   │   ├── WhereNullIntent
│   │   ├── WhereAndIntent / WhereOrIntent / WhereNotIntent
│   │   ├── WhereExistsIntent / WhereRelationFilterIntent
│   │   ├── WhereSubqueryIntent (DX-012)
│   │   ├── FTSIntent           ← NEW (P3)
│   │   └── RangeIntent         ← NEW (P3)
│   ├── IncludeIntent
│   ├── OrderByIntent
│   ├── SelectAggregateIntent
│   └── WindowIntent            ← NEW (P3, in SELECT)
├── MutationIntent (INSERT/UPDATE/DELETE)
│   ├── InsertIntent
│   ├── UpdateIntent
│   └── DeleteIntent
├── RecursiveIntent (WITH RECURSIVE)
└── RawIntent (escape hatch)
```

## Implementation Roadmap

| Phase | Feature | Scope | Priority |
|-------|---------|-------|----------|
| P3-A | WindowIntent | core + adapter-kysely | HIGH (Kysely native API) |
| P3-B | FTSIntent (PostgreSQL) | core + adapter-kysely | MEDIUM |
| P3-C | RangeIntent (PostgreSQL) | core + adapter-kysely | MEDIUM |
| P3-D | FTS MySQL adapter | adapter-kysely | LOW |
| P3-E | FTS SQLite (FTS5) adapter | adapter-kysely | LOW |

## References

- [PostgreSQL Full-Text Search](https://www.postgresql.org/docs/current/textsearch.html)
- [PostgreSQL Range Types](https://www.postgresql.org/docs/current/rangetypes.html)
- [PostgreSQL Window Functions](https://www.postgresql.org/docs/current/tutorial-window.html)
- [Kysely sql template](https://kysely.dev/docs/recipes/reusable-helpers)
- [Drizzle sql operator](https://orm.drizzle.team/docs/sql)
- [Prisma $queryRaw](https://www.prisma.io/docs/concepts/components/prisma-client/raw-database-access)
