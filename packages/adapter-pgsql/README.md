# @dbsp/adapter-pgsql

[![npm version](https://img.shields.io/npm/v/@dbsp/adapter-pgsql.svg)](https://www.npmjs.com/package/@dbsp/adapter-pgsql)
[![license](https://img.shields.io/npm/l/@dbsp/adapter-pgsql.svg)](LICENSE)

PostgreSQL adapter for `@dbsp/core` — compiles semantic plan reports to parameterized SQL and executes against a `pg.Pool`.

## Installation

```bash
pnpm add @dbsp/adapter-pgsql pg
```

## Quick Start

```typescript
import { createOrm } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const orm = createOrm({
  schema: db,
  adapter: createPgsqlAdapter(pool),
});

const rows = await orm.select('users').where(eq('active', true)).all();
```

## Compile-only mode

Compile SQL without a database connection — useful for CLI tooling, CI plan inspection, and testing:

```typescript
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const adapter = createPgsqlCompileOnlyAdapter();
const { sql, parameters } = adapter.compile(planReport, { model, schemaName });
```

## Key features

- **Parameterized queries** — All user values use `$N` positional parameters; no SQL injection surface
- **Identifier quoting** — All table/column/schema names are double-quoted automatically
- **AST-based compiler** — SQL is built from the plan AST, never from string templates
- **DDL provisioning** — `compareSchemata()` + `generateDDL()` with 12-phase topological sort
- **Schema migrations** — `generateMigrationSQL()` with UP/DOWN sections and destructive-change safety gate
- **Schema introspection** — Reflect live database structure back into `ModelIR`
- **Row-Level Security** — `rlsEnabled` + `policies[]` on `TableIR`, compiled to `CREATE POLICY` DDL
- **Streaming & cursors** — `orm.select(...).stream()` and server-side cursor support
- **Indexes** — Create/drop/list indexes including GIN, HNSW, BM25 via `orm.tables.<name>.indexes`
- **Runtime DDL helpers** — `truncate()`, `vacuum()`, `storageSize()`, `alterColumn()`
- **Multi-tenant** — Respects `orm.withSchema(schemaName)` for all operations

## Documentation

- [Guides](../../docs/guides/)
- [DDL helpers guide](../../docs/guides/how-to-use-ddl-helpers.md)
- [RLS policies guide](../../docs/guides/how-to-use-rls-policies.md)
- [Schema versioning guide](../../docs/guides/how-to-use-schema-versioning.md)

## License

MIT
