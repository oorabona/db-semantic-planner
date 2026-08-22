# How to write E2E / real-DB integration tests

## When

When a change must be validated against a **real PostgreSQL** — verifying the actual rows returned, not just the compiled SQL string. Unit tests under `packages/*/src` are compile-only (they assert SQL/params); E2E tests prove the *result*.

## Where & how to run

- **Location:** `tests/e2e/*.test.ts`
- **Run:** `pnpm test:e2e` (vitest config `tests/e2e/vitest.config.e2e.ts`)
- One shared Postgres container starts once (`tests/e2e/globalSetup.ts`), reused across files (`fileParallelism: false`).
- **Image:** default `ghcr.io/oorabona/postgres:18-alpine-full`, overridable via `POSTGRES_IMAGE`.
- **WSL2/Podman:** export `TESTCONTAINERS_RYUK_DISABLED=true` (CI sets it in `ci.yml` e2e job).

## Catalogue PostgreSQL version matrix

The `Catalogue PostgreSQL matrix` workflow (`.github/workflows/catalogue-matrix.yml`) runs `tests/matrix/catalogue-matrix.test.ts` against PostgreSQL 10, 11, 14, and 18. It is intentionally separate from `pnpm test:unit` and the Testcontainers E2E suite: the test proves real `pg_catalog` shapes that a mock cannot represent.

Build the matrix dependency closure, then run it only against a disposable PostgreSQL database whose role can create and drop schemas:

```sh
pnpm --filter @dbsp/adapter-pgsql... build
MATRIX_DATABASE_URL=postgres://dbsp:dbsp@127.0.0.1:5432/dbsp pnpm vitest run --config tests/matrix/vitest.config.ts
```

Each run creates a schema with an unpredictable identifier-safe suffix and makes a best-effort cleanup only after it has confirmed ownership. A disconnect after PostgreSQL commits `CREATE SCHEMA` but before the client receives success can leave that random schema in the disposable database. Do not point it at a shared database: the role needs schema DDL privileges and the database should be disposable. Without a non-blank `MATRIX_DATABASE_URL`, it collects as a loudly skipped suite locally; CI refuses collection unless `MATRIX_ALLOW_SKIP=1` explicitly allows the skip.

## The testkit (`tests/e2e/testkit/`)

| Helper | Use |
|--------|-----|
| `getTestPool()` | shared `pg.Pool` on the live container |
| `getTestAdapter()` | `createPgsqlAdapter(pool)` on the live pool |
| `createSchema(name)` / `dropSchema(name)` | per-test schema isolation |
| `execInSchema(name, sql)` / `sql\`...\`.execute(pool)` | DDL + seed via tagged templates |
| `closeTestDb()` | teardown |

Per-domain DDL/seed live next to the tests (e.g. `testkit/blog.ddl.ts`, `*.seed.ts`).

## Pattern (seed → execute → assert rows)

```ts
import { and, createOrm, eq, exists } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestAdapter, createBlogSchema, dropBlogSchema, seedBlogData, closeTestDb, blogModel } from './testkit/index.js';

describe('exists() filter', () => {
  beforeAll(async () => { await dropBlogSchema('t'); await createBlogSchema('t'); await seedBlogData('t'); });
  afterAll(async () => { await dropBlogSchema('t'); await closeTestDb(); });

  it('returns only authors with a published post', async () => {
    const orm = createOrm({ model: blogModel, adapter: await getTestAdapter() });
    const rows = await orm.withSchema('t').select('authors')
      .where(exists('posts', { where: eq('published', true) }))
      .columns(['id', 'name']).execute();        // ← runs against the live DB
    expect(rows.map(r => r.name)).toEqual(['Alice']); // ← assert actual rows
  });
});
```

`.execute()` compiles the plan and runs `pool.query(sql, params)`, returning real rows.

## Correctness-test design rule

To prove a filtering fix (broadening, wrong FK correlation, quantifier), **seed data that discriminates**: include rows that a *buggy* compilation would wrongly include/exclude, so the row assertion fails if the bug returns. A test that only seeds matching rows can't catch broadening.

See `tests/e2e/pimdam.q1.exists.test.ts` for a worked EXISTS example.
