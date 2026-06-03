# Examples

Eight realistic schemas with full assertions, DDL, seed data, and NQL sessions. Use them to learn the framework hands-on, to copy-paste a starting point for your own project, or to verify a feature against real data.

## Index

| Domain | Demonstrates | Files |
|---|---|---|
| **`minimal`** | The smallest possible schema and query | `minimal.{dbsp,ddl.sql,seed.sql,schema.ts}` |
| **`blog`** | M:N relations (postTags), aggregates (count, sum, avg), group by, distinct, soft mutations | `blog.{dbsp,assert.dbsp,ddl.sql,seed.sql,schema.ts}` |
| **`blog-extended`** | Same domain with advanced patterns (relation disambiguation, deeper joins) | `blog-extended.{dbsp,assert.dbsp,ddl.sql,seed.sql,schema.ts}` |
| **`ecommerce`** | Orders, products, line items, inventory — typical e-commerce shape | `ecommerce.{dbsp,assert.dbsp,ddl.sql,seed.sql,schema.ts}` |
| **`iam`** | Identity & access management — junction tables, edge-table hierarchy, dual-FK disambiguation, self-ref adjacency, SoD rules, audit trail | `iam.{dbsp,assert.dbsp,ddl.sql,seed.sql,schema.ts}` |
| **`hierarchy`** | Self-referential relations and recursive CTE traversal | `hierarchy.{dbsp,assert.dbsp,ddl.sql,seed.sql,schema.ts}` |
| **`scheduling`** | Time-slot booking patterns | `scheduling.{dbsp,assert.dbsp,ddl.sql,seed.sql,schema.ts}` |
| **`pimdam`** | PIM/DAM schema — soft deletes, complex M:N, multi-locale, advanced querying | `pimdam.{dbsp,assert.dbsp,ddl.sql,seed.sql,schema.ts}` |
| **`advanced-patterns`** | Combined techniques (CTEs, window functions, aggregates) | `advanced-patterns.{dbsp,assert.dbsp}` |

The `test-*.dbsp` files are CLI test fixtures used by the data-plane integration tests, not pedagogical examples.

## File types

Each domain typically ships five files:

- **`<name>.schema.ts`** — TypeScript schema definition using `schema()` and `ref()` from `@dbsp/core`. Drop it into your codebase to use the same shape.
- **`<name>.ddl.sql`** — DDL to create the tables. Run against an empty PostgreSQL schema.
- **`<name>.seed.sql`** — INSERT statements with realistic data. Run after the DDL.
- **`<name>.dbsp`** — REPL session : NQL queries, CLI dot-commands (`.use`, `.import`, `.tables`), mutations terminated with `!`. Read top-to-bottom as a guided tour, or run end-to-end against a live database.
- **`<name>.assert.dbsp`** — assertion file pinned to the matching `.dbsp` session. Each block (`--- query: N`) verifies the SQL, parameters, and (when DB-backed) the rows returned.

## Run an example

```bash
# Spin up a local PostgreSQL (any way you like) — for example:
docker run -d --rm --name dbsp-pg -e POSTGRES_PASSWORD=demo -p 5432:5432 postgres:18

# Run the blog example end-to-end
pnpm dbsp repl \
  --schema ./examples/blog.schema.ts \
  --db postgresql://postgres:demo@localhost:5432/postgres \
  --input ./examples/blog.dbsp
```

The CLI will execute every line of `blog.dbsp` against the database. Add `--assert ./examples/blog.assert.dbsp` to validate every query against the pinned expectations.

## Learn from the format

The `.dbsp` files are not just demos — they are the canonical NQL syntax reference for queries, mutations, and CLI commands. Browsing one of them is the quickest way to internalise the pipe syntax, the `select *, relation.*` shape for includes, and the `insert/update/delete` mutation forms. Pair with the [Querying guide](../packages/docs/guide/queries.md) and the [CLI usage guide](../packages/docs/guide/cli-usage.md) for prose explanations of what each pattern does.

## Where to go next

- New to dbsp? Start with `minimal.dbsp`, then `blog.dbsp`.
- Building a real app? Pick the closest domain (`ecommerce`, `iam`, `pimdam`) and adapt the `.schema.ts` file.
- Implementing a feature in the framework? The `.assert.dbsp` files are runnable spec ; look there for examples of every supported intent shape.
