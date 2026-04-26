# db-semantic-planner

[![npm](https://img.shields.io/npm/v/@dbsp/core)](https://www.npmjs.com/package/@dbsp/core)
[![Tests](https://img.shields.io/badge/tests-7%2C700%2B-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)]()

**The intent-first query planner for PostgreSQL.**

Declare *what* you want. The planner decides *how* to get it — then shows you *why*.

---

## The Problem

Most ORMs hide SQL behind abstractions that break the moment you need to debug a slow query or understand why N+1 is happening. Query builders give you SQL control but no relation handling. When something goes wrong, you're reading source code and guessing. What if the query layer could explain every decision it made?

---

## The Solution

```typescript
const result = await orm
  .select('users')
  .where(eq('active', true))
  .include('posts')
  .dump();

// result.sql
// → SELECT "u".*, COALESCE(...) AS "posts"
//     FROM "users" "u"
//     LEFT JOIN LATERAL (SELECT ... FROM "posts" WHERE "posts"."authorId" = "u"."id") ...

// result.plan.decisions
// → [{ type: 'include-strategy', choice: 'lateral-join',
//      reason: 'to-many relation, optimal for N+1 prevention' }]

// result.params → [true]
```

The planner picks the right strategy (EXISTS, JOIN, lateral subquery) based on cardinality, then surfaces every decision via `dump()`. Nothing is hidden.

---

## Comparison

| Feature | dbsp | Prisma | Drizzle | Kysely |
|---------|:----:|:------:|:-------:|:------:|
| Query plan inspection | Yes | No | No | No |
| Decision transparency | Yes | No | No | No |
| Auto N+1 prevention | Yes | Yes | Yes | No |
| Include strategies | 3 (join, lateral, subquery) | 1 (findMany) | Partial | No |
| Multi-tenant (schema-per-tenant) | Built-in | Manual | Manual | Manual |
| Type-safe queries | Yes | Yes | Yes | Yes |
| Zero codegen | Yes | No | Yes | Yes |
| PostgreSQL extensions (pgvector, BM25) | Built-in helpers | Raw SQL | Raw SQL | Raw SQL |

See [full comparison](https://oorabona.github.io/db-semantic-planner/comparison) with 16 tools.

---

## Getting Started

### Install

```bash
pnpm add @dbsp/core @dbsp/adapter-pgsql
```

### Define Your Schema

```typescript
import { schema, ref } from '@dbsp/core';

const db = schema({
  users: {
    id: 'uuid',
    name: 'string',
    email: 'string',
    createdAt: 'timestamp',
  },
  posts: {
    id: 'uuid',
    title: 'string',
    content: { type: 'text', nullable: true },
    authorId: ref('users'),
    published: 'boolean',
  },
});
```

### Connect and Query

```typescript
import { createOrm, eq } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const orm = createOrm({
  schema: db,
  adapter: createPgsqlAdapter(pool),
});

const activeUsers = orm
  .select('users')
  .where(eq('active', true))
  .dump();
```

### Load Relations

```typescript
// doctest: skip — exec-only operation; requires a real PostgreSQL connection
// Relations are inferred from ref() — no configuration needed
const usersWithPosts = await orm
  .select('users')
  .include('posts')
  .include('posts.comments')
  .all();
```

### Inspect Everything

```typescript
const dump = orm.select('users').where(eq('active', true)).dump();

console.log(dump.sql);     // SELECT "users".* FROM "users" WHERE "active" = $1
console.log(dump.params);  // [true]
console.log(dump.plan);    // { decisions: [...], warnings: [...] }
```

See the [Getting Started guide](https://oorabona.github.io/db-semantic-planner/guide/getting-started) for the full walkthrough.

---

## Features

**Semantic Planning** — The planner chooses between EXISTS, JOIN, and lateral subqueries based on cardinality. No configuration required.

```typescript
import { Pool } from 'pg';
import { schema, ref, createOrm, eq, some } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';

const __db = schema({
  users: { id: 'integer', name: 'string' },
  posts: { id: 'integer', userId: ref('users'), published: 'boolean' },
} as const);
const __pool = new Pool({ connectionString: process.env.DATABASE_URL });
const __orm = createOrm({ schema: __db, adapter: createPgsqlAdapter(__pool) });

// Find users with at least one published post
__orm.select('users')
  .where(some(__db.tables.users.posts, (p) => eq(p.published, true)))
  .dump();
// → WHERE EXISTS (SELECT 1 FROM "posts" WHERE ...)
```

**Full Observability** — Every query exposes its plan, SQL, and parameters via `dump()`. Works on selects, mutations, and subqueries.

```typescript
const { sql, params, plan } = orm.insert('users').values({ name: 'Alice' }).dump();
```

**Multi-tenant** — Schema-per-tenant isolation with `withSchema()`. All queries in the scoped context use the given schema.

```typescript
const tenantOrm = orm.withSchema('acme_corp');
tenantOrm.select('users').dump();
// → SELECT * FROM "acme_corp"."users"
```

**Expression Primitives** — Type-safe `op()`, `fn()`, `ref()`, `cast()` for complex PostgreSQL expressions without raw SQL.

```typescript
.orderBy(op('<=>', ref('embedding'), cast(param(queryVec), 'vector')))
```

**Recursive Queries** — Hierarchies via `include({ recursive: true })` with automatic CTE generation.

```typescript
orm.select('categories').where(eq('id', 5))
  .include('parent', { recursive: true, direction: 'ancestors' })
  .dump();
```

**Mutations** — Insert, update, delete, upsert with RETURNING support and full `dump()` observability.

```typescript
orm.upsert('users').values({ email: 'alice@example.com', name: 'Alice' })
  .onConflict(['email']).doUpdate().dump();
```

**NQL** — Pipe-based query language for CLI/REPL exploration.

```
users | where active = true | select id, name | limit 10
```

**DDL Management** — Schema introspection, diff, and migration generation against a live PostgreSQL instance.

```bash
dbsp verify --schema ./dbsp.schema.ts --db postgres://localhost/mydb
```

**pgvector + ParadeDB** — Built-in helpers for vector similarity search and full-text BM25. No raw SQL.

```typescript
// doctest: skip — exec-only operation (.all() requires a real PostgreSQL connection); the `docs` table is also not in the default doctest preamble (preamble uses `documents`)
import { cosineDistance } from '@dbsp/adapter-pgsql';
orm.select('docs').orderBy(cosineDistance('embedding', queryVec).as('score')).limit(10).all();
```

**Range Operators** — First-class PostgreSQL range type support: `rangeOverlaps()`, `rangeContains()`, `rangeContainedBy()` covering `daterange`, `int4range`, `tsrange`, and friends. No raw SQL needed.

**Observability Metadata** — Pass `{ queryName, correlationId }` to `.dump()` to propagate request context to logs and traces without coupling your query layer to your observability stack.

```typescript
const requestId = 'req-abc-123'; // typically req.headers['x-request-id']
const dump = orm.select('users').where(eq('active', true))
  .dump({ queryName: 'list-active-users', correlationId: requestId });
// dump.meta?.correlationId === requestId
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        @dbsp/cli                                │
│  dbsp generate | dbsp verify | dbsp repl                        │
└──────────────────────────────┬──────────────────────────────────┘
                               │
┌──────────────────────────────┼──────────────────────────────────┐
│                              ▼                                  │
│  @dbsp/core                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │  ModelIR    │  │  IntentAST  │  │  Semantic Planner       │ │
│  │  (Schema)   │→→│  (Query)    │→→│  (Plan + Decisions)     │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  DX Layer: schema(), createOrm(), eq(), ref(), …        │   │
│  └─────────────────────────────────────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────────┘
                               │ implements Adapter
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  @dbsp/adapter-pgsql                                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  SQL Compiler (PlanReport → PostgreSQL AST → SQL)       │   │
│  │  PgsqlAdapter (pg Pool), CompileOnlyAdapter (no DB)     │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

The core package is database-agnostic. It only knows about schema shapes and query intents. The adapter translates plans into parameterized SQL using PostgreSQL's native expression AST — no raw string templates.

---

## Packages

| Package | Description |
|---------|-------------|
| `@dbsp/core` | Schema DSL, query intents, semantic planner, ORM API |
| `@dbsp/adapter-pgsql` | PostgreSQL-native SQL compilation + execution (pg Pool) |
| `@dbsp/types` | Shared type contracts (Adapter, ModelIR, IntentAST, PlanReport) |
| `@dbsp/nql` | Natural Query Language parser (Chevrotain) |
| `@dbsp/cli` | CLI tools: generate, verify, repl |
| `@dbsp/mcp-server` | MCP server for AI assistant integration |

---

## Documentation

Full documentation is published at **[dbsp.dev](https://oorabona.github.io/db-semantic-planner/)** (GitHub Pages).

| Guide | Description |
|-------|-------------|
| [Getting Started](https://oorabona.github.io/db-semantic-planner/guide/getting-started) | Full walkthrough from schema to first query |
| [ORM API Reference](https://oorabona.github.io/db-semantic-planner/api/orm-api) | Complete TypeScript API reference |
| [NQL Reference](https://oorabona.github.io/db-semantic-planner/nql/) | Pipe-based query language syntax |
| [CLI Usage](https://oorabona.github.io/db-semantic-planner/guide/cli-usage) | `generate`, `verify`, `repl` commands |
| [Joins Guide](https://oorabona.github.io/db-semantic-planner/guide/joins) | Manual joins, LATERAL, DISTINCT ON |
| [Expression Primitives](https://oorabona.github.io/db-semantic-planner/guide/expression-primitives) | `op()`, `fn()`, `ref()`, `cast()` |
| [DDL Helpers](https://oorabona.github.io/db-semantic-planner/guide/ddl-helpers) | Schema diff and DDL generation |
| [Full-text Search](https://oorabona.github.io/db-semantic-planner/guide/full-text-search) | pgvector and ParadeDB BM25 |
| [Recursive CTEs](https://oorabona.github.io/db-semantic-planner/guide/recursive-cte) | Tree traversal with `include()` |
| [Comparison](https://oorabona.github.io/db-semantic-planner/comparison) | dbsp vs 16 query libraries |

---

## Contributing

Contributions are welcome. Please open an issue before submitting a large pull request so we can align on direction. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, coding conventions, and the PR process.

---

## License

MIT — see [LICENSE](LICENSE).
