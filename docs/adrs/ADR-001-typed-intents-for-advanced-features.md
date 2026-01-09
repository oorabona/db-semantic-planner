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

### Intent Type Definitions

```typescript
// packages/core/src/intent-ast.ts

/**
 * Full-Text Search Intent
 * Compiles to: to_tsvector(config, field) @@ to_tsquery(config, query)
 */
export interface FTSIntent {
  kind: 'fts';
  field: string;
  query: string;
  config?: string;                    // 'english', 'french', 'simple'
  operator?: 'match' | 'phrase' | 'prefix' | 'negation';
  ranking?: {
    enabled: boolean;
    weights?: [number, number, number, number];  // A, B, C, D weights
    normalization?: number;
  };
}

/**
 * Range Type Intent
 * Compiles to: field <operator> range_value
 * Operators: && (overlaps), @> (contains), <@ (contained), -|- (adjacent)
 */
export interface RangeIntent {
  kind: 'range';
  field: string;
  type: 'daterange' | 'tsrange' | 'tstzrange' | 'int4range' | 'int8range' | 'numrange';
  operator: 'overlaps' | 'contains' | 'contained_by' | 'adjacent' | 'left_of' | 'right_of';
  value: {
    lower: unknown;
    upper: unknown;
    bounds?: '[]' | '[)' | '(]' | '()';  // inclusive/exclusive
  };
}

/**
 * Window Function Intent
 * Compiles to: fn(field) OVER (PARTITION BY ... ORDER BY ...)
 */
export interface WindowIntent {
  kind: 'window';
  function: 'row_number' | 'rank' | 'dense_rank' | 'sum' | 'avg' | 'count' | 'min' | 'max' | 'lag' | 'lead' | 'first_value' | 'last_value';
  field?: string;                     // For aggregate window functions
  alias: string;
  over: {
    partitionBy?: string[];
    orderBy?: Array<{ field: string; direction?: 'asc' | 'desc' }>;
    frame?: {
      type: 'rows' | 'range' | 'groups';
      start: 'unbounded_preceding' | 'current_row' | { offset: number; direction: 'preceding' | 'following' };
      end?: 'unbounded_following' | 'current_row' | { offset: number; direction: 'preceding' | 'following' };
    };
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
  const field = sql.ref(`${tableAlias}.${intent.field}`);
  const query = sql.val(intent.query);

  return sql`to_tsvector(${config}, ${field}) @@ to_tsquery(${config}, ${query})`;
}

function compileFTSRankSelect(
  intent: FTSIntent,
  tableAlias: string,
  alias: string
): AliasedExpression<number, string> {
  const config = sql.lit(intent.config || 'english');
  const field = sql.ref(`${tableAlias}.${intent.field}`);
  const query = sql.val(intent.query);

  let rankExpr = sql`ts_rank(to_tsvector(${config}, ${field}), to_tsquery(${config}, ${query}))`;

  if (intent.ranking?.weights) {
    const weights = sql.lit(`{${intent.ranking.weights.join(',')}}`);
    rankExpr = sql`ts_rank(${weights}, to_tsvector(${config}, ${field}), to_tsquery(${config}, ${query}))`;
  }

  return rankExpr.as(alias);
}

function compileRangeWhere(
  eb: ExpressionBuilder<any, any>,
  intent: RangeIntent,
  tableAlias: string
): Expression<SqlBool> {
  const field = sql.ref(`${tableAlias}.${intent.field}`);
  const bounds = intent.value.bounds || '[)';
  const rangeValue = sql`${sql.lit(intent.type)}(${sql.val(intent.value.lower)}, ${sql.val(intent.value.upper)}, ${sql.lit(bounds)})`;

  const operators: Record<RangeIntent['operator'], string> = {
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
  const fn = intent.function;
  const field = intent.field ? sql.ref(`${tableAlias}.${intent.field}`) : sql`*`;

  let overClause = sql``;

  if (intent.over.partitionBy?.length) {
    const partitionCols = intent.over.partitionBy.map(c => sql.ref(`${tableAlias}.${c}`));
    overClause = sql`PARTITION BY ${sql.join(partitionCols)}`;
  }

  if (intent.over.orderBy?.length) {
    const orderCols = intent.over.orderBy.map(o => {
      const col = sql.ref(`${tableAlias}.${o.field}`);
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

interface DialectCapabilities {
  // Existing
  supportsReturning: boolean;
  supportsSchemas: boolean;
  supportsStreaming: boolean;
  supportsArrayType: boolean;
  supportsRecursiveCTE: boolean;

  // NEW for P3 features
  supportsFullTextSearch: boolean;      // PostgreSQL, MySQL (different syntax)
  supportsTsvector: boolean;            // PostgreSQL only
  supportsRangeTypes: boolean;          // PostgreSQL only
  supportsWindowFunctions: boolean;     // PostgreSQL, MySQL 8+, SQLite 3.25+
}

const POSTGRES_CAPABILITIES: DialectCapabilities = {
  // ... existing
  supportsFullTextSearch: true,
  supportsTsvector: true,
  supportsRangeTypes: true,
  supportsWindowFunctions: true,
};

const MYSQL_CAPABILITIES: DialectCapabilities = {
  // ... existing
  supportsFullTextSearch: true,   // Different syntax (MATCH ... AGAINST)
  supportsTsvector: false,
  supportsRangeTypes: false,
  supportsWindowFunctions: true,  // MySQL 8.0+
};

const SQLITE_CAPABILITIES: DialectCapabilities = {
  // ... existing
  supportsFullTextSearch: true,   // FTS5
  supportsTsvector: false,
  supportsRangeTypes: false,
  supportsWindowFunctions: true,  // SQLite 3.25+
};
```

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
