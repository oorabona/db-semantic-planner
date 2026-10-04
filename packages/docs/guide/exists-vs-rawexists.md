---
title: exists() vs rawExists()
---

# How to choose between exists() and rawExists()

`exists()` and `rawExists()` both compile to SQL `EXISTS (SELECT ...)` but they
differ fundamentally in *where the schema knowledge comes from*.

- **`exists('relation', { where })`** — the planner looks up the declared FK relation,
  auto-emits the join predicate, and weaves in your extra `where` conditions. This is
  the safe, type-guided path when the FK is declared in the schema.

- **`rawExists(subquery(...))`** — you build the subquery explicitly, with control
  over the `SELECT` list, `WHERE` clause, and any inner aggregation. Inner table
  aliases are generated distinctly within PostgreSQL’s 63-byte limit. The wrapper
  does not correlate its target with the parent. Relation predicates inside the
  body still resolve declared keys and model casts. This is the escape hatch for
  polymorphic tables, ad-hoc cross-schema references, and any target table that has no `ref()` declared toward the source.

## When

Use this table to decide which API to reach for:

| Situation | Recommended API |
|-----------|-----------------|
| Target table has a `ref()` FK to the source | `exists('relation', { where })` |
| Cross-column comparison across FK tables (`f.lastParsed > c.createdAt`) | `exists('relation', { where: gt(..., outerRef(...)) })` |
| Target table has **no FK** to the source (polymorphic, ad-hoc) | `rawExists(subquery(...))` |
| You need control over the inner `SELECT` list (e.g. `select('1')` vs `select(['col'])`) | `rawExists(subquery(...))` |
| You want to correlate with `outerRef()` **and** there is no FK | `rawExists(subquery(...).where(...))` |

## Cheat sheet

| Use case | API | Status |
|----------|-----|--------|
| FK-declared relation, simple existence check | `exists('files')` | Works |
| FK-declared relation + cross-column `where` | `exists('files', { where: gt('lastParsed', outerRef('createdAt')) })` | Works |
| FK-declared relation + `rawExists` + `outerRef` | `rawExists(subquery('files').select('id').where(gt(..., outerRef(...))))` | Works in query WHERE |
| No FK (polymorphic), plain filter | `rawExists(subquery('auditLog').select('id').where(eq('entityType', 'login')))` | Works |
| No FK + `outerRef` correlation inside `rawExists` | `rawExists(subquery('t').select('id').where(eq('col', outerRef(...))))` | Works in query WHERE |
| No FK + `exists('table', { where })` | `exists('auditLog', { where: ... })` from unrelated table | Silently drops WHERE today |

---

## Case 1 — cross-column comparison (the FK-declared common case)

**Scenario:** a community is "active" when it has at least one file parsed _after_
the community was created. The FK `files.communityId → communities.id` is declared
in the schema.

`exists('files', { where })` is the right tool: the planner auto-emits the FK join
predicate (`communities.id = files_exists_0."communityId"`) and appends your custom
`where` condition as an additional `AND`.

```typescript
import { schema, ref, createOrm, exists, gt, outerRef } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __existsDb = schema({
  communities: {
    id: { type: 'integer', primaryKey: true },
    createdAt: 'timestamp',
  },
  files: {
    id: { type: 'integer', primaryKey: true },
    communityId: ref('communities'),
    lastParsed: 'timestamp',
  },
} as const);

const __existsOrm = createOrm({
  schema: __existsDb,
  adapter: createPgCompileOnlyAdapter(),
});

const dump = (__existsOrm as any)
  .select('communities')
  .where(exists('files', { where: gt('lastParsed', outerRef('createdAt')) }))
  .dump();

expect(dump.sql).toBe('SELECT communities.* FROM communities WHERE EXISTS (SELECT 1 FROM files AS files_exists_0 WHERE communities.id = files_exists_0."communityId" AND files_exists_0."lastParsed" > communities."createdAt")');
```

Key observations:

- The FK join condition is **auto-emitted** — you do not write it.
- `outerRef('createdAt')` resolves to the outer table alias (`communities."createdAt"`).
- No bound parameters — both sides of `>` are column references, not values.

### Explicit correlation with rawExists()

A subquery body in query WHERE resolves `outerRef()` against its immediately enclosing query when unqualified. Qualified references search enclosing queries nearest first: an exact emitted qualifier wins; otherwise the logical table must have exactly one range in that query. Multiple ranges are refused as ambiguous, naming their aliases:

```typescript
import { createOrm, rawExists, subquery, gt, outerRef, ref, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __rawExistsCorrelatedDb = schema({
  communities: { id: { type: 'integer', primaryKey: true }, createdAt: 'timestamp' },
  files: { id: { type: 'integer', primaryKey: true }, communityId: ref('communities'), lastParsed: 'timestamp' },
} as const);

const __rawExistsCorrelatedOrm = createOrm({
  schema: __rawExistsCorrelatedDb,
  adapter: createPgCompileOnlyAdapter(),
});

__rawExistsCorrelatedOrm
  .select('communities')
  .where(rawExists(subquery('files').select('id').where(gt('lastParsed', outerRef('createdAt')))))
  .dump();
```

Generated SQL:

```sql
SELECT communities.* FROM communities WHERE EXISTS (SELECT files_sq.id FROM files AS files_sq WHERE files_sq."lastParsed" > communities."createdAt")
```

**Use `exists('relation', { where })` whenever you have an FK-declared relation.**

---

## Case 2 — no FK relation (polymorphic / ad-hoc)

**Scenario:** filter users who have a `login` entry in `auditLog`. The `auditLog`
table uses a polymorphic pattern (`entityType` + `entityId`) with no `ref()` to
`users`, so `exists()` cannot resolve the relation.

`rawExists(subquery(...))` is the right tool here — you build the subquery explicitly
with the filter you want:

```typescript
import { createOrm, rawExists, subquery, eq, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __rawExistsDb = schema({
  users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
  auditLog: { id: { type: 'integer', primaryKey: true }, entityType: 'text', entityId: 'integer' },
} as const);

const __rawExistsOrm = createOrm({
  schema: __rawExistsDb,
  adapter: createPgCompileOnlyAdapter(),
});

const dump = (__rawExistsOrm as any)
  .select('users')
  .where(rawExists(subquery('auditLog').select('id').where(eq('entityType', 'login'))))
  .dump();

// SQL produced:
//   SELECT users.* FROM users
//   WHERE EXISTS (
//     SELECT "auditLog_sq".id FROM "auditLog" AS "auditLog_sq"
//     WHERE "auditLog_sq"."entityType" = $1
//   )
// params: ["login"]
```

### Why exists() does NOT work for this case today

Passing an undeclared relation name to `exists()` silently drops the entire `WHERE`
clause — you get a plain `SELECT * FROM users` with no filter:

```typescript
// doctest: skip — illustrative: shows the silent-drop bug for undeclared relations
import { createOrm, exists, eq, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __existsSilentDb = schema({
  users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
  auditLog: { id: { type: 'integer', primaryKey: true }, entityType: 'text', entityId: 'integer' },
} as const);

const __existsSilentOrm = createOrm({
  schema: __existsSilentDb,
  adapter: createPgCompileOnlyAdapter(),
});

const dump = (__existsSilentOrm as any)
  .select('users')
  // auditLog has no ref() to users → planner cannot resolve → WHERE dropped silently
  .where(exists('auditLog', { where: eq('entityType', 'login') }))
  .dump();

// dump.sql === 'SELECT users.* FROM users'   ← no WHERE clause at all
```

This is a known limitation tracked in TODO.md — ideally `exists()` should throw when
the relation is not declared. Until then, always use `rawExists(subquery(...))` for
polymorphic or ad-hoc join targets.

---

## Known limitations

### Correlation scope

Query WHERE subquery bodies support `outerRef()` for scalar comparisons, `inSubquery()` and `rawExists()`. Nested same-table `rawExists()` bodies compile with distinct generated aliases and share parameter numbering. Unqualified `outerRef()` binds to the immediately enclosing query; qualified `outerRef('posts.id')` searches enclosing queries nearest first. An exact emitted qualifier wins; otherwise a logical-table match requires exactly one range of that table in that query. Multiple ranges are refused as ambiguous, naming their aliases; no match in any enclosing query is refused as not visible. A manual `.join()` qualifier repeating an emitted range (root, implicit or explicit alias) is refused; the root logical name is also reserved. Generated subquery aliases are reallocated. Legacy `compilePlan()` lowering retains its correlation refusal, and so does a query WHERE that also contains a dotted relation path such as `eq('caller.name', 'Ada')`, or a join include's `where`: both still compile through the earlier route.

### `exists()` silently drops the WHERE for undeclared relations

When the relation name passed to `exists('table', { where })` has no `ref()` declared
toward the source table, the planner silently drops the entire `WHERE` clause and emits
a plain SELECT. There is no compile-time error today. Always use `rawExists(subquery())`
when no FK is declared.

This behavior is locked by the TNR test in
`packages/adapter-pgsql/src/__tests__/exists-vs-rawexists-comparison.test.ts` so that
any future change (e.g., making `exists()` throw instead) will fail that test loudly.

### JOIN-inside-subquery and HAVING-aggregate-inside-subquery

Neither `exists()` nor `rawExists()` supports a join or a HAVING aggregate clause
inside the subquery today. For those patterns, use raw SQL via the adapter's escape
hatch or restructure the query as a lateral join.

---

## Related

- [Relations & Includes](./includes.md) — relation-based data loading (not filtering)
- [Expression Primitives](./expression-primitives.md) — `outerRef()`, `op()`, `ref()`, `cast()`
- [Joins](./joins.md) — manual JOIN API as an alternative to EXISTS for filter-with-data patterns
- [ORM API Reference](/api/orm-api) — `subquery()` builder full reference
