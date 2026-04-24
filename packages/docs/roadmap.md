---
title: Roadmap
---

# Roadmap

db-semantic-planner's core is **adapter-agnostic** — the schema DSL, query builders, semantic planner, and NQL parser work independently of any database. The PostgreSQL adapter is the first implementation, but the architecture is designed for multiple backends.

## Current (v1.0)

| Feature | Status |
|---------|--------|
| Core: schema DSL, planner, query builders, NQL | Stable |
| PostgreSQL adapter (native pg Pool) | Stable |
| DDL: introspection, comparison, migrations | Stable |
| CLI: generate, verify, migrate, REPL | Stable |
| Extensions: pgvector, ParadeDB BM25 | Stable |
| MCP Server for AI assistants | Stable |

## Planned

| Adapter | Use Case | Status |
|---------|----------|--------|
| **SQLite** | Embedded, mobile, edge, testing | Planned |
| **DuckDB** | Analytics, OLAP, data science | Planned |
| **MySQL** | Legacy systems, WordPress ecosystem | Planned |
| **LibSQL** (Turso) | Edge-distributed SQLite | Under consideration |

## How adapters work

Each adapter implements the `Adapter` interface from `@dbsp/types`. The core never imports adapter code — it compiles query intents into a `PlanReport`, and the adapter compiles that into dialect-specific SQL.

```
@dbsp/core (planner)  →  PlanReport  →  @dbsp/adapter-pgsql (SQL)
                                      →  @dbsp/adapter-sqlite (planned)
                                      →  @dbsp/adapter-duckdb (planned)
```

This means your application code stays the same — only the adapter import changes:

```typescript
// doctest: skip — illustrates future multi-adapter support, adapter-sqlite not yet available
// PostgreSQL (today)
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
const adapter = createPgsqlAdapter(pool);

// SQLite (future)
import { createSqliteAdapter } from '@dbsp/adapter-sqlite';
const adapter = createSqliteAdapter(db);

// Same ORM, same queries, same types
const orm = createOrm({ schema, adapter });
```

## Feature negotiation

When an adapter doesn't support a feature (e.g., SQLite has no LATERAL JOIN), the `DialectCapabilities` system warns or errors at ORM creation time — not at query time. The planner automatically falls back to compatible strategies.

## Contributing

Want to build an adapter? See the [Architecture guide](/guide/schema) and the [Adapter interface in @dbsp/types](https://github.com/oorabona/db-semantic-planner/tree/main/packages/types).
