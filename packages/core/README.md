# @dbsp/core

[![npm version](https://img.shields.io/npm/v/@dbsp/core.svg)](https://www.npmjs.com/package/@dbsp/core)
[![license](https://img.shields.io/npm/l/@dbsp/core.svg)](LICENSE)

Intent-first semantic query planner for databases. Declare what you want, let the planner decide how — with full type safety and observability.

## Installation

```bash
pnpm add @dbsp/core @dbsp/adapter-pgsql
```

## Quick Start

```typescript
import { schema, ref, createOrm, eq } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import { Pool } from 'pg';

// 1. Define schema
const db = schema({
  users: { id: 'uuid', name: 'string', email: 'string', active: 'boolean' },
  posts: { id: 'uuid', title: 'string', authorId: ref('users') },
});

// 2. Create ORM
const orm = createOrm({
  schema: db,
  adapter: createPgsqlAdapter(new Pool({ connectionString: process.env.DATABASE_URL })),
});

// 3. Query
const users = await orm.select('users').where(eq('active', true)).all();

// 4. Inspect the plan
const dump = await orm.select('users').where(eq('active', true)).dump();
console.log(dump.sql);     // SELECT "id", "name", "email", "active" FROM "users" WHERE "active" = $1
console.log(dump.params);  // [true]
console.log(dump.plan);    // PlanReport with decisions + reasoning
```

## Key features

- **Intent-first** — Declare what to fetch; the planner decides JOIN vs EXISTS, aliasing, CTE extraction
- **Type-safe** — Full TypeScript inference from schema definition to query result types
- **Observable** — Every query exposes `dump()` returning plan decisions, SQL, and bound parameters
- **Deterministic** — Same inputs always produce the same SQL and plan (stable aliasing)
- **Multi-tenant** — `orm.withSchema('tenant_123')` for schema-per-tenant isolation
- **Expression primitives** — `op()`, `fn()`, `ref()`, `cast()`, `caseWhen()`, vector distances, ParadeDB full-text
- **Set operations** — `union()`, `unionAll()`, `intersect()`, `except()`
- **Subqueries** — Scalar subqueries, `inSubquery()`, correlated EXISTS
- **Joins** — Relation-based includes, manual `join()` with custom `ON` clauses
- **Mutations** — Insert, update, upsert, delete with type-safe builders

## Adapter interface

`@dbsp/core` defines the `Adapter` port; concrete implementations live in separate packages (e.g. `@dbsp/adapter-pgsql`). The core is fully database-agnostic.

## Documentation

- [Full documentation index](../../docs/DOCUMENTATION_INDEX.md)
- [Expression primitives guide](../../docs/guides/how-to-use-expression-primitives.md)
- [Joins guide](../../docs/guides/how-to-use-joins.md)
- [DDL helpers guide](../../docs/guides/how-to-use-ddl-helpers.md)

## License

MIT
