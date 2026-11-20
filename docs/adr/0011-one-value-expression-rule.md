# ADR 0011: One Value/Expression Rule for the Scalar Leaves of Builder Arguments

## Status

Accepted (2026-11-20). Tracked in #1045. This ADR is the builder-side counterpart of ADR 0010: ADR 0010 says what core
models; this ADR says how a scalar argument of a DX helper becomes a value or an expression on its way into the intent.

## Context

The DX layer (`packages/core/src/dx`) turns each helper argument into an intent node, but no rule is shared: each
helper decides on its own. The full per-argument inventory at `main` `5af94ed7` is in
[the appendix](0011-appendix-dx-argument-inventory.md). Its row ids (E1, Q5, M1 …) are cited below. The appendix's
claims are backed by file:line references and compiled-SQL probes.

**Behaviour by input kind:**

- **Strings.** A plain string is a column in expression constructors: `fn`, `op`, `unary`, `namedArg` and `array`
  (E1, E5, E7-E9), CASE results (C1), `columns`, `orderBy`, `groupBy` and `distinctOn` (Q1, Q5, Q7, Q8). It is a value
  on the right of a filter (F2, O2), in `like` patterns (F3) and in mutation values (M1-M4).
- **Numbers and booleans.**
  - In `fn`/`op`/`unary`/`namedArg`/`array` they are bound parameters: `round(score, $1)`.
  - In CASE results they are inlined: `THEN 10`.
  - `literal(2)` inlines them in `fn`.
- **`literal()`.** It inlines in `fn` (`concat(title, '-')`). In a CASE result a string `literal()` is bound instead
  (`THEN $2`). The CASE rule is implemented twice, once in core and once in the adapter's `case-value.ts` (C1, X14).
- **`null`.**
  - `eq(f, null)` becomes `IS NULL` and `neq(f, null)` becomes `IS NOT NULL` (`literal-null.ts`).
  - `param(null)`, `op('=', f, null)` and NQL `${null}` bind a null (X3).
  - `update.set` inlines `NULL`; `doUpdate` binds it.
- **Expression objects.** An `ExpressionRef` is inlined where the helper looks for one. It is bound as the object
  itself (`$N` carrying `{"intent":…}`) in `set`/`doUpdate` (M1, M4, #1038), in `like` (F3, X9), in batch cells (M7)
  and in INSERTs over 50 rows (M2, X2).
- **Typed column references.** A `ColumnRef` (`orm.tables.x.col`) is resolved on the left of a filter, with
  `pathRef` and scope metadata (F1). It is bound as a garbage object almost everywhere else (X18).
- **Subqueries.**
  - A `SubqueryExpression` is a scalar subquery only through `.asExpr()` and the object-filter comparison
    operators `$eq`, `$neq`, `$gt`, `$gte`, `$lt` and `$lte` (O3, `object-filter.ts:163`).
  - It is read as an ordering record by `orderBy` (#1032), crashes as a filter's left operand (#1033) and is bound as
    a literal by `caseWhen` (#1034).
  - `builder.buildIntent()` wrapped in `new SubqueryExpression(...)` and `subquery('t')` carry no filter policy, so a
    `withoutDefaultFilters()` body gets the enclosing filters back (#1035). `buildSubqueryIntent()` and the arms of a
    `union()` do carry one (`registerRelationalReadPolicy` and `registerRelationalReadPlan`, same registry).
- **Normalisations in place.** Some helpers already normalise their own structure before any binding:
  - `null` becomes `IS NULL` (F2);
  - `RangeValue` is encoded (R2, with the defect #1047);
  - `distinct()` and `aggOrderBy()` are extracted from `fn` (E2, E3);
  - `op('AND'|'OR'|'NOT', …)` takes predicates (E6);
  - the record and spec forms of `orderBy` are recognised (Q8);
  - `sql()` raw markers are compiled in `set`, `doUpdate` and batch `scalarSet` (F14, M1, M8).

**Prior art**, measured on 2026-11-19 against installed packages and their sources: Kysely 0.29.9, Drizzle 0.45.4
and 1.0.0-rc.5, Knex 3.3.0, and the Prisma ORM v7 docs. Sources: Kysely `src/parser/expression-parser.ts`,
`value-parser.ts`, `reference-parser.ts` and `update-set-parser.ts`; Drizzle `sql/expressions/conditions.js`
(`bindIfParam`) and `utils.js` (`mapUpdateSet`); Knex `lib/formatter/wrappingFormatter.js` and its raw guide;
Prisma's raw-queries and client-reference pages.

- In all three builders the position decides, not the value's type. Each separates plain JavaScript values (bound),
  typed markers (`eb.ref`, Column objects, `knex.ref`) and expression objects (inlined).
- Kysely and Knex read a string as a column in reference positions and as a value in value positions. Drizzle never
  reads a string as an identifier.
- Each has one coercion leaf (`parseExpression`, `bindIfParam`, `unwrapRaw`). Helper-specific grammar is parsed
  above that leaf.
- The rule breaks where a position skips the leaf: Drizzle's update `set` accepts only `SQL` or a Column, so a
  builder throws there.

## Decision

### The rule applies to scalar leaves, after each helper's own grammar

A helper first recognises its own structure:
- predicates;
- `distinct()` and `aggOrderBy()` markers;
- `orderBy` records and specs;
- `RangeValue` objects;
- names, operators, cast types, aliases, directions and flags.

What is left is one or more **scalar leaves**. Every scalar leaf goes through one function, `coerce(leaf, position)`,
with `position` being `reference` or `value`. No helper keeps its own leaf converter.

Every argument belongs to one of four classes, recorded per argument in the appendix:
- **A**, a scalar leaf in reference position;
- **B**, a scalar leaf in value position;
- **C**, a structure the helper normalises before coercing its leaves;
- **D**, out of scope and kept as is: names, operators, types, batch cells, raw SQL escape hatches.

### What `coerce` does with each kind of leaf

1. **An expression object is used as is, in either position.** Expression objects are:
   - an `ExpressionRef`;
   - a branded `ExpressionSpec`;
   - a `ColumnRef`, which keeps its qualified name, `pathRef` and scope metadata (F1);
   - a `SubqueryExpression`;
   - the schema `ref()` marker (`REF_BRAND`, `schema.ts:654`). On the right of a filter its `target` resolves to a
     column, as today (`resolved-conditions.ts:56`, `:1102`; `eq('users.id', ref('filter.id'))` gives `ON users.id =
     filter.id`, `batch-values.test.ts:222`). `param(ref(...))` stays opaque;
   - the result of `outerRef(column)`, a plain `{ kind: 'ref', column, outer: true }`. It keeps its `outer` marker
     until core's scope resolver binds it, and is never bound as a parameter.

   A `QueryBuilder` or `SubqueryBuilder` in a leaf becomes a scalar subquery expression. Its filter policy has three
   states, each preserved:
   - inherit the enclosing filters, the default;
   - its own registered policy;
   - an explicit opt-out.

   An expression object is never bound as a parameter.
2. **A plain value follows the position.**
   - **Reference position:**
     - a string is a column;
     - a finite number, a boolean or a `bigint` is inlined as a constant. `NaN`, `Infinity` and `-Infinity` are bound
       parameters, because the constant compiler refuses non-finite numbers (`numeric-literal.ts:5`). That is today's
       behaviour in `fn`/`op`; a CASE result refuses them today and will bind them;
     - an array or a `Date` is a bound parameter, as today. `op('<=>', 'vector', [0.1, 0.2])` is the pgvector form
       (`expressions.test.ts:150`);
     - `null`, `undefined` and plain objects are refused by name;
     - CASE results normalise `null` to a SQL `NULL` before coercion, as `toResultIntent` does today
       (`case-when-builder.ts:14`).
   - **Value position:**
     - strings, numbers, booleans, `bigint`, arrays, plain objects and `Date` are bound parameters;
     - `undefined` keeps each helper's current contract:
       - a filter operand refuses it, as `eq`/`neq` do today (`literal-null.ts:12`);
       - an INSERT or UPSERT value turns it into SQL `NULL`, the documented contract (`mutation-builders.ts:706`,
         `:1191`);
       - an object-filter operator whose value is `undefined` is omitted, as `convertOperatorObject` does today
         (`object-filter.ts:188`, `:255`). This is the "absent means omitted" convention: `{ score: { $gte:
         undefined, $lte: 10 } }` keeps only `$lte`.
     - `null` keeps each helper's existing normalisation (`literal-null.ts`):
       - `eq` and `neq` give `IS NULL` and `IS NOT NULL`;
       - `isDistinctFrom` gives `IS DISTINCT FROM NULL`;
       - `gt`, `gte`, `lt`, `lte`, `like` and `ilike` refuse a raw `null` ("cannot compare with literal null");
       - `update.set` inlines `NULL` and `doUpdate` binds it, with the same result;
       - only `param(null)` and the positions that bind a null today bind it.
3. **Explicit markers override the position in every A and B leaf.** Class D surfaces keep their own contracts: batch
   cells stay opaque, and NQL is out of scope.
   - `param(v)` always binds v;
   - `literal(v)` always inlines v, a string `literal()` in a CASE result included;
   - `exprRef('c')` always references a column.
4. **`sql()` raw markers keep their current, limited role.** They stay valid in `set`, `doUpdate` and batch
   `scalarSet`, and are refused by name in any other leaf instead of being bound as an object (F14).

### Composite helpers coerce the user's leaf first

A helper that wraps a user argument in its own markers must coerce that argument before wrapping it. Today
`fullTextSearch({ query })` calls `param(query)` (`full-text-search.ts:89`), and the tuple form of the range helpers
wraps each bound in `param()` (`range.ts:66`, `:120`), which hides an expression inside a parameter. Under this rule,
the user's `query` and each tuple bound are value leaves, coerced first. Then an expression stays an expression, and
only a plain value is bound.

### Positions

The appendix lists every argument with its class. The defaults:

| Leaf | Position |
|---|---|
| Expression-constructor arguments: `fn`, `op`, `unary`, `namedArg`, `array`, `cast`, CASE results and `else` | reference |
| Left operand of a filter; `columns`, `orderBy`, `groupBy`, `distinctOn`, aggregate and window fields | reference |
| Right operand of a filter, `like` pattern, `inArray` and `any` elements, mutation values (`set`, `insert`, `upsert`, `doUpdate`) | value |

A CASE result stays in reference position: a string there is a column, as today. A number or boolean in an
expression constructor is inlined, as CASE results already are. Inlining keeps the value's SQL type, whereas a bound
text parameter (the way `pg` sends values) would turn `THEN $2 ELSE $3` into a `text` result.

### Delivery is partial, and follows ADR 0010

Accepting an expression in the DX does not by itself give the position a way to realise it. `QueryIntent.groupBy`
is `readonly string[]`, and `update.set` binds every object except a `sql()` marker. A position whose intent or
adapter cannot yet carry an expression refuses the expression leaf with `NotYetSupportedError`, naming an issue,
until it can. It never binds the leaf as data.

### Out of scope

- **Merging `SubqueryBuilder` into `QueryBuilder`.** Their methods differ in return types, aggregate semantics and
  adapter-free `dump()`. It needs its own decision, method by method. #1028 is fixed on its own.
- **NQL.** NQL has its own grammar.
- **DDL helpers and raw escape hatches** (`orm.raw`, `alterColumn.using`, index expressions).

## Consequences

- The defect families close as their positions adopt `coerce`, each with a test through its public helper:
  #1032, #1033, #1034, #1038, #956, the CASE `literal()` binding, X2 (#1048) and X18. X18 covers a `ColumnRef`
  passed directly to a leaf. It does not cover `param(ColumnRef)`, which binds its content by design (rule 3). A family closes only once
  its public SQL and parameters are verified. Whether an INSERT takes the VALUES or the unnest strategy depends on
  the configurable `batchThreshold` (default 50; 0 forces unnest) and on the rows being homogeneous. The mutation
  family is verified on both strategies (#1048).
- **Breaking changes**, listed once in the release notes (the only consumer is astix):
  - a number or boolean argument of `fn`, `op`, `unary`, `namedArg` or `array` is inlined instead of bound:
    `round(score, 2)` instead of `round(score, $1)`. The result is the same;
  - a string `literal()` in a CASE result is inlined instead of bound;
  - an object or `ColumnRef` that used to be bound as garbage in a leaf is refused or resolved, depending on its
    kind;
  - a `sql()` marker outside `set`, `doUpdate` and `scalarSet` is refused instead of bound;
  - in a reference position, `null`, `undefined` and plain objects are refused instead of bound;
  - a non-finite number in a CASE result is bound instead of refused (it widens what compiles);
  - an expression passed to `fullTextSearch({ query })` or as a range tuple bound is inlined instead of bound as an
    object.

  Unchanged, by decision:
  - strings in CASE results (still columns) and their `null`;
  - arrays and `Date` in reference positions (still bound);
  - `undefined` in mutation values (still `NULL`) and in object-filter operators (still omitted);
  - the `null` handling of `set` and `doUpdate`.
- **Typing follows the classes.** The value-leaf and reference-leaf input types derive from one definition, so
  TypeScript rejects what `coerce` refuses.

## Deliveries

1. `coerce` and the leaf types, adopted by the expression constructors (E1-E19, C1). This fixes the CASE
   `literal()` binding and the inlining of numbers in expression constructors.
2. Filter operands and object filters (F1-F5, O1-O5, Q9): #1033, #956 and X9.
3. `orderBy`, `groupBy`, `distinctOn`, aggregates and windows (Q1-Q8, W1-W2): #1032, plus the expressions these
   positions can carry. A position that cannot carry one yet refuses it with a not-yet error.
4. Mutation values (M1-M8): #1038 and #1048.
5. Subquery leaves with the three policy states: #1034, and #1035 for a builder passed directly. A builder converted
   directly keeps its policy. A `QueryIntent` that has already lost its provenance (`new
   SubqueryExpression(builder.buildIntent())`) carries none, and keeps inheriting the enclosing filters. #1035 stays
   open for that producer path, which needs its own decision.
6. The composite helpers: `fullTextSearch` (T1-T5), the range helpers (R1), `subquery(t)` field arguments (S1),
   `orm.selectExpression` (S5) and the raw CTE builder's `columns`/`orderBy` (S6). Each coerces its user leaves under
   this rule.
