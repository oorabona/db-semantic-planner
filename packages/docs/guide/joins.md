---
title: Manual Joins
---

# How to Use Manual Joins

The `.join()` method adds a flat SQL JOIN to a query without triggering the nested-object hydration that `include()` performs. Use it when you need to filter the root table by a condition on a related table, perform a self-join, or join a table that has no declared foreign-key relation in your schema.

A relation predicate filters with `EXISTS` or `NOT EXISTS`. Use `.join()` to order, group or select by a related table’s columns.

## When

When you need a flat, non-hydrating SQL JOIN on the root query — cross-table filtering,
self-joins, or joining tables that have no declared FK relation. Unlike `include()`, which
hydrates nested objects, `.join()` merges columns into a flat result row.

Use `.join()` when:
- You need to filter the root table by a condition on a related table (semi-join / anti-join pattern)
- You need a self-join (e.g. comparing rows in the same table)
- The join target has no FK relation declared in the schema
- You want flat rows (not nested objects)

Use `include()` instead when you want nested hydration (e.g. `user.posts[]`).

## API

```typescript
// doctest: skip — API signature reference (TypeScript function signature, not executable code)
// Overload 1 — Relation mode: FK auto-resolved from schema
.join(relationPath: string, opts?: {
  type?: 'inner' | 'left';            // default: 'inner', applied to every hop
  as?: string | readonly string[];    // last hop's alias, or one alias per hop
}): QueryBuilder<TResult>

// Overload 2 — Table mode: explicit table + ON condition
.join(table: string, opts: {
  on: WhereIntent;          // required — ON condition (use eq, lt, and, etc.)
  type?: 'inner' | 'left';  // default: 'inner'
  as?: string;              // alias for the joined table (required for self-joins)
}): QueryBuilder<TResult>
```

**Mode discrimination:** the presence of `opts.on` determines the mode.
- **No `on`** → relation mode: the first argument is a relation name defined in the schema,
  or a dotted relation path (`'callee.file'`); the FK columns and target tables are resolved
  automatically, one JOIN per relation (see [Relation paths](#_9-relation-paths-several-hops)).
- **With `on`** → table mode: the first argument is a raw table name; the ON condition
  must be provided explicitly.

The builder is **immutable** — each `.join()` call returns a new `QueryBuilder` instance.
Chaining multiple `.join()` calls accumulates joins in order.

## Examples

### 1. Basic relation join (FK auto-resolved)

Given a schema with `calls.caller_id → symbols`:

```typescript
import { createOrm, ref, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __joinsDb = schema({
  calls: {
    id: 'integer',
    callerId: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
    calleeId: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
  },
  symbols: {
    id: 'integer',
    name: 'string',
    score: 'integer',
  },
  embeddings: {
    id: 'integer',
    vector: 'string',
  },
} as const);
const orm = createOrm({ schema: __joinsDb, adapter: createPgCompileOnlyAdapter() });

const results = await orm.select('calls')
  .join('caller')
  .dump();
```

Generated SQL:
```sql
SELECT calls.*
FROM (calls JOIN symbols AS caller ON caller_id = caller.id) caller
```

The FK column (`caller_id`) and target table (`symbols`) are resolved from the schema.
The default join type is `INNER JOIN`.

> **Why the parenthesized FROM with an outer alias?** The compiler wraps the join pair in
> parentheses and re-aliases the result (`... caller`) so that outer clauses (WHERE, ORDER BY,
> additional joins) can reference the join result as a named unit. This mirrors PostgreSQL's
> associativity rules for chained joins and ensures column references remain unambiguous when
> multiple joins are stacked (see Example 4).

### 2. Left join (keep root rows without a match)

```typescript
import { createOrm, ref, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __joinsDb = schema({
  calls: {
    id: 'integer',
    callerId: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
    calleeId: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
  },
  symbols: {
    id: 'integer',
    name: 'string',
    score: 'integer',
  },
  embeddings: {
    id: 'integer',
    vector: 'string',
  },
} as const);
const orm = createOrm({ schema: __joinsDb, adapter: createPgCompileOnlyAdapter() });

const results = await orm.select('calls')
  .join('callee', { type: 'left' })
  .dump();
```

Generated SQL:
```sql
SELECT calls.*
FROM (calls LEFT JOIN symbols AS callee ON callee_id = callee.id) callee
```

Use `type: 'left'` when root rows without a matching related row should still appear
(with NULL columns for the joined side).

### 3. Join with WHERE on root table

`.join()` and `.where()` compose freely. The WHERE applies after the join:

```typescript
import { createOrm, eq, ref, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __joinsDb = schema({
  calls: {
    id: 'integer',
    callerId: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
    calleeId: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
  },
  symbols: {
    id: 'integer',
    name: 'string',
    score: 'integer',
  },
  embeddings: {
    id: 'integer',
    vector: 'string',
  },
} as const);
const orm = createOrm({ schema: __joinsDb, adapter: createPgCompileOnlyAdapter() });

const results = await orm.select('calls')
  .join('caller')
  .where(eq('id', 42))
  .dump();
```

Generated SQL:
```sql
SELECT calls.*
FROM (calls JOIN symbols AS caller ON caller_id = caller.id) caller
WHERE "calls"."id" = $1
-- params: [42]
```

### 4. Multiple chained joins

Chain `.join()` calls to add more than one join. They accumulate left-to-right:

```typescript
import { createOrm, ref, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __joinsDb = schema({
  calls: {
    id: 'integer',
    callerId: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
    calleeId: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
  },
  symbols: {
    id: 'integer',
    name: 'string',
    score: 'integer',
  },
  embeddings: {
    id: 'integer',
    vector: 'string',
  },
} as const);
const orm = createOrm({ schema: __joinsDb, adapter: createPgCompileOnlyAdapter() });

const results = await orm.select('calls')
  .join('caller')
  .join('callee', { type: 'left' })
  .dump();
```

Generated SQL:
```sql
SELECT calls.*
FROM ((calls JOIN symbols AS caller ON caller_id = caller.id) caller
      LEFT JOIN symbols AS callee ON callee_id = callee.id) callee
```

### 5. Self-join with alias (table mode)

When joining a table to itself, provide `as` (required to disambiguate) and an explicit
`on` condition using `ref()` for column references:

```typescript
import { createOrm, eq, ref, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __joinsDb = schema({
  calls: {
    id: 'integer',
    callerId: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
    calleeId: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
  },
  symbols: {
    id: 'integer',
    name: 'string',
    score: 'integer',
  },
  embeddings: {
    id: 'integer',
    vector: 'string',
  },
} as const);
const orm = createOrm({ schema: __joinsDb, adapter: createPgCompileOnlyAdapter() });

// Find all pairs where embeddings.id < e2.id
const results = await orm.select('embeddings')
  .join('embeddings', {
    on: { kind: 'comparison', field: 'embeddings.id', operator: 'lt',
          value: { kind: 'fieldRef', column: 'id', scope: 'outer' } },
    as: 'e2',
    type: 'inner',
  })
  .dump();
```

Generated SQL:
```sql
SELECT embeddings.*
FROM embeddings JOIN embeddings AS e2 ON embeddings.id < e2.id
```

For simpler equality ON conditions you can use the `eq` filter helper directly. Use
dotted `'table.column'` notation to qualify column references in the ON condition:

```typescript
import { createOrm, eq, ref, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __joinsDb = schema({
  calls: {
    id: 'integer',
    callerId: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
    calleeId: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
  },
  symbols: {
    id: 'integer',
    name: 'string',
    score: 'integer',
  },
  embeddings: {
    id: 'integer',
    vector: 'string',
  },
} as const);
const orm = createOrm({ schema: __joinsDb, adapter: createPgCompileOnlyAdapter() });

// Explicit equality ON condition
const results = await orm.select('embeddings')
  .join('embeddings', {
    on: eq('embeddings.id', 1),
    as: 'e2',
    type: 'inner',
  })
  .dump();
```

### 6. Relation mode with custom alias

Use `as` to override the alias the joined table receives in the query:

```typescript
import { createOrm, ref, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __joinsDb = schema({
  calls: {
    id: 'integer',
    callerId: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
    calleeId: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
  },
  symbols: {
    id: 'integer',
    name: 'string',
    score: 'integer',
  },
  embeddings: {
    id: 'integer',
    vector: 'string',
  },
} as const);
const orm = createOrm({ schema: __joinsDb, adapter: createPgCompileOnlyAdapter() });

const results = await orm.select('calls')
  .join('caller', { as: 'c', type: 'inner' })
  .dump();
```

Generated SQL includes `symbols AS c` — the FK is still resolved from `caller`, not `c`:

```sql
SELECT calls.*
FROM (calls JOIN symbols AS c ON caller_id = c.id) c
```

### 7. Join types summary

| `type` value | SQL keyword | Root rows without match |
|---|---|---|
| `'inner'` (default) | `INNER JOIN` | Excluded |
| `'left'` | `LEFT JOIN` | Included (NULLs for joined side) |

Note: `right` and `full` outer joins are not supported by `.join()`. Use a raw SQL
escape hatch or restructure the query (swap root table / use `union`) if needed.

### 8. Using expression helpers in ON conditions

The `on` parameter accepts any `WhereIntent` — the same filter helpers used in `.where()`:

```typescript
import { and, createOrm, eq, gt, ref, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __joinsDb = schema({
  calls: {
    id: 'integer',
    callerId: ref('symbols', { as: 'caller', inverse: 'callerCalls' }),
    calleeId: ref('symbols', { as: 'callee', inverse: 'calleeCalls' }),
  },
  symbols: {
    id: 'integer',
    name: 'string',
    score: 'integer',
  },
  embeddings: {
    id: 'integer',
    vector: 'string',
  },
} as const);
const orm = createOrm({ schema: __joinsDb, adapter: createPgCompileOnlyAdapter() });

// ON condition with AND
const results = await orm.select('calls')
  .join('symbols', {
    on: and(
      eq('calls.callerId', 'symbols.id'),
      gt('symbols.score', 0),
    ),
    as: 'caller',
  })
  .dump();
```

All standard filter helpers (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `and`,
`or`, `not`, `isNull`, `isNotNull`, `inArray`) are valid in the `on` option.

### 9. Relation paths (several hops)

A dotted relation path joins one range per relation of the path. Each hop is correlated to the
previous one (the root for the first) on every key pair the model declares, so composite keys need
nothing more:

```typescript
import { createOrm, eq, exprRef, fn, ref, relationColumn, schema } from '@dbsp/core';
import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const __pathDb = schema({
  files: { id: 'integer', path: 'string', project_id: 'integer' },
  symbols: { id: 'integer', name: 'string', file_id: ref('files', { as: 'file' }) },
  calls: { id: 'integer', callee_id: ref('symbols', { as: 'callee' }) },
} as const);
const orm = createOrm({ schema: __pathDb, adapter: createPgCompileOnlyAdapter() });

const byFile = orm.select('calls')
  .join('callee.file', { type: 'left' })
  .columns([relationColumn('callee.file', 'path', 'file'), fn('count', exprRef('calls.id')).as('n')])
  .where(eq('callee_file.project_id', 7))
  .groupBy(['callee.file.path'])
  .dump();

if (
  byFile.sql !==
    'SELECT callee_file.path AS file, count(calls.id) AS n FROM calls LEFT JOIN symbols AS callee ON calls.callee_id = callee.id LEFT JOIN files AS callee_file ON callee.file_id = callee_file.id WHERE callee_file.project_id = $1 GROUP BY callee_file.path' ||
  byFile.params.length !== 1
) {
  throw new Error('relation-path join did not compile as expected');
}
```

- **Aliases.** Without `as`, hop *k* is aliased by its path prefix joined with `_`: `callee`, then
  `callee_file`. `as: 'cf'` names the last hop; `as: ['c', 'cf']` names every hop and must list
  exactly one alias per relation. Aliases are used verbatim: one that is already bound in the query
  is refused, never renamed. Join a path once — `.join('callee').join('callee.file')` is refused,
  because the second call's first hop asks for the alias `callee` again.
- **Join type.** `type` applies to every hop. With `'left'`, a root row is kept when any hop has no
  match, and the columns of the missing hops are `NULL`.
- **Relation paths.** Each hop answers to its relation path, so `relationColumn('callee.file', …)`,
  `groupBy(['callee.file.path'])`, `orderBy('callee.file.path')` and `distinctOn('callee.file.path')`
  reach the joined range. The same path joined twice under different aliases is ambiguous and refused.
- **Conditions.** There is no `on` in relation mode. Filter a hop through its alias in `.where()`
  (`eq('callee_file.project_id', 7)`), which binds the joined range. A dotted relation path in
  `.where()` (`eq('callee.file.path', …)`) follows the WHERE rule below: it traverses from the
  `callee` range as an `EXISTS` instead of binding the joined `callee_file` range. A condition that
  must sit in the ON of an outer join needs table mode.
- **From a join include.** A join include under `groupBy`, an aggregate or `DISTINCT` is refused,
  because its nested data would be dropped. `.include('callee.file', { join: 'left', where })`
  becomes `.join('callee.file', { type: 'left' })` plus the include's `where` in `.where()`,
  qualified by the hop alias. An include's `where` already compiled into the root WHERE, never into
  the ON.
- **Refused.** An unknown relation at any hop (named with its table), a many-to-many relation at any
  hop (#787), a relation without declared keys, and an alias list in table or values mode.

## Key Files

- `packages/core/src/dx/query-builder-types.ts` — `join()` method signatures (overloads 1 and 2)
- `packages/core/src/dx/query-builder.ts` — immutable `join()` implementation, builds `JoinIntent`
- `packages/types/src/intent/query-intent.ts` — `JoinIntent` discriminated union (relation / table / batchValues modes)
- `packages/adapter-pgsql/src/adapter-compiler-select.ts` — `compileJoinIntents()` lowers `SelectExecution.joins` to SQL JOIN clauses
- `packages/adapter-pgsql/src/__tests__/join-api.test.ts` — SQL compilation tests (exact SQL assertions)
- `packages/core/src/dx/__tests__/join.test.ts` — unit tests for intent shape, immutability, mode discrimination

## Gotchas

- **Relation mode vs table mode is determined by `opts.on`** — if you pass `on`, it is table mode regardless of whether the first argument matches a relation name. Omit `on` for FK auto-resolution.
- **`as` does not change FK resolution in relation mode** — `.join('caller', { as: 'c' })` resolves the FK from the `caller` relation, not from `c`. The alias only affects the SQL output name.
- **Manual join aliases are user-owned** — `.join()` reserves its SQL alias for the query. If a join-backed `include()` would otherwise auto-generate the same alias, the include moves to the next `_N` suffix and the manual alias is preserved. Duplicate join qualifiers and an alias equal to the root table name are refused at `plan()`.
- **Self-joins require a distinct alias** — use `as` when the default qualifier would equal the root table name; that collision is refused at `plan()`.
- **Result columns are flat** — `.join()` does not hydrate nested objects, and it adds no column to the projection: without `.columns()`, the query selects `<root>.*` only. Select joined columns explicitly (`relationColumn()`, `exprRef('alias.column')`); they appear as top-level keys. Use `include()` for nested hydration.
- **Right and full outer joins are not supported** — only `'inner'` and `'left'` are valid values for `type`.
- **Dotted column notation in ON conditions** — use `'table.column'` (e.g. `'embeddings.id'`) to produce qualified column references in the ON clause. An unqualified name binds to the root range, so qualify a column of the joined or an earlier range.
- **Multiple joins nest left-to-right** — the SQL FROM clause wraps joins progressively: `((A JOIN B) JOIN C)`. This matches standard PostgreSQL left-associative join behavior and is transparent to the query result.

Compilation follows [Authored intent and execution authority](./observability.md#authored-intent-and-execution-authority).

## WHERE qualifiers and planning

In a SELECT's WHERE, a qualified field starts at a visible range when its first segment names the root table or alias, or a manual join alias. Middle segments traverse declared relations and the last segment names the column. Otherwise the whole dotted path starts at the root as a relation path. For example, `.join('caller').where(eq('caller.name', 'Ada'))` filters the joined `caller` range directly; `caller.posts.title` traverses `posts` from that range. Unqualified fields inside a relation predicate bind to its target.

The same rule applies to CASE WHEN and aggregate FILTER conditions, with or without default filters: `fn('count', star()).filter(eq('posts.title', 'x'))` compiles to the `EXISTS` the WHERE produces.

HAVING follows the same rule. In HAVING, CASE WHEN and aggregate FILTER, a bare column inside an expression operand binds the root range, as in WHERE: `fn('length', exprRef('name'))` compiles to `length(posts.name)`. A condition written inside a subquery over a CTE or an NQL binding, or holding such a subquery, keeps that subquery's route, and is compiled as written, unless a rule that already applied resolves it: a HAVING field naming an aggregate alias, a relation predicate or a dotted field.

In HAVING, a field that names an aggregate alias of the SELECT names that aggregate: `count('id', 'stats.total')` then `having(gt('stats.total', 1))` compiles `HAVING count(users.id) > …`, including inside a CASE WHEN in HAVING and in an expression operand (`gt('n', exprRef('s'))`); an alias keeps its FILTER and its DISTINCT, is not visible inside an aggregate FILTER or a subquery body, and refuses `like`, range and JSON conditions. Otherwise a dotted field in HAVING resolves as in WHERE: a visible range named by its first segment, else a relation path compiled as `EXISTS`, with the root WHERE's refusals labelled `HAVING`. An expression operand qualifier that names no visible range (`exprRef('nope.id')`) is refused in HAVING, CASE WHEN and FILTER.

A qualifier binds the range it names first: a join alias, or the root, whose name is its table name. In a self-join such as `.select('nodes').join('parent')`, `nodes.label` is the root and `parent.label` the joined row, as in SQL, where an alias replaces a table's name. Only when no range carries the qualifier's name does a logical table name stand for the range of that table: one such range binds, two or more are refused with the aliases named (`.join('caller').join('callee')` makes `symbols.name` ambiguous). Window, `exprRef()` and `aggOrderBy()` fields follow the same rule. A manual join alias that spells a relation's name (`.join('files', { as: 'file', on })`) is that range, so it shadows the relation path `file`. `outerRef()` searches enclosing queries nearest first, with the same rule in each scope. An unqualified `outerRef()` binds to the immediately enclosing query. The hops of one relation path (`relationFilter` with a relation array, or a dotted path) are not enclosing queries: an `outerRef()` in its `where` binds the query that holds the predicate, and naming a hop (`outerRef('posts.id')`) is refused as not visible. To correlate with a hop, nest the predicates: `exists('posts', { where: exists('children', { where: eq('parentId', outerRef('id')) }) })`.

A typed column ref compiles as its qualified name: `orm.tables.files.id` as `files.id`, and a ref reached through a relation, `orm.tables.symbols.file.path`, as the relation path `file.path`. Both then follow the rules above, so after `.join('file')` they filter the joined row. Inside `every()`, `some()` and `none()`, the callback's own columns (`c.label`) bind to the related row.

Inside a body — a relation predicate (`exists()`, `notExists()`), a quantifier callback, or a subquery body (`rawExists`, `inSubquery`, a scalar subquery) — a typed ref reached through a relation, a callback column and a quantifier over a relation taken from a table or a callback parameter are read from the range they came from, not from the body's row:

- A TableRef names the root of the innermost query (the statement, or a `subquery('t')` body) that has a range of its table, otherwise that table's only range in scope; when several ranges of the table are in scope the ref is refused. So `exists('parent', { where: eq(orm.tables.nodes.parent.label, 'x') })` reads the parent's label, as the same ref does at the top level, while inside `rawExists(subquery('nodes')…)` the TableRef names that subquery's row, as an unaliased `FROM nodes` would.
- A path binds the relation predicates and quantifiers around it that follow it from that range, including a leading part of a multi-hop predicate's path: `every(users.writings, () => eq(users.writings.published, true))` means every post is published. The rest of the path is a relation predicate from there: `exists('children', { where: eq(orm.tables.nodes.parent.label, 'x') })` keeps the children whose root's parent is labelled `x`. Joins and includes are not bound from a body; the path is traversed instead, and its hops use the default filters in force in that body.
- A callback's columns and relations (`c.label`, `c.parent.label`, `some(c.children, …)`) are read from that callback's row at any depth; used outside their callback they are refused.
- Inside a function argument or an aggregate FILTER of a subquery body, a ref read from a row outside that body is refused, because SQL would evaluate an aggregate there in the enclosing query. Inside an argument of a typed function expression (`{ kind: 'function' }`), a ref that would be read from its origin is not supported yet (#1116); a top-level relation-path ref there keeps today's handling.
- A scalar body over an NQL binding or a CTE in a projection, ORDER BY, HAVING or CASE position keeps refusing these refs (#1040), and so does a condition holding one when nothing else in that condition makes core resolve it (a relation predicate or a subquery predicate there does); such bodies in a WHERE position, and `rawExists`/`inSubquery` over them, follow the rules above.

A typed column of the body's own table without a relation path still names the body's row (`exists('parent', { where: eq(orm.tables.nodes.label, 'x') })` filters `nodes_exists_0.label`), so inside `exists('children')` `eq(orm.tables.nodes.label, a)` reads the child while `eq(orm.tables.nodes.parent.label, b)` reads the root's parent (#1114). The string forms keep their own meanings: a bare column names the body's own row, and a dotted string first names a visible range by its first segment, otherwise it starts a relation path from the body's row. At the top level a typed ref keeps the rules above. Window `partitionBy`/`orderBy` refs keep their qualification rule, inside bodies too.

`plan()` resolves the optimized root WHERE into `execution.where`, including relation paths, declared keys and subquery ranges. Compilation uses that tree; expression references render with their range qualifier. Undeclared relations, missing declared foreign keys, many-to-many traversal and recursive relation predicates are refused during planning.

### ON visibility and planning

An ON condition sees the root range, every earlier join, and the join itself.
Unqualified fields and relation predicates start at the root range; qualified fields
can name any of those visible ranges. The written root qualifier identifies the root
even in a self-join ON. An unqualified `outerRef()` written directly in a table or values
join ON points to the joined range; inside a subquery body it binds the enclosing query, as in
WHERE. A qualifier naming a later join is refused by `plan()`
with the qualifier named in the diagnostic.
