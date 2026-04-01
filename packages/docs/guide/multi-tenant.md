---
title: Multi-tenant Isolation
---

# Multi-tenant Isolation

db-semantic-planner supports schema-per-tenant isolation via `orm.withSchema()`.

## Usage

```typescript
const tenantOrm = orm.withSchema('acme_corp');
const users = await tenantOrm.select('users').all();
// SQL: SELECT * FROM "acme_corp"."users"
```

All queries, mutations, and DDL operations through the scoped ORM are automatically prefixed with the schema name. The schema name is validated as a safe SQL identifier.

## How it works

- `withSchema()` returns a new ORM instance scoped to that schema
- All table references are automatically prefixed: `"schema"."table"`
- Parameter binding is used for all values — schema names are quoted identifiers
- DDL helpers (truncate, vacuum, indexes) respect the schema scope

See the [DDL Helpers guide](/guide/ddl-helpers) for schema-aware DDL operations.
