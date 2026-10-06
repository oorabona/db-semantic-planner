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
  over the supported `SELECT` list and `WHERE` clause. Unsupported body modifiers are refused at `plan()` on the root SELECT WHERE route. Mutations and the other direct routes refuse them at compilation. Inner table
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
| No FK + `exists('table', { where })` | `exists('auditLog', { where: ... })` from unrelated table | Refuses undeclared relation at `plan()` |

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

A subquery body in query WHERE resolves `outerRef()` against its immediately enclosing query when unqualified. Qualified references search enclosing queries nearest first: in each query, a written include key wins, then an exact emitted qualifier; otherwise the logical table must have exactly one range in that query. Multiple ranges are refused as ambiguous, naming their aliases:

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

### Undeclared relations refuse during planning

`exists('auditLog', { where: ... })` requires a declared relation from the source table. Without it, `plan()` refuses and suggests `rawExists(subquery(...))`; `.dump()` reports the same refusal before SQL emission. A declared relation also needs declared foreign keys. Use the explicit subquery above for the polymorphic case.

---

## Known limitations

### Correlation scope

Query WHERE subquery bodies support `outerRef()` for scalar comparisons, `inSubquery()` and `rawExists()`. Nested same-table `rawExists()` bodies compile with distinct generated aliases and share parameter numbering. Unqualified `outerRef()` binds to the immediately enclosing query; qualified `outerRef('posts.id')` searches enclosing queries nearest first. In each query, a written include key wins, then an exact emitted qualifier; otherwise a logical-table match requires exactly one range of that table in that query. Multiple ranges are refused as ambiguous, naming their aliases; no match in any enclosing query is refused as not visible. A manual `.join()` qualifier repeating an emitted range (root, implicit or explicit alias) is refused; the root logical name is also reserved. Generated subquery aliases are reallocated. Root WHERE resolves correlation even alongside dotted relation paths; see [WHERE qualifiers](./joins#where-qualifiers-and-planning). Direct outer references in join include `where` search its immediate source and then ancestor scopes. Correlated bodies in `rawExists`, `rawNotExists`, `inSubquery`, and scalar comparisons inside include `where` retain their legacy refusals at `plan()`; uncorrelated bodies remain supported. Legacy `compilePlan()` lowering (from `@dbsp/adapter-pgsql/internal`) retains its correlation restrictions.

### Relation predicate limits

Undeclared relations, missing declared keys, many-to-many traversal and recursive relation predicates refuse at `plan()`. `exists()` can join declared relations through its `include` option; arbitrary subquery joins and HAVING remain unsupported.

### JOIN-inside-subquery and HAVING-aggregate-inside-subquery

`rawExists()` does not support arbitrary joins or HAVING inside its body. For those patterns, use raw SQL via the adapter's escape
hatch or restructure the query as a lateral join.

---

## Related

- [Relations & Includes](./includes.md) — relation-based data loading (not filtering)
- [Expression Primitives](./expression-primitives.md) — `outerRef()`, `op()`, `ref()`, `cast()`
- [Joins](./joins.md) — manual JOIN API as an alternative to EXISTS for filter-with-data patterns
- [ORM API Reference](/api/orm-api) — `subquery()` builder full reference

Compilation follows [Authored intent and execution authority](./observability.md#authored-intent-and-execution-authority).
