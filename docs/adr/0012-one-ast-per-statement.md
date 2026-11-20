# ADR 0012: The PostgreSQL Adapter Compiles Each Statement into One AST

## Status

Accepted (2026-11-20). Tracked in #1055. The operator decided it after measuring the adapter's composition paths;
Codex challenged it over three rounds (round 3 CLEAN).

## Context

The adapter (`packages/adapter-pgsql`) turns a planned intent into a PostgreSQL syntax tree: `SelectStmt`, `A_Const`
for constants, `ParamRef` for `$N` parameters. Its internal deparser (`pgsql-deparser.ts`) then turns that tree into
SQL text. Parameters are `ParamRef` nodes. Where one part of a query is compiled on its own, its parameters are
already shifted *in the tree* before the final deparse, which is safe by construction. This is the case for
expression subqueries (`compiler.ts:1945` via `renumberParamRefsInAst`), resolved condition bodies
(`resolved-condition-compiler.ts:398`) and precompiled JOINs (`compiler.ts:2887`).

Other composition paths work on SQL text instead (#1055 measurement, probes p1-p13, plus Codex's review of this ADR):

- **Separately deparsed operands, concatenated, then renumbered by regex** (`/\$(\d+)/g` over the finished text):
  - set operations (`set-operation.ts:59`, used at `:107`);
  - simple CTEs after earlier CTEs (`adapter-compiler-recursive.ts:917`);
  - the outer query after CTEs (`:971`);
  - a rawCte, `orm.recursive`'s base and step assembled as text (`:887`, `:1141`);
  - a mutation after its source CTE (`adapter-compiler-mutations.ts:166`, `prependSourceCte`);
  - NQL bindings and the final query (`pgsql-adapter.ts:1566`, used at `:3376` and `:3409`);
  - the joined `dump()` of an NQL program, in core (`core/src/dx/nql.ts:1374`).
- **Text built with an offset, never renumbered afterwards.**
  - NQL runtime bindings (`pgsql-adapter.ts:2065-2079`, `UNION ALL VALUES` starting at `parameterOffset + 1`).
  - The rawCte depth guard (`adapter-compiler-recursive.ts:1159`).
- **Already structured.**
  - Native recursion (`compileRecursive` → `buildRecursiveCte`, `adapter-compiler-recursive.ts:696`, `:755`) builds a
    `WithClause` and deparses once.
  - The `unnest` CTE builds a node, and its counter starts at the previous parameter count (`:845`).
- **Structure read back from emitted text**, inside query and mutation compilation:
  - the recursive step finds `WHERE` with `/\bWHERE\b/i` (`:1156`);
  - NQL binding CTEs are spliced by finding `WITH [RECURSIVE]` with a regex (`prefixNqlBindingCtes`,
    `pgsql-adapter.ts:1584`).

Measured consequences:
- **The regexes corrupt data.** `'Price: $1'` becomes `'Price: $2'`, and a column named `cost$1` becomes `"cost$2"`.
  Both go through public APIs with ordinary input and produce no error. A string constant containing `WHERE` turns a
  recursive step into invalid SQL.
- **Leaf ASTs are lost.** `finalizeEnvelope` returns a `CompiledQuery` with no AST (`projection-envelope.ts:658`;
  `types/src/adapter.ts:121`). The public `createLeafCompileFn`/`compileSetOperation` pair composes such
  `CompiledQuery` callbacks (`set-operation.ts:161`; exported at `index.ts:225`). The CLI, the GUI executor and its
  assertions use it (`cli/src/repl/nql-executor.ts:289`; `gui/sidecar/query-executor.ts:290`;
  `gui/sidecar/assertion-handler.ts:210`).
- **The deparser does not yet render every composed form correctly.**
  - It concatenates set-operation branches without parentheses (`pgsql-deparser.ts:954`).
    - `(SELECT 1 UNION SELECT 2) INTERSECT SELECT 2` would lose its grouping.
    - An operand's `LIMIT` either makes the SQL invalid (a left operand) or attaches to the composed result instead of
      the operand (a right operand: `SELECT 1 UNION SELECT 1 LIMIT 1` limits the whole union).
  - It ignores `withClause` on set-operation roots (`:975`) and on INSERT/UPDATE/DELETE (`:1067`).
- **Core handles PostgreSQL syntax.** `nql.ts:1374` renumbers `$N` text, which ARCH-001 leaves to the adapter.

## Decision

### One statement, one AST, one deparse

The final SQL of each statement the adapter emits for a query or a mutation is produced by deparsing one complete
PostgreSQL AST of that statement. No statement's SQL is assembled from text fragments. An intermediate deparse whose
text is discarded, as `nestedSelectCompiler` does today (`adapter-compiler-select.ts:1501`, `:1525`), is not text
composition. Removing such waste is allowed but not required by this ADR.
- **Composite operands are nodes, not text.**
  - A set operation is a `SelectStmt` with `op`, `larg` and `rarg`.
  - A `WITH` is a `WithClause` of `CommonTableExpr` nodes. This covers simple, unnest, recursive and rawCte forms,
    and NQL binding CTEs, runtime ones included (their `VALUES` rows become nodes).
  - A mutation preceded by a source holds the source query as a `CommonTableExpr` in its own `WithClause`.
- **Parameters exist only as `ParamRef` nodes.** One compiler state numbers them, or a subtree compiled on its own has
  its `ParamRef`s shifted in the tree before the single deparse, as today's AST paths already do. No placeholder is
  renumbered as text, and no `$N` regex remains in query or mutation compilation.
- **Structure is read from the tree, never from emitted text**, within query and mutation compilation: the `WHERE`
  check of the recursive step and the NQL `WITH` splice.

### The deparser renders composed nodes faithfully

The deparser change is part of this decision.
- **Set operations.** It parenthesises every operand that is itself a set operation, whatever its kind and `ALL`
  flag, and every operand that carries `ORDER BY`, `LIMIT`, `OFFSET`, a locking clause or its own `WITH`. It does no
  associativity optimisation. Re-associating would change semantics: `A UNION ALL (B UNION C)` keeps duplicates that
  `A UNION ALL B UNION C` removes, and type resolution differs (PostgreSQL docs §7.4 and §10.5). The emitted SQL
  parses back to the same tree, with each clause on its own operand.
- **`WITH` on every root.** It emits `withClause` on set-operation roots and on INSERT, UPDATE and DELETE.

### The public text-composition entry is replaced

`createLeafCompileFn` and the callback form of `compileSetOperation` compose already-deparsed `CompiledQuery` values,
which carry no tree. They are replaced by an adapter entry that compiles a whole `SetOperationIntent` from intents in
one pass. The CLI and the GUI sidecar move to that entry. The removed exports are listed in the release notes; the
only external consumer is astix, which does not use them.

### `raw()` and `sql()` keep their own contracts

- `raw()` stays a `RawSQL` node emitted verbatim (`handlers/expression/raw.ts:32`). It binds no parameters and is
  never renumbered.
- `sql()` in `set`, `doUpdate` and batch `scalarSet` keeps its current treatment: it is parsed into structured nodes by
  `parseRawExpression` (`mutation-compiler.ts:474`, `:1196`; `upsert.ts:220`), which refuses fragments it cannot read.

### NQL programs: one AST per statement, `dump()` stays a preview

An NQL program that runs several statements, for example a mutation and then a read, consists of several statements,
each compiled into its own single AST.
- `dump()` does not execute anything (`nql-bindings.test.ts:2416`). It shows each statement as compiled for preview,
  with runtime bindings empty (`nql.ts:2105`). It cannot show parameters that only execution produces.
- Core no longer renumbers `$N` text: the joined display is removed from core. The dump keeps each statement apart,
  as decided below.

### Scope

The invariant covers query and mutation compilation in the adapter, NQL compilation included. DDL generation
(`ddl/live-diff.ts:1205` reads emitted `CREATE INDEX … WHERE`) and the `.dbsp` assertion runner (`assertSQLJoin`)
inspect SQL by design or belong to another subsystem. They are out of scope, and the DDL case is tracked separately.

### SQL text may change form, not meaning

Composed statements are now rendered by the deparser. Their parenthesisation and CTE column-list layout may differ
from today's concatenations. Exact-SQL tests are updated. Results in the database are unchanged, which the deparser
rules above guarantee.

## Multi-statement NQL program dump (operator decision 2026-11-20)

A program with several statements is several independent SQL statements, so its dump keeps them apart.
- **Per-statement record.** The dump's existing `sequence` field (`DumpSequenceStep[]`, `types/src/adapter.ts:415-430`)
  holds one entry per statement, each with its own SQL, its own `$1…` numbering, its own `params`, its `kind`
  (`'query' | 'mutation'`) and its `bindName`. Nothing is joined or renumbered.
- **Same dump type.** The program dump keeps the `Dump`/`MutationDump` type with its `plan` and `meta`.
- **Top-level fields.** The top-level `sql` and `params` (`parameters` for a program ending in a mutation) describe the
  last statement, the one whose result the program returns. They are no longer a renumbered join of all statements.
- **No nested arrays.** A nested array in `params` would be ambiguous with an array-valued parameter (`[[1, 2]]`).
- **Single-statement queries.** A single-statement NQL query is unchanged.
- **Existing test.** The test that expects `dump.parameters === ['Alice', true]` for an INSERT-then-UPDATE program
  (`nql-bindings.test.ts:2420`, `:2440`) moves to per-statement assertions on `sequence`.

## Consequences

- #1055 is fixed by construction, for constants and identifiers alike. The text-based `WHERE` check and `WITH` splice
  go away with it.
- Core no longer contains PostgreSQL placeholder syntax.
- The rewrite touches the composition code in `set-operation.ts`, `adapter-compiler-recursive.ts`,
  `adapter-compiler-mutations.ts` and the NQL compilation in `pgsql-adapter.ts`, plus the deparser's set-operation and
  `WITH` rendering.
- Exact-SQL tests of composed statements change their expected text. The set-operation tests gain cases where the
  grouping matters and where an operand has `LIMIT`; today's "nested parentheses" test only checks keywords
  (`set-operation.test.ts:310`).
- **Rejected alternatives:**
  - a hand-written SQL lexer that skips constants: it keeps reading structure from text, and four review rounds kept
    finding lexical edge cases;
  - shifting `ParamRef`s per operand and still concatenating text: it fixes the renumbering, but keeps text
    composition and the regex `WITH` splice.

## Deliveries

- #1055: compile composed statements as one AST and remove the eight renumbering sites, the text `WHERE` check and the
  `WITH` splice; deparser grouping and `WITH` support; replace the text-composition entry.
