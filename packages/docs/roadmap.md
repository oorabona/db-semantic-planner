---
title: Roadmap
---

# Roadmap

db-semantic-planner's core is **adapter-agnostic** — the schema DSL, query builders, semantic planner, and NQL parser work independently of any database. The PostgreSQL adapter is the first implementation, but the architecture is designed for multiple backends.

## Current (v1.0)

| Feature | Status |
|---------|--------|
| Core: schema DSL, planner, query builders, NQL | <span class="status-badge status-stable">Stable</span> |
| PostgreSQL adapter (native pg Pool) | <span class="status-badge status-stable">Stable</span> |
| DDL: introspection, comparison, managed plans | <span class="status-badge status-stable">Stable</span> |
| CLI: plan, apply, inspect, verify, REPL | <span class="status-badge status-stable">Stable</span> |
| Extensions: pgvector, ParadeDB BM25 | <span class="status-badge status-stable">Stable</span> |
| MCP Server for AI assistants | <span class="status-badge status-stable">Stable</span> |

## Planned

| Adapter | Use Case | Status |
|---------|----------|--------|
| **SQLite** | Embedded, mobile, edge, testing | <span class="status-badge status-planned">Planned</span> |
| **DuckDB** | Analytics, OLAP, data science | <span class="status-badge status-planned">Planned</span> |
| **MySQL** | Legacy systems, WordPress ecosystem | <span class="status-badge status-planned">Planned</span> |
| **LibSQL** (Turso) | Edge-distributed SQLite | <span class="status-badge status-considering">Under consideration</span> |

## How adapters work

Each adapter implements the `Adapter` interface from `@dbsp/types`. The core never imports adapter code — it compiles query intents into a `PlanReport`, and the adapter compiles that into dialect-specific SQL.

```
@dbsp/core (planner)  →  PlanReport  →  @dbsp/adapter-pgsql (SQL)
                                      →  @dbsp/adapter-sqlite (planned)
                                      →  @dbsp/adapter-duckdb (planned)
```

This means your application code stays the same — only the adapter import changes:

```typescript
// doctest: skip — aspirational adapter portability example (adapter-sqlite is planned, not yet implemented; duplicate const declarations are intentional for illustration)
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
