# ADR 0011 appendix: DX argument inventory at main 5af94ed7 (2026-11-19)


Probes compiled SQL through `packages/*/dist` with the compile-only adapter. The dist contains `planInScope`, so it includes #1041.

**Evidence**
- Probe scripts: probe e1 to probe e19 (#1045 inventory). They share one harness.
- Typecheck matrix: probe ts (#1045 inventory), tsc 6.0.3 against the dist `.d.ts`.

**Conventions**
- Every claim is [Data] (file:line or probe output) unless it is tagged [A] (assumption).
- Paths are relative to `packages/core/src/dx/` unless they start with `core/`, `adapter/` or `types/`. `adapter/` means `packages/adapter-pgsql/src/`, `core/` means `packages/core/src/`.
- Input kinds:
  - `ER` = ExpressionRef (fn, op, exprRef, param, literal, caseWhen result).
  - `spec` = branded ExpressionSpec.
  - `CR` = ColumnRef from `orm.tables`.
  - `oR` = `outerRef()`.
  - `sqlM` = `sql()` marker.
  - `SQB` = SubqueryBuilder, `SQE` = SubqueryExpression, `QB` = QueryBuilder.
  - `big` = bigint, `undef` = undefined.
- Results:
  - `col` = column reference.
  - `$N` = bound parameter carrying the value as given.
  - `$N!obj` = bound parameter carrying the wrapper or builder object itself. pg would serialise garbage, e.g. `{"intent":…}`, `{"_type":…}`, `{"sql":…}`.
  - `inl` = inlined constant.
  - `sub` = nested scalar subquery.
  - `E(…)` = refusal or crash, with the message class.
  - `TS✗` = tsc rejects the call; `TS✓` = tsc accepts it.
- Classes: A = scalar leaf in reference position, B = scalar leaf in value position, C = structure normalised by the helper before coercion, D = out of scope and kept as is. Explicit markers (`exprRef`, `param`, `literal`) are classed by the position they force. A marker overrides the position under ADR rule 3.

## Reusable profiles (referenced from the tables)

- **EX** (`toExpressionIntent`, `expressions.ts:103-121`).
  - str → `col`. It is bare: `f(title)`, and `f(id)` even after a join.
  - num, bool, big, null, undef, arr, obj, Date → `$N` (value as is).
  - ER → used as is.
  - spec:
    - asExpr → `sub`;
    - relationColumn → `"rel".col` (needs a join, else E);
    - raw, col, coalesce(fields, as), window → E "unsupported expression kind 'raw'|'columnAlias'|'coalesce'|'window'" (`core/resolved-conditions.ts:839`, probe e12).
  - CR, oR, sqlM, QB, SQB, SQE → `$N!obj`.
  - TS: accepts str, num, bool, arr (`readonly unknown[]`), ER, spec. Rejects null, undef, big, obj, Date, CR, oR, sqlM, QB, SQB, SQE.
- **LF** (left operand of a filter, `getColumnName` at `column-utils.ts:15-45`).
  - str → as is.
  - CR → `table.col`, or `rel.path.col` for a relation-reached CR.
  - Anything else → E "Invalid ColumnRef: missing COLUMN_META". null and undef → TypeError reading the symbol.
  - TS: with the string overload, CR and str are accepted and ER, SQE, num and null are rejected. With a typed CR, the value must match the column type.
  - Dotted str `'user.name'` and a CR of another table (`eq(U.name,'x')` on posts) both compile to EXISTS through the inferred relation (probe e10). Own-table `'posts.score'` stays a column.
- **RV** (right operand of a filter). The DX stores it raw (`filters.ts:156`). It is converted by core `rhs` (`core/resolved-conditions.ts:1092-1112`) and adapter `handlers/where/literal-null.ts:6-31`.
  - str, num, bool, big, arr, obj, Date → `$N`. A string is a value here.
  - null:
    - `eq` → IS NULL;
    - `neq` → IS NOT NULL;
    - `isDistinctFrom` → IS DISTINCT FROM NULL;
    - `gt|gte|lt|lte|like` → E "cannot compare with literal null";
    - `param(null)` → `= $N` with null;
    - `literal(null)` → `= NULL`.
  - undef → E "Right comparison operand is undefined" (`literal-null.ts:12`).
  - ER (exprRef, fn, op) → column or expression, inline. `param(x)` → unwrapped `$N`. `literal(5)` → inline `5`.
  - spec:
    - asExpr → `sub`;
    - relationColumn → `"user".id` (needs a join);
    - `col()` → column;
    - `coalesce(fields, as)` → `"coalesce"(a, b)`, a quoted function name. PG has no such function, so I expect a runtime error [A];
    - `raw()` → E.
  - CR → `$N!obj`. TS accepts it only through the string-left overload, `value: unknown`.
  - oR → a column of the enclosing query inside a subquery body. At top level, E "outerRef() requires an enclosing query range" (`core/resolved-conditions.ts:255`).
  - sqlM, QB, SQB, SQE → `$N!obj` (#956 for the builders).
- **MV** (mutation values). Detailed in the mutation table.

## `expressions.ts`

| # | Helper.arg | Converter (file:line) | Input kinds → result | Normalisation before binding | Class |
|---|---|---|---|---|---|
| E1 | `fn(name, ...args)` args | `toExpressionIntent` `:103`, called from `fn` `:525` | Profile EX | None at DX. The SELECT list emits the bare `f(id)`, which I expect to be ambiguous in PG after `.join('user')`. Probe e16: `abs(id)` [A]. WHERE emits `posts.id`. | A |
| E2 | `fn`: `distinct(x)` marker | `fn` `:545-585`; `isDistinctField` `:706`; `filters.ts:126` | Allowed only as the first argument (E otherwise). `'*'` → E. Recognised only when `field` is a string. `distinct(CR\|ER)` is TS✗, and at runtime it is not recognised, so the whole `{field,distinct}` object is bound: `count($1)` (probe e5). | `distinct:true` flag on the intent, with its argument pushed through EX | C (marker), A (field) |
| E3 | `fn`: `aggOrderBy(field, dir)` | `aggOrderBy` `:737`; `isAggOrderByArg` `:718`; resolved at `core/resolved-conditions.ts:906-922`; direction at `adapter/handlers/expression/custom.ts:199` | field str → `col`. `'lower(title)'` → E absent column. CR or ER → E `name.indexOf` (TS✗). dir `'sideways'` → ASC silently (TS✗). | `__aggOrderBy` marker extracted into `aggOrderBy[]` | C |
| E4 | `ExpressionRef.filter(cond)` | `:206` | WhereIntent stored raw, `customFn` only (E otherwise) | `filter` field. Compiled wherever the aggregate is compiled: `columns()`, `orderBy`, inside `cast` (`core/resolved-conditions.ts:906`, `adapter/handlers/expression/custom.ts:180`). The comment that restricts it to `columns()` is stale. | C |
| E5 | `op(operator, left, right)` | `:392-480`; `isPredicateOperator` `:484` | Profile EX for both sides. Differences from `eq`: right str → `col` (`op('=','score','title')` → `score = title`). `op('=','score',null)` → `= $1 [null]`, with no IS NULL rewrite. | `OPERATOR_PATTERN` (`:61`) refuses comment sequences. The result is a predicate (`ExpressionPredicateRef`) for 12 known operators. | A |
| E6 | `op('AND'\|'OR'\|'NOT', …)` | `:402-430` | The operands must be `PredicateRef` (`instanceof`). `eq()` or a WhereIntent gives E "AND requires predicate operands" (TS✗). | The `WhereIntent` is derived by `predicateWhereIntent` `:292` | C |
| E7 | `unary(op, expr)` | `:646` → `toExpressionIntent` | Profile EX | `OPERATOR_PATTERN` | A |
| E8 | `namedArg(name, value)` | `:666` | `value`: Profile EX. `name` is checked against `FUNCTION_NAME_PATTERN`. | none | A (value), D (name) |
| E9 | `array(...items)` | `:688` | Profile EX per item. `array(null)`, `array(Date)` and `array(CR)` are TS✗. | none | A |
| E10 | `cast(expr, typeName)` | `:349` reads `expr.intent` directly | ER → ok. asExpr spec → ok at runtime (TS✗). str, num, bool, arr, obj, Date, CR, oR, sqlM, QB, SQB → E at compile ("reading 'kind'"). SQE → E ("reading 'replace'"). null or undef → E at construction ("reading 'intent'"). Probes e1, e19. | `TYPE_NAME_PATTERN` validation of `typeName` | A (expr), D (type) |
| E11 | `literal(v)` | `:630` | str → inline `'x'`. num and bool → inline. null and undef → `NULL`. big, arr, obj, Date, ER, CR, … → E "literal(): unsupported value type" (`core/…/resolved-condition-compiler.ts:446`; `adapter/handlers/expression/custom.ts:280`). TS accepts only `string\|number\|boolean\|null`. | none. The **CASE** result path binds a string literal as `$N` (`adapter/handlers/expression/case-value.ts:67-80`); this is the known literal-in-CASE case. | B (explicit inline) |
| E12 | `param(v)` | `:336` | Any value → `{kind:'param'}`. SQL: `$N` carrying v; ER, CR, spec etc. → `$N!obj`. | `param` is unwrapped (`adapter/param-intent.ts:4`) in `set`, `doUpdate`, INSERT VALUES (≤50 rows), WHERE operands and `like`. It is **not** unwrapped in `batchSet` cells, `batchValues` cells, `fromUnnest` or INSERT >50 rows (see extras X2). | B (explicit bind) |
| E13 | `exprRef(column)` (`ref`) | `:323` | str → `col` (not validated at DX; unknown → E "Declared column … absent"). num, bool, big, null, undef, obj, Date, ER, … → E at compile (`name.indexOf is not a function`). arr → E (`posts.1,2`). TS accepts only str. | none | A (explicit) |
| E14 | `boolFn(name, ...args)` | `:609` → `fn` | As E1 | marks the call as a predicate | A |
| E15 | `unsafeAsPredicate(expr)` | `:450` | ER only, allow-list on `expr.intent.kind` | none | C |
| E16 | `arrayAgg(col, ...aggOrderBy)` | `:752` | str → `ref(col)`. ER or distinct → passes through. CR → `$N!obj` (TS✗). | `typeof col === 'string' ? ref : col` | A |
| E17 | `stringAgg(col, sep, ...)` | `:768` | `sep` is typed `ExpressionRef`. A string `','` would reach `ref(',')`, a column [A]. | **Not exported from the public barrel**: `dx/index.ts:67` exports it, root `index.ts` does not (tsc TS2305). | A |
| E18 | `ExpressionRef.eq/neq/gt/gte/lt/lte(value)` | `:158-184` → `WhereExpressionIntent` → core `rhs` (`core/resolved-conditions.ts:1226-1231`) | Profile RV (probe e11). `eq(null)` → IS NULL, `eq(undef)` → E, ER → inline, SQE and QB → `$N!obj`, CR → `$N!obj`. | The null rewrite is in the adapter (`literal-null.ts`) | B |
| E19 | `ExpressionRef.as(alias)` | `:150` | alias is not validated. `'bad alias'` → quoted `"bad alias"`. | none (the helpers `col`, `raw`, `relationColumn` and `coalesce(f,as)` do validate: `filters.ts:889-1049`) | D |

## `filters.ts` (and its re-exports)

| # | Helper.arg | Converter | Input kinds → result | Normalisation | Class |
|---|---|---|---|---|---|
| F1 | `eq, neq, gt, gte, lt, lte, isDistinctFrom` left | `createComparisonFilter` `:149-168` → `getColumnName` | Profile LF | `pathRef:true` for a relation-reached CR (`:163`, `column-utils.ts:47`). `scoped()` carries `CALLBACK_SCOPE` (`:761`). | A |
| F2 | same, right | stored raw (`:156`) | Profile RV | null → IS NULL (`adapter/handlers/where/literal-null.ts:6-31`) | B |
| F3 | `like(field, pattern, opts)` | `:243-281` → core `parameter(node.pattern)` (`core/resolved-conditions.ts:1131-1137`) | The pattern is bound by `parameter()`, which only unwraps `param()`. str, num, bool, big, arr, obj, Date → `$N`. null or undef → E. **ER (`exprRef`) → `$N!obj`**, unlike `eq` (TS✗, pattern is `string`). | `escape` → `ESCAPE $N` bound. `'xx'` and `"'"` reach PG. | B (pattern), D (flags, escape) |
| F4 | `inArray(field, values)` | `:295`; core `normalizeList` (`core/resolved-conditions.ts:991-1003`) | Non-array (str, num, bool, null, undef, obj, ER, …) → E "[in handler] … non-array … compiler bug" (TS✗). Array elements are bound as given: `[exprRef('id')]` → `$N!obj`, `[null]` → `[null]` inside `= ANY($1)`. | `param()` elements are unwrapped. `[]` → `WHERE false`. | B (elements) |
| F5 | `any(field, values)` | `:353`; `core/resolved-conditions.ts:1157-1162`; `adapter/…/resolved-condition-compiler.ts:648` | Array → `= ANY(CAST($1 AS int4[]))`. **Non-array (str, num, null, obj, ER, …) → silently `[]`** (TS✗). | typed cast from model metadata | B |
| F6 | `isNull / isNotNull(field)` | `:382`, `:471` | Profile LF | `pathRef` | A |
| F7 | `inSubquery(field, query)` | `:323-340` | Left: LF. Query: SQB → `.build()`; SQE → as is; QB → E `expr.toIntent is not a function` (TS✗); primitives → E (`'build' in x` TypeError). | Uses `build()`, not `buildSubqueryIntent`, so there is no filter policy (#1035). **The planner rewrites `inSubquery('id', subquery(FK col))` to EXISTS when the left is a string, but compiles `= ANY (SELECT …)` when the left is a CR** (probe e7/e8). | A (field), C (query) |
| F8 | `rawExists / rawNotExists(sq)` | `:635`, `:673` | SQB → ok. QB → ok at runtime (a LIMIT is refused). SQE → E `sq.build is not a function`. Primitives → E. **TS rejects QB**: the public `QueryBuilder` interface has no `buildIntent`, although the JSDoc (`filters.ts:~620`) shows `rawExists(orm.select(...))`. | picks `buildSubqueryIntent` first | C |
| F9 | `exists / notExists(relation, {where, recursive, include})` | `:555`, `:587` | `relation` is a str (D). `where` is a WhereIntent stored raw, with the same RV rules inside. `exists(CR)` → E `segments is not iterable`. | options copied field by field | C / D |
| F10 | `some / every / none(RelationRef, cb)` | `quantify` `:732-759` | The callback receives a re-rooted ref. Inner conditions follow F1-F2. | `pathRef` and `pathTable`, scope token, `assertCallbackScope` | C |
| F11 | `and / or / not(...)` | `:497-540` | WhereIntent only. `and()` → `true`, `or()` → `false`. A PredicateRef or null → E at compile (`unhandled WhereIntent kind 'undefined'` or TypeError). TS rejects a PredicateRef. | flattens a single array | C |
| F12 | `coalesce(fields, as)` (the public `coalesce`) | `:877` | `fields` are validated identifiers. Anything else → E at construction. | `validateIdentifier` | D |
| F13 | `raw(sql, as)`, `col(c, as)`, `relationColumn(rel, c, as)` | `:942`, `:984`, `:1028` | `as` and the column names are validated. `raw()` is accepted by TS in `fn`, `op` and `orderBy` (`cast` requires an `ExpressionRef`, E10), but compile refuses it (X8). | validation only | D |
| F14 | `sql(fragment)` | `:1113`; `isSqlRaw` `:1123` | Recognised **only** in `set`, `doUpdate` and the batch `scalarSet`. Everywhere else it is bound as `{"sql":…}`: `eq`, `fn`, `like`, CASE, INSERT, `batchSet` cells, `orderBy` (read as a record → E `posts.sql`). | none | D (raw marker) |
| F15 | `distinct(field)` | `:111` | Takes a string only (TS✗ for CR and ER) | `{field, distinct:true}` | C (marker) |
| F16 | `rangeOverlaps/rangeContains/rangeContainedBy` in `filters.ts:418/437/454` | | **Shadowed duplicates**: the public ones come from `range.ts` (`dx/index.ts:265-268`). | | D (dead code) |

## `range.ts`

| # | Helper.arg | Converter | Input kinds → result | Normalisation | Class |
|---|---|---|---|---|---|
| R1 | `rangeOverlaps/Contains/ContainedBy(col, tuple, rangeType?)` | `makeRangeFn` `:66` = `fn(rangeType, param(l), param(u))`; `op('&&'\|'@>'\|'<@', ref(col), …)` `:115`, `:160`, `:205` | col: str only (CR → E `lastIndexOf`, TS✗). Tuple items are bound via `param()`: str, num, Date, null → `$N`; ER → `$N!obj`. A tuple of length ≠ 2 → E (`:78`). `rangeType` is any identifier at runtime (`'badtype'` → `badtype($1,$2)`; TS✗). | `daterange` default | A (col), B (items), D (type) |
| R2 | same, object form (`RangeValue`) | core `rangeParameter` (`core/resolved-conditions.ts:972-989`); legacy copy `adapter/handlers/where/range.ts:82` | `{lower, upper}` → the string `[lower,upper)` by template. **`bounds` is ignored**: `'[]'`, `'()'`, `'(]'` and `'bogus'` all give `[1,2)` (probe e8). A Date lower becomes `Thu Jan 01 1970 …`. An ER lower becomes `[object Object]`. null or undef → an empty bound. A scalar operand (`rangeContains`) → `$N` with a range-element cast. null and ER operands are TS✗. | `[${lower ?? ''},${upper ?? ''})` | C |

## `object-filter.ts`

| # | Arg | Converter | Input kinds → result | Normalisation | Class |
|---|---|---|---|---|---|
| O1 | key (field) | `objectToWhereIntent` `:296` | str only. `'user.name'` → EXISTS relation hop. Keys `__proto__`, `constructor`, `prototype` → E. An empty object → E. | `FORBIDDEN_KEYS` `:273` | A |
| O2 | direct value `{k: v}` | `convertFieldValue` `:136` | null → `{kind:'null'}` (IS NULL). undef → E "Right … undefined". str, num, bool, big, arr, obj, Date → `$N`. ER → inline column or expression (TS✗). SQE, SQB, QB, CR, sqlM, oR → as RV (bound object, or E for oR at top level). `{}` → bound `{}`. A mixed `{ $gt:1, bogus:1 }` → bound as a plain value. | `isOperatorObject` `:121` requires every key to start with `$` | B |
| O3 | `$eq,$neq,$gt,$gte,$lt,$lte` | `createComparisonIntent` `:163` | **SQE → `toWhereIntent` → scalar subquery** (`sub`). SQB and QB → `$N!obj`. `$eq:null` → IS NULL. `$gt:null` → E. `$eq:undef` → E "no recognized operators" (the key is skipped). | `isSubqueryExpression` (`subquery-builder.ts:319`) is a duck-typed `_type` check | B, C for SQE |
| O4 | `$in` | `:182-260` | raw array. Non-array → E (compiler bug message). `[]` → `WHERE false`. | none | B |
| O5 | `$like, $ilike, $notNull` | same | raw pattern, as F3. `$notNull` only accepts `true`. | none | B / D |

## `case-when-builder.ts` (exported) and `functions.ts` (not exported)

| # | Arg | Converter | Input kinds → result | Normalisation | Class |
|---|---|---|---|---|---|
| C1 | `caseWhen(cond, then)` and `.when`, `.else` result | `toResultIntent` `case-when-builder.ts:8-22`; lowering `adapter/handlers/expression/case-value.ts:35-86` (select list) and `core/resolved-conditions.ts:789-805` (a second copy of the rule) | str → `col`. num, bool → inline. null and undef → `NULL`. ER → used as is. big, Date, arr, obj → wrapped as `{literal,value}`; in a SELECT-list CASE they are then bound `$N` (`case-value.ts:79-80`), in a resolved WHERE CASE they are refused (`literal(): unsupported value type`, `resolved-condition-compiler.ts:440`). **asExpr spec, SQE, CR, oR and sqlM are also wrapped as a literal and bound `$N!obj`** (TS✗ for all of these except `literal()` and ER). `literal('Active')` → `$N` bound; `literal(10)` → inline. | none | A (reference, ADR 0011), with null → NULL normalised before coercion (C) |
| C2 | `caseWhen(cond, …)` condition | stored raw | WhereIntent, with F1-F2 rules inside: `eq(f,null)` → IS NULL; `eq(f, exprRef('id'))` → `posts.score = id` (bare), but `posts.id` in WHERE (probe e15). A PredicateRef (`op(…)`) → E "No CASE WHEN handler registered for operator: undefined" (TS✗). | none | C |
| C3 | `functions.ts` (`count, sum, avg, min, max, coalesce, lower, upper, concat`, fluent `caseWhen<T>()`) | Only `functions.test.ts` imports it. Not exported (#1046). | `concat` and `resultToString` quote strings into SQL text (`CONCAT('…')`). `lower` and `upper` emit `LOWER(${field})`. They produce `kind:'raw'`, which core refuses (`resolved-conditions.ts:839`). The fluent `.when(condition: string)` takes SQL text. | `validateAlias` regex | D (dead) |

## `query-builder.ts`

| # | Method.arg | Converter | Input kinds → result | Normalisation | Class |
|---|---|---|---|---|---|
| Q1 | `columns([...])` | `:224-245`; `isExpressionSpec` `types.ts:97` | str → `posts.title`. ER → `SELECT score`, bare. asExpr spec → `(SELECT …) AS n`. Every other kind (num, bool, big, null, undef, arr, obj, Date, CR, oR, sqlM, QB, SQB, SQE) → `{kind:'column', column: <obj>}`, then E "Declared column 'posts.[object Object]' is missing" (TS✗). `'posts.title'` and `'user.name'` → E (`posts.posts.title`, `posts.user.name`), while `orderBy`, `where` and aggregates accept them. | none | A |
| Q2 | `coalesce(fields, as)` method | `:260` → `adapter/handlers/expression/coalesce.ts:15-45` | A string without a space → `col`. **A string with a space → bound `$N` as a value.** num → `$N`. ER or CR → `$N!obj`. TS restricts it to column keys. | `alias` is not validated (`"x y"` is emitted; the exported `coalesce(f, as)` validates) | A, with a string-shape heuristic |
| Q3 | `count(field \| opts \| distinct, as)` | `:307-340` | str → `posts.score`. A distinct str → `count(DISTINCT …)`. `{field, as}` → ok. num → ignored, `count(*)` (TS✗). ER → crash `name.replace is not a function`: the options branch reads `fieldOrOptions.as`, which on an `ExpressionRef` is its `.as()` method, taken as the alias (`query-builder.ts:317-326`). CR → E `name.replace`. `distinct(CR)` → E `includes`. | `field` goes through core `ref(input.field)` (`core/resolved-conditions.ts:924-939`) | A |
| Q4 | `sum/avg(field\|distinct, as)`, `min/max(field, as)` | `:342-390` | str → col. CR and ER → E `includes is not a function` (TS✗). `max(null)` → `count(*)`-like E on `posts.*`. | none | A |
| Q5 | `groupBy(fields)` | `:392` (`push(...fields)`) | A string array only. **A bare str is spread into characters** (`groupBy('status')` → `posts.s`, TS✗). num, null, obj, ER, CR, spec → stringified (`posts.5`, `posts.[object Object]`), then E (TS✗). | none | A |
| Q6 | `having(cond)` | `:398` | WhereIntent stored raw. A PredicateRef is TS✗. The field resolves an aggregate alias first (`n` → `count(*)`), else a column. CR → ok. | `core/resolved-conditions.ts` alias resolution | C |
| Q7 | `distinctOn(...cols)` | `:425` | str → **bare** `DISTINCT ON (status)`. A dotted str after a join works. CR, ER, num → E `includes is not a function` (TS✗). An array argument is accepted at runtime (coerced) but TS✗. | none | A |
| Q8 | `orderBy(x, dir, {nulls})` | `:502-565` | See the orderBy table. | | A / C |
| Q9 | `where(cond)` | `:586-615` | PredicateRef → `predicateWhereIntent`. A foreign-copy predicate → E. ER or spec → E "expected a PredicateRef". Otherwise: `isWhereIntent` (duck-typed on a string `kind`) → as is; else `objectToWhereIntent` (O1-O5). | `.where().where()` accumulates (AND) | C |
| Q10 | `join(table, {on, as, type})` | `:617-690` | `on` is a WhereIntent. A right-hand str is a value: `eq('id','t.id')` → `$2` with "t.id"; it needs `exprRef('t.id')` (probe e9). Names and aliases are validated (`:643-657`). | `validateIdentifier` | C / D |
| Q11 | `include(rel, opts)` | `include-intent.ts:41-95` | `where` (WhereIntent), `orderBy` (field list), `select`, `limit` are copied raw. | none | C / D |
| Q12 | `byId / byIds / byIdOrThrow` | `buildPkCondition` `:884-925` | A str or num → `eq(pk, v)`. An object → `eq(field, value)` per key. `byId({id:null})` → IS NULL. | key allow-list (`FIND-009`) | B |
| Q13 | `paginate / cursorPaginate({cursor})` | `pagination-impl.ts:49-130` | The decoded cursor values are put into raw `gt/lt/eq` comparisons (`:76`, `:107`, `:118`). [A] A NULL sort key then reaches `gt(null)` → E "cannot compare with literal null" (`literal-null.ts:30`). | base64 JSON; must decode to an object | B |

### `orderBy` forms (probes e4, e5, e10, e15)

| Input | Result |
|---|---|
| str, str+dir | `posts.score ASC\|DESC`. A dotted str after a join → `"user".name`. |
| record `{f:'desc'}` | col with dir. `'DESC'` (upper case) and `'sideways'` → ASC silently. |
| `[{column, direction, nulls}]` | col. A bogus direction → ASC. `nulls:'bogus'` → NULLS LAST (`adapter/intent-to-decisions.ts:871-877`). `column` as CR or ER → E `lastIndexOf` (TS✗). |
| ER + dir + nulls | expression, e.g. `ORDER BY lower(title) DESC NULLS LAST`. `exprRef('id')` is bare after a join. `literal(1)` → `ORDER BY 1` (a positional ordinal [A]). `param(1)` → `ORDER BY $1`. |
| asExpr spec | `ORDER BY (SELECT …)`. `relationColumn` works only after a join. raw, col, coalesce and window specs → E unsupported kind. |
| SQE, SQB (#1032), CR, QB, sqlM | Read as a record: E "Declared column 'posts._type\|_from\|ctx\|sql' is absent" (all TS✗). |
| num | **No ORDER BY, silently** (`Object.entries(5)` is empty). null → TypeError. |

## `window-functions.ts`

| # | Arg | Converter | Input kinds → result | Normalisation | Class |
|---|---|---|---|---|---|
| W1 | `wSum/wAvg/wMin/wMax/wCount/lag/lead(field)` | `:273-356` | The field is a string only (no CR, no ER). It is passed as `field` to the window intent and resolved as a column (`posts.score`). CR → E `name.indexOf` (TS✗). | none | A |
| W2 | `.partitionBy(...f)`, `.orderBy(f, dir)` | `:123`, `:151` → `getColumnName` | str or CR → `posts.status`, `"user".name` for a dotted str after a join. ER → E `COLUMN_META` (TS✗). The helper takes `'asc' | 'desc'` (`window-functions.ts:151`); `'desc'` compiles to `DESC`. A value outside that type (TS✗) reaches the compiler, which treats anything but its own `'DESC'` form as ASC (`adapter/handlers/expression/window.ts:73`). | none | A |
| W3 | `.as(alias)` | `:171` | alias not validated | none | D |

## `full-text-search.ts`

| # | Arg | Converter | Result | Class |
|---|---|---|---|---|
| T1 | `fullTextSearch({query})` | `param(query)` | Any value → `$N`. `query: exprRef` is TS✓ but binds the object. | B |
| T2 | `fields[].name` | `literal(fieldName)` | str → **inlined** string constant `'name'`. CR is TS✗. | D (name, inlined) |
| T3 | `fields[].boost` | `literal(weight)` | num → inline. A str is TS✗. | D |
| T4 | `tableAlias` | `ref(tableAlias)` | str → col | A |
| T5 | `textScore(keyField)` | `fn('paradedb.score', ref(keyField))` | str → col. CR and ER → TS✗. | A |

## Mutations (`mutation-builders.ts` stores raw; the adapter converts)

| # | Argument | Converter (file:line) | MV result (set / doUpdate / VALUES / unnest) | Class |
|---|---|---|---|---|
| M1 | `update.set(obj)` | DX `:826-847` (object and column checks only) → `adapter/mutations/mutation-compiler.ts:1196` `assignmentToNode` → `valueToNode` `:1027` | str, num, bool, big, arr, obj, Date → `$N`. null and undef → inline `NULL` (`:1034-1040`). `param(x)` → unwrapped `$N` (`adapter/param-intent.ts:4`). **ER (fn, op, exprRef, literal, caseWhen), asExpr spec, CR, oR, SQE, QB, SQB → `$N!obj`** (#1038). **sqlM → parsed raw SQL** (`now()`). TS: `Updateable<T>` accepts `T[K]` and sqlM (`mutation-builders.ts:76`), so `null` is accepted for a nullable column (`schema.ts:519`) and rejected for a non-nullable one; undef, ER, SQE and CR are rejected. | B (raw SQL = D) |
| M2 | `insert.values(row\|rows)` | DX `:711-728` → `mutation-compiler.ts:323-345` (VALUES) or `compileUnnestInsert` `:389` (unnest: chosen when the row count exceeds the configurable `batchThreshold`, default 50, or when the threshold is 0, and only for homogeneous rows, `adapter/adapter-compiler-mutations.ts:624-628`) | ≤50 rows: as M1, except sqlM → `$N!obj`, with no parse. **>50 rows: every cell goes raw into a column array**, so `param(5)` → `{"intent":{…}}` inside the array (probe e17). The array type comes from model metadata, else from a sample (`adapter/compiler-utils.ts:24-70`). | B |
| M3 | `upsert.values` | `:1196` | as M2 | B |
| M4 | `upsert.doUpdate(set, cond)` set | DX `:1256-1278` → `adapter/adapter-compiler-mutations.ts:1116-1132` → `adapter/mutations/upsert.ts:236-243` (`valueToNode(…, forceParam=true)`) | sqlM → raw. `param` unwrapped. **null and undef → bound `$N` null** (M1 inlines `NULL`). ER, spec, CR, SQE → `$N!obj`. | B |
| M5 | `doUpdate(…, cond)` condition | `toWhereIntent` `mutation-builders.ts:110` | `WhereIntent \| PredicateRef`. RV rules inside. `eq('score', exprRef('id'))` → `posts.score = posts.id`. | C |
| M6 | `update.where / delete.where` | `:850`, `:1047` | as M5 | C |
| M7 | `update.batchSet(match, rows)` cells | DX `:910-940` → `compileUnnestUpdate` `mutation-compiler.ts:566-600`; `adapter-compiler-mutations.ts:934` | Cells are raw column-array elements. null and undef → null. Date → the same `Date` object kept in the parameter array (`mutation-compiler.ts:580-588`). big → bigint. **ER, sqlM, `param()` and `literal()` → an object inside the array.** TS accepts only scalars of the column type. | D (batch cells) |
| M8 | `batchSet(...).set({…})` scalarSet | `mutation-compiler.ts:616-622` → `assignmentToNode` | as M1: sqlM → raw, ER → `$N!obj` | B |
| M9 | `batchSet` match keys | `:910` | str or str[]. Required in every row. | D |
| M10 | `orm.batchValues(data, cols, types)` and `.join/.from(batchRef)` | `batch-values.ts:200-230` | cells are raw arrays (ER → object, big → `bigint` kept as is (`batch-values.ts:242`, `adapter-compiler-select.ts:272-291`)). Column names and `alias` are validated. Type names are validated by `validateTypeName` `:54`. | D (cells) |
| M11 | `withCte(n).fromUnnest(cols)` | `cte-builder.ts:65`; `adapter/adapter-compiler-recursive.ts:845` | Arrays of raw values. Types are inferred from the first non-null element: Date and obj → `jsonb[]`, big → `int8[]`. A non-array → E `colArray.find`. | D |
| M12 | `.withIndex(name)` | `cte-builder.ts:82` | not validated (`"i j"` emitted quoted) | D |
| M13 | NQL `insert … ${v}` through `orm.nql` | `nql.ts` header `:10-25` | see the NQL row below | D (NQL, out of scope of ADR 0011) |

## Subqueries, selectExpression, CTE, NQL, other surfaces

| # | Surface | Converter | Results | Class |
|---|---|---|---|---|
| S1 | `subquery(t).select(field)`, `.count/sum/avg/min/max(field)` | `subquery-builder.ts:51,74-115` | str only. CR or ER → `posts.[object Object]` E. `count(5)` → E. | A |
| S2 | `SubqueryBuilder.where(cond)` | `:61` | WhereIntent, **replacing** (#1028). The documented object form `where({user_id: outerRef('id')})` → E "processWhere: unhandled WhereIntent kind 'undefined'" (TS✗). The JSDoc at `subquery-builder.ts:~25-33` still shows it. | C |
| S3 | `SubqueryBuilder.build() / .asExpr(alias)`, `SQE.asExpr(alias)` | `:124`, `:176`, `:245` | The alias is not validated (`"bad alias"`). `asExpr` without an alias is allowed and emits an unnamed column. A bare SQE or SQB in `columns()` → E. | C / D |
| S4 | `outerRef(column)` | `:295` | returns `{kind:'ref', column, outer:true}`, a plain object. In `fn`, `op`, CASE, `set`, `like` and `inArray` it is `$N!obj`. It is resolved on the right of every comparison (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`) inside a subquery body (`core/resolved-conditions.ts:1092`), in the object-filter value, and in `rawExists` bodies. At top level → E. | A (reference) |
| S5 | `orm.selectExpression(spec)` | `orm-instance.ts:1134`; `adapter.compileSelectExpression` | ER and asExpr → ok. str → `fn('nextval','seq')` emits the column `seq` (needs `literal`). raw, col, coalesce, window → E unsupported. num and SQE → E (TS✗). | A |
| S6 | `orm.recursive(name,{base,step}).columns/orderBy/where` | `raw-cte-builder.ts:116-140` | `columns(str[])` → `{kind:'column'}`, with names unvalidated (unknown → E "does not project"). `orderBy(str, dir)` → a bogus direction → ASC. `where(WhereIntent)` stored raw. ER, CR and num → E (TS✗). | A / C |
| S7 | `orm.nql\`… ${v}\`` | `nql.ts` (header `:10-25`, refusal text `:1609`) | Each interpolation becomes a named parameter. str, num, bool, big, arr, obj, Date, ER, CR, oR, sqlM, SQE → `$N` (objects bound as garbage). **null → `= $1 [null]`, not IS NULL**. undef → E. `nqlRaw()` is the trusted-fragment escape. | D (NQL, out of scope of ADR 0011) |
| S8 | `orm.raw(sql, params)` | `orm-instance.ts:1104` | raw SQL text plus params passed through (a documented escape hatch) | D |
| S9 | DDL helpers: `alterColumn({using, setDefault})`, `indexes.create({where, columns[].expression})` | `types/adapter.ts:733-778`; `adapter/ddl/phases/utils.ts:248-281` | raw SQL text. `setDefault` is shape-driven: `{sql}` is verbatim, a string ending `()` is verbatim, any other string is quoted. | D |
| S10 | `defaultFilters`, `withSchema(name)`, `limit`, `offset`, `lock*`, `exists(...include)` | `validateLimit`, `validateIdentifier` | validated structure and names | D |
| S11 | `FromBuilder.pick/orderBy`, `createTypedOrm` | `typed-query-builder.ts:203-245`, `getBareColumnName` (`column-utils.ts:64`) | **Not exported and not used by `orm.from`** (`orm.from` returns a plain QueryBuilder, `orm-instance.ts:613`). Only the tests import it. `pick(CR…)` and `orderBy(CR, dir)` read `COLUMN_META` only. | D (dead) |
| S12 | `RecursiveQueryBuilder.where/columns/startingFrom` | `recursive-query-builder.ts:194,397,282` | internal only (`dx/index.ts:276`). `columns(record)` keeps only the keys. | D |

## Inconsistencies not already in #956, #1028, #1032, #1033, #1034, #1035, #1038, #1046 or the literal-in-CASE case

Where an open issue may overlap, I say so. #258 (join-alias tracking, open) and #891 (adapter lowerings, open) are the nearest ones.

- **X1 `RangeValue.bounds` is silently dropped, and lower/upper are stringified by template.** [Data: `core/resolved-conditions.ts:983`, `adapter/handlers/where/range.ts:82`, probe e8]
  - Every bounds value produces `[lower,upper)`.
  - A Date becomes `Thu Jan 01 1970 …`, an ER becomes `[object Object]`.
  - TS accepts `bounds: '[]'` and `lower: Date`.
- **X2 The INSERT strategy switch (VALUES vs unnest, decided by the configurable `batchThreshold`, default 50, zero forcing unnest, homogeneous rows only: `adapter-compiler-mutations.ts:603-627`, `types/adapter.ts:169`) changes cell semantics.** [Data: `adapter/adapter-compiler-mutations.ts:624-628`, probe e17]
  - `param(5)` is unwrapped in VALUES.
  - In the unnest arrays the same cell becomes `{"intent":{"kind":"param","value":5}}`.
  - NULL handling also differs between the two paths.
- **X3 null handling differs per position.**
  - `update.set(null)` inlines `NULL`; `doUpdate(null)` binds `$N` (`mutation-compiler.ts:1034` vs `upsert.ts:236`).
  - `eq(f,null)` gives IS NULL; `op('=',f,null)`, `param(null)` and NQL `${null}` give `= $N`.
  - `literal(null)` gives `= NULL`.
- **X4 `any()` with a non-array value silently becomes an empty array**, so the predicate is always false (`adapter/resolved-condition-compiler.ts:648`; TS✗). `inArray` refuses the same input loudly.
- **X5 orderBy silently normalises bad input** (`adapter/intent-to-decisions.ts:871-877`, probes e4/e15).
  - Unknown or upper-case directions become ASC; unknown `nulls` becomes LAST.
  - `orderBy(5)` drops the ORDER BY.
  - `orderBy(CR)` reads the CR as a record, like #1032 but not named there.
  - `orderBy(literal(1))` compiles to a positional ordinal [A: PG semantics].
- **X6 `groupBy` and `distinctOn` accept no expressions and no ColumnRef.** `groupBy('status')` spreads characters, and non-strings are stringified into column names (Q5, Q7).
- **X7 The same string is qualified or bare depending on the position, and dotted strings change meaning.**
  - `columns(['id'])`, `orderBy('id')`, `groupBy`, WHERE operands and `exprRef` on the right of `eq` emit `posts.id`.
  - `fn('abs','id')`, `orderBy(exprRef('id'))`, a CASE result `'id'` and `distinctOn('id')` emit the bare `id`.
  - After a join the bare form is ambiguous in PG [A: PG error, both tables have `id`] (probe e16).
  - Dotted strings:
    - Left of a filter, `'user.name'` is a relation hop that compiles to EXISTS.
    - In `columns()` and `groupBy`, `'user.name'` and `'posts.title'` are errors.
    - In `orderBy` and `distinctOn` it is a join alias.
  - Partly overlaps #258 and #891.
- **X8 `raw()`, `col()`, `coalesce(f,as)` and window specs are type-accepted by `fn`, `op`, `orderBy` and `selectExpression` but refused at compile** (probe e12). `cast()` is typed `ExpressionRef` and reads `expr.intent` directly (E10); it does not accept a general spec at type level and creates no parameter. `eq('score', coalesce([…],'c'))` compiles to `"coalesce"(a,b)`, a quoted function name PG has no function for [A].
- **X9 `like` and `rangeContains` do not resolve ER the way `eq` does.** `like('title', exprRef(...))` binds the object (TS✗), whereas `eq` resolves it as a column.
- **X10 `distinct(CR)` and `aggOrderBy(CR)` are TS✗**, and at runtime they bind or crash (E2, E3).
- **X11 `QueryBuilder.coalesce` uses a whitespace heuristic for column versus value** (`adapter/handlers/expression/coalesce.ts:15-23`). A string with a space becomes a bound value. Its alias is unvalidated, while the exported `coalesce(f, as)` validates.
- **X12 Documentation and type mismatches** (false sentences, not behaviour):
  - The `SubqueryBuilder.where` JSDoc shows an object form that fails (S2).
  - The `rawExists` JSDoc shows `rawExists(orm.select(...))`, which TS rejects (F8).
  - The `wCount` JSDoc at `window-functions.ts:297` calls `.over(...)`, which does not exist.
  - `stringAgg` is exported by `dx/index.ts` but not by the root barrel.
- **X13 Dead modules:**
  - `functions.ts` (also #1046).
  - `typed-query-builder.ts` (`FromBuilder`, `createTypedOrm`).
  - The duplicate `range*` functions in `filters.ts:418-470`.
- **X14 The CASE-result rule is implemented twice** (`core/resolved-conditions.ts:789-805` and `adapter/handlers/expression/case-value.ts:35-86`). In the second, every non-null, non-boolean, non-number value is bound, including a string `literal()`. Two lowerings (SELECT list versus WHERE/resolved) cause the other differences above, an overlap with #891 [A on the exact split].
- **X15 `inSubquery` plans differently for a string left than for a CR left.** A string left rewrites to EXISTS when it matches a foreign key; a CR left stays `= ANY (SELECT …)` (probes e7/e8). The plan output changes with the argument type.
- **X16 Cursor pagination with a NULL sort key** [A, code read: `pagination-impl.ts:63-77` plus `literal-null.ts:30`]. The next-page cursor condition becomes `gt(field, null)` and throws.
- **X17 `ExpressionRef.as`, `asExpr`, `count(…, alias)`, `QueryBuilder.coalesce` and `withIndex` do not validate aliases.** The compiler quotes them, so this is only a validation inconsistency. `relationColumn`, `col`, `raw` and the exported `coalesce` do validate.
- **X18 A `ColumnRef` passed directly to `fn`, `op`, `array`, an `eq` right operand, a CASE result or a `set` value is bound as a garbage object** (`{"_type":…}`), never resolved. Only the string-left overloads of `eq` and similar helpers accept it at type level; every helper typed `ExprInput` rejects it. Out of this finding: `param(ColumnRef)`, which binds its content by design (ADR 0011 rule 3), and `cast(ColumnRef)`, which reads `.intent` and creates no parameter (E10).