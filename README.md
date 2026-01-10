# db-semantic-planner

Semantic query planning for databases. An intent-first approach that transforms declarative query intents into optimized SQL with full observability.

## Features

- **Intent-first queries** - Describe what you want, not how to get it
- **Semantic planning** - Automatic EXISTS vs JOIN decisions based on cardinality
- **CTE extraction** - Common subqueries automatically optimized
- **Multi-tenant** - Schema-per-tenant with `forTenant()` API
- **Full observability** - Inspect plans, SQL, and parameters before execution
- **Type-safe** - Full TypeScript support with strict types

## Installation

```bash
pnpm add @db-semantic-planner/core @db-semantic-planner/adapter-kysely
```

## Quick Start

### 1. Define your schema

```typescript
import { defineSchema, hasMany, belongsTo } from '@db-semantic-planner/core';

const model = defineSchema({
  users: {
    id: 'number',
    name: 'string',
    email: 'string',
  },
  posts: {
    id: 'number',
    title: 'string',
    authorId: 'number',
  },
})
  .relations({
    users: {
      posts: hasMany('posts', { foreignKey: 'authorId' }),
    },
    posts: {
      author: belongsTo('users', { foreignKey: 'authorId' }),
    },
  })
  .build();
```

### 2. Create a query intent

```typescript
import type { QueryIntent } from '@db-semantic-planner/core';

const intent: QueryIntent = {
  type: 'select',
  from: 'users',
  where: {
    kind: 'exists',
    relation: 'posts',
    where: {
      kind: 'comparison',
      field: 'title',
      operator: 'like',
      value: '%typescript%',
    },
  },
};
```

### 3. Plan and compile

```typescript
import { plan } from '@db-semantic-planner/core';
import { createDump } from '@db-semantic-planner/adapter-kysely';
import { Kysely, PostgresDialect } from 'kysely';

// Create Kysely instance
const kysely = new Kysely({ dialect: new PostgresDialect({ pool }) });

// Get full observability dump
const dump = createDump(intent, model, kysely);

console.log(dump.sql);
// SELECT * FROM "users" AS "t0"
// WHERE EXISTS (
//   SELECT 1 FROM "posts" AS "t1"
//   WHERE "t1"."authorId" = "t0"."id"
//     AND "t1"."title" LIKE $1
// )

console.log(dump.params);
// ['%typescript%']

console.log(dump.plan.decisions);
// [{ type: 'filter-strategy', choice: 'exists', reasoning: '...' }]
```

### 4. Multi-tenant queries

```typescript
const dump = createDump(intent, model, kysely, { tenant: 'acme_corp' });

console.log(dump.sql);
// SELECT * FROM "acme_corp"."users" AS "t0" ...
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Your Application                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  @db-semantic-planner/core                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  ModelIR    │  │  IntentAST  │  │  Semantic Planner   │  │
│  │  (Schema)   │  │  (Query)    │  │  (Decisions)        │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  @db-semantic-planner/adapter-kysely                         │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  SQL Compiler (PlanReport → Kysely CompiledQuery)   │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        Kysely                                │
└─────────────────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| `@db-semantic-planner/core` | Schema definition, query intents, semantic planning |
| `@db-semantic-planner/adapter-kysely` | SQL compilation via Kysely |

## API Reference

### Core

| Export | Description |
|--------|-------------|
| `defineSchema()` | Create a schema with tables and relations |
| `hasMany()` | Define a one-to-many relation |
| `hasOne()` | Define a one-to-one relation |
| `belongsTo()` | Define a many-to-one relation |
| `plan()` | Generate a PlanReport from QueryIntent |
| `AmbiguousPlanError` | Thrown when relation is ambiguous |

### Adapter

| Export | Description |
|--------|-------------|
| `compile()` | Low-level: PlanReport → CompiledQuery |
| `createDump()` | High-level: QueryIntent → Dump (plan + sql + params) |
| `createDumpFromPlan()` | Create Dump from existing PlanReport |
| `formatDump()` | Format Dump for logging |

## Planner Decisions

The semantic planner automatically makes optimization decisions:

| Decision | Options | Criteria |
|----------|---------|----------|
| `filter-strategy` | `exists`, `join` | Cardinality (to-many → EXISTS) |
| `cte-extraction` | extract, inline | Access count (≥2 → CTE) |

## Status

**✅ v1.0 Ready** - 1000+ tests passing

- Core: ModelIR, IntentAST, Semantic Planner, DX Layer
- Adapter: SQL Compiler, Multi-tenant, Observability, Multi-dialect
- Golden Tests: Q1 (EXISTS), Q2 (CTE), Q3 (Ambiguity)
- E2E: PostgreSQL integration (Testcontainers)

## License

MIT
