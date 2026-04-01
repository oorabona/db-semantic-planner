# Getting Started with db-semantic-planner

`@dbsp/core` is an intent-first query planner for PostgreSQL: you declare what data you need, the planner decides how to fetch it, and every decision is inspectable. This guide takes you from installation to your first production-ready query in about 15 minutes.

---

## Step 1: Install

```bash
pnpm add @dbsp/core @dbsp/adapter-pgsql pg
```

`pg` is the PostgreSQL client — install it alongside the adapter.

---

## Step 2: Define Your Schema

```typescript
import { schema, ref } from '@dbsp/core';

const db = schema({
  users: {
    id: { type: 'uuid', primaryKey: true },
    name: 'string',
    email: { type: 'string', unique: true },
    active: { type: 'boolean', default: 'true' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  posts: {
    id: { type: 'uuid', primaryKey: true },
    title: 'string',
    content: { type: 'text', nullable: true },
    authorId: ref('users', { onDelete: 'CASCADE', inverse: 'posts' }),
    published: { type: 'boolean', default: 'false' },
    createdAt: { type: 'timestamp', default: 'now()' },
  },
  comments: {
    id: { type: 'uuid', primaryKey: true },
    text: 'string',
    postId: ref('posts', { onDelete: 'CASCADE' }),
    authorId: ref('users'),
    createdAt: { type: 'timestamp', default: 'now()' },
  },
});
```

`ref()` declares a foreign-key relation. The planner auto-infers `belongsTo` (N:1) and `hasMany` (1:N) directions from FK placement. `nullable: true` in a column definition makes the column optional — the TypeScript type becomes `T | null`.

---

## Step 3: Connect to PostgreSQL

```typescript
import { createOrm } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const orm = createOrm({
  schema: db,
  adapter: createPgsqlAdapter(pool),
});
```

That is the full setup. `createOrm` returns a typed ORM instance where every table name and column is autocompleted from your schema.

---

## Step 4: Your First Query

```typescript
import { eq } from '@dbsp/core';

// Returns User[] — fully typed from schema
const activeUsers = await orm.select('users')
  .where(eq('active', true))
  .orderBy('name')
  .all();

// first() returns User | undefined
const alice = await orm.select('users')
  .where(eq('email', 'alice@example.com'))
  .first();

// firstOrThrow() throws NotFoundError when nothing matches
const user = await orm.select('users')
  .where(eq('id', someId))
  .firstOrThrow();
```

Types flow automatically from the schema definition through every call in the chain. The return type of `.all()` is `Promise<Array<{ id: string; name: string; email: string; active: boolean; createdAt: Date }>>` — no manual type annotation needed.

Common filter helpers: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `inArray`, `isNull`, `isNotNull`, `and`, `or`, `not`.

---

## Step 5: Include Relations

```typescript
import { eq } from '@dbsp/core';

// Load users with their posts (nested hydration)
const users = await orm.select('users')
  .where(eq('active', true))
  .include('posts')
  .all();
// users[0].posts — Post[]

// Deep nesting with dot notation
const users = await orm.select('users')
  .include('posts.comments')
  .all();
// users[0].posts[0].comments — Comment[]

// Filter and select within an include
const users = await orm.select('users')
  .include('posts', {
    where: eq('published', true),
    select: { type: 'fields', fields: ['id', 'title'] },
  })
  .all();
```

The planner selects the optimal fetch strategy (`json_agg`, lateral join, or separate query) based on the query shape. You do not choose the strategy — that is the planner's job.

---

## Step 6: Mutations

All mutations require an explicit `.execute()` call. Use `.returning()` to get back column values.

```typescript
import { eq } from '@dbsp/core';

// Insert a single row
const [newUser] = await orm.insert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .returning(['id', 'name', 'createdAt'])
  .execute();

// Update rows matching a condition
await orm.update('users')
  .set({ active: false })
  .where(eq('email', 'alice@example.com'))
  .execute();

// Delete rows matching a condition
await orm.delete('posts')
  .where(eq('published', false))
  .execute();

// Upsert — insert or update on conflict
await orm.upsert('users')
  .values({ name: 'Alice', email: 'alice@example.com', active: true })
  .onConflict(['email'])
  .doUpdate()
  .execute();
```

`update()` and `delete()` require a `.where()` clause — omitting it throws `UnsafeOperationError`. Use `updateAll()` / `deleteAll()` when you explicitly intend to affect every row.

---

## Step 7: Observability with dump()

Every query builder exposes `.dump()`. It compiles the query without executing it and returns the full plan, SQL, and bound parameters.

```typescript
import { eq } from '@dbsp/core';

const dump = orm.select('users')
  .where(eq('active', true))
  .include('posts')
  .dump();

console.log(dump.sql);
// SELECT "t0"."id", "t0"."name", ..., json_agg(...) AS "posts"
// FROM "users" AS "t0"
// LEFT JOIN "posts" AS "t1" ON "t1"."author_id" = "t0"."id"
// WHERE "t0"."active" = $1
// GROUP BY "t0"."id"

console.log(dump.params);
// [true]

console.log(dump.plan.decisions);
// [{ type: 'include-strategy', relation: 'posts', choice: 'json_agg', reason: '...' }]

console.log(dump.plan.warnings);
// [] — empty means no performance concerns
```

`dump()` is safe to call in tests and logging pipelines — no database connection required.

---

## Step 8: Multi-Tenant Queries

`orm.withSchema()` scopes every query and mutation to a PostgreSQL schema (namespace). This is the standard pattern for row-level tenant isolation.

```typescript
// All queries against tenant_42's schema
const tenantOrm = orm.withSchema('tenant_42');

const users = await tenantOrm.select('users').all();
// SQL: SELECT * FROM "tenant_42"."users"

await tenantOrm.insert('users')
  .values({ name: 'Bob', email: 'bob@tenant42.com' })
  .execute();
// SQL: INSERT INTO "tenant_42"."users" ...
```

Schema names are validated as identifiers before use.

---

## Step 9: Pagination

```typescript
import { eq } from '@dbsp/core';

// Offset-based pagination
const page = await orm.select('posts')
  .where(eq('published', true))
  .orderBy('createdAt', 'desc')
  .paginate({ page: 1, perPage: 20 });

// page.data              — Post[]
// page.pagination.total       — total row count
// page.pagination.totalPages  — number of pages
// page.pagination.hasNextPage — boolean

// Cursor-based pagination (stable under concurrent inserts)
const first = await orm.select('posts')
  .orderBy('createdAt', 'desc')
  .cursorPaginate({ first: 20 });

// first.data       — Post[]
// first.nextCursor — opaque cursor string

const second = await orm.select('posts')
  .orderBy('createdAt', 'desc')
  .cursorPaginate({ first: 20, after: first.nextCursor });
```

Prefer cursor pagination for feeds and infinite scroll — it remains stable when rows are inserted between pages. Offset pagination is simpler to expose in REST APIs.

---

## Step 10: What's Next

- **Expression primitives** — `op()`, `fn()`, `ref()`, `cast()`, vector distance, ParadeDB search: [how-to-use-expression-primitives.md](./how-to-use-expression-primitives.md)
- **Manual joins** — flat `JOIN` without nested hydration, self-joins, explicit ON conditions: [how-to-use-joins.md](./how-to-use-joins.md)
- **DDL helpers** — `truncate`, `vacuum`, `alterColumn`, index management: [how-to-use-ddl-helpers.md](./how-to-use-ddl-helpers.md)
- **Recursive CTEs** — tree traversal with ancestors/descendants: [how-to-use-recursive-cte.md](./how-to-use-recursive-cte.md)
- **Full API reference** — complete method listing with all options: [orm-api.md](./orm-api.md)
