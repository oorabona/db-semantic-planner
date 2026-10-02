---
title: Row-Level Security Policies
---

# How to Use Row-Level Security Policies

Build the declared schema with `createPgPhysicalModel` before DDL or comparison.
Under a casing rule, table and policy identifiers are derived there once; policy
`USING` and `WITH CHECK` expressions remain physical SQL and are not rewritten.
Column names inside the expressions must use their database names after
`dbCasing`; identifiers inside the SQL text are not rewritten. For a `tenantId`
column under `snake_case`, write `tenant_id` in both expressions.

Row-Level Security (RLS) lets PostgreSQL enforce access control at the row level, so different database roles see only the rows they are allowed to see. Use this guide when you need multi-tenant isolation or per-role data filtering enforced at the database layer rather than in application code.

## When

When you need multi-tenant isolation or row-level access control at the database level.

## Steps

### 1. Enable RLS on a table

In your schema definition (ModelIR):

```typescript
const schema = {
  tables: {
    tenants: {
      columns: {
        id: { type: 'uuid' },
        tenant_id: { type: 'uuid' },
        name: { type: 'text' },
      },
      rlsEnabled: true,
      policies: [
        {
          name: 'tenant_isolation',
          command: 'ALL',
          roles: ['app_user'],
          using: "tenant_id = current_setting('app.current_tenant')::uuid",
          withCheck: "tenant_id = current_setting('app.current_tenant')::uuid",
        },
      ],
    },
  },
};
```

### 2. Generated SQL

```sql
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "tenants"
  AS PERMISSIVE
  FOR ALL
  TO app_user
  USING (tenant_id = current_setting('app.current_tenant')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);
```

### 3. Schema migrations

`compareSchemata()` detects:

- RLS enabled/disabled changes → `ALTER TABLE ENABLE/DISABLE ROW LEVEL SECURITY`
- New policies → `CREATE POLICY`
- Removed policies → `DROP POLICY`
- Changed policies → `DROP + CREATE` (policies are replaced, not altered)

### 4. Multi-dialect support

RLS is gated by `supportsDDLRowLevelSecurity` capability flag:

| Adapter     | Supported |
|-------------|-----------|
| PostgreSQL  | Yes       |
| MySQL       | No (policies silently skipped) |
| SQLite      | No (policies silently skipped) |
| DuckDB      | No (policies silently skipped) |

## Key files

- `packages/types/src/model-ir.ts` — `PolicyIR` interface
- `packages/adapter-pgsql/src/ddl/ddl-generator.ts` — DDL generation
- `packages/adapter-pgsql/src/ddl/schema-diff.ts` — Schema comparison
- `packages/adapter-pgsql/src/introspection.ts` — Read existing policies from `pg_policy`

## Gotchas

- `using` and `withCheck` are raw SQL strings and are not parameterized. `validateSqlExpression` lexically rejects semicolons, `--`, `/*`, `*/`, `$$`, and backslashes, including when those tokens occur inside quoted literals; it does not parse PostgreSQL expression syntax.
- Policy names must be unique per table
- `PERMISSIVE` is the default; set `permissive: false` for `RESTRICTIVE` policies
- Introspection reads from `pg_policy` catalog — requires appropriate privileges
- Phase ordering: RLS enable (phase 17) runs before policy creation (phase 18) — never reversed
- Changed policies are replaced (DROP + CREATE), not altered — no `ALTER POLICY` is emitted
