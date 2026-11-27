# ADR 0010: Core Models the Intent Language; Refusals Are Semantic, Capability or Not Yet

## Status

Accepted (2026-11-19). The operator decided it during #891 slice 5b: core should model as much as it can, and the
adapter should find a way to realise it or refuse it. It governs how query constructs are refused from now on, starting
with the subquery bodies of #891 slice 5b.

## Context

ARCH-001 splits the *what* from the *how*. Core turns a `QueryIntent` into a resolved execution without importing an
adapter. Adapters describe what they realise through `DialectCapabilities` (`packages/types/src/dialects.ts:80`), an
abstract contract that both sides read:
- the planner uses it to select and validate include strategies (`ARCHITECTURE.md`, "Strategy Selection Algorithm");
  `validateStrategy` (`packages/core/src/planner.ts:1623`) refuses an explicit strategy whose flag is unavailable;
- the adapter's NQL text checks use `assertDialectCapability` (`packages/adapter-pgsql/src/dialect-capabilities.ts:18`),
  which refuses only a flag set explicitly to `false`, as `<feature> not supported by this adapter`. An undeclared flag
  is accepted, as ADR 0001 decided.

A flag records what an adapter realises today, not what the database engine could do. The MySQL profile sets its lock
flags to `false` with the comment "revisit MySQL with per-strength caps" (`packages/core/src/dialects/index.ts:87`).

Core also refuses query constructs that are valid SQL and valid intent, only because its resolved form has no place for
them. Measured on `main` at `d41cfeb0`, with probes `m1` and `m2` of #891 slice 5b. The example is a scalar subquery
built from a `QueryIntent`, used with `.asExpr()`, with a model available.

Which route a body takes depends on its position, on the filter configuration and on how the body was built. The
routes below are examples, not an exhaustive list.
- **In the root WHERE**, an expression subquery reaches core's resolver (`packages/core/src/resolved-includes.ts:830`
  resolves `intent.where` unconditionally). So does a HAVING condition that names an aggregate alias, as a whole
  (`packages/core/src/resolved-includes.ts:977`).
- **In SELECT, ORDER BY, and a HAVING condition that names no aggregate alias**, an expression subquery node reaches core's resolver when it scans a table with a default
  filter, or when it carries an attached relational read policy at any depth
  (`packages/core/src/resolved-includes.ts:931`). A nested builder such as `rawExists(builder)` attaches a policy even
  when no filter is configured (`packages/core/src/relational-read-plans.ts:48`). Otherwise the body takes the adapter's
  legacy route.
- **`orm.selectExpression()`** compiles the body with the root planner (`packages/adapter-pgsql/src/pgsql-adapter.ts:3539`),
  so it already realises clauses that the other routes refuse, a lock among them.
- **When the body reaches core's resolver**, core refuses GROUP BY, HAVING, DISTINCT, DISTINCT ON, OFFSET, a lock, joins,
  `include`, and an expression projection. The message is "scalar subquery with GROUP BY is not supported — it would
  silently change which rows match; restructure the query or use a CTE."
- **On the legacy route**, GROUP BY, HAVING, DISTINCT, DISTINCT ON, OFFSET and an expression projection compile. A
  `.join()` and an `include` are dropped without a word. The SQL is `SELECT posts.id FROM posts AS posts WHERE …`, with
  no join, so the rows are wrong.

These facts mean three things:
- The same intent succeeds or fails depending on its position, on a filter configuration, or on how the body was
  built. That behaviour depends on the route, not on the intent.
- The refusal message describes a missing shape in core's resolved model as a semantic risk. GROUP BY in a correlated
  scalar subquery does not "silently change which rows match"; core simply does not model it there.
- Every construct named above is meaningful SQL in that position. The root query already models each of them.

## Decision

### Core models what its intent language expresses, at every depth

If `QueryIntent` (or `WhereIntent`, `ExpressionIntent`) accepts a construct, core resolves it wherever it appears:
- in the root query;
- in a subquery body, in any position;
- in a CTE, a binding, or a recursive step.

The resolved form of a nested query is the same as the root's. A subquery body is a nested select execution, resolved
by the same resolver, not a reduced shape that drops clauses.

Core may still read `DialectCapabilities` to choose how a construct is realised, as the planner does for include
strategies. It does not read them to decide whether a construct can be represented.

### Refusals of query constructs are of exactly three kinds

The taxonomy covers refusals that a query construct is not supported. It does not govern validation of input or of the
model, physical naming (ADR 0009), plan authority, safety policies such as a DELETE without WHERE, admission, or
execution errors.

1. **Semantic: permanent, whatever the adapter.** The construct has no meaning in that position.
   - Example: a scalar subquery whose body projects more than one column, because a scalar subquery yields one value.
   - Example: an `include` whose result is nested hydration (an object or array per row) in a scalar body. A `flat`
     include is a join and has a scalar reading; it is not a semantic refusal.
   - The message names the construct, the position and why it has no meaning there.
2. **Capability: keyed on `DialectCapabilities`.** The applicable capability contract says the adapter does not
   realise the construct.
   - The flag says what the adapter realises, whatever the cause: an engine limit, a partial translation, or a choice.
   - The check reads the flag through the abstract contract, in core's planner or in the adapter. How an undeclared
     flag is read is that check's existing contract; ADR 0001 settles it for the NQL text surface.
   - Example: an explicit `lateral` include strategy when `supportsLateralJoin` is unavailable (`validateStrategy`).
3. **Not yet: temporary, anywhere.** The construct is meaningful in that position, the capability contract does not
   refuse it, and the code path for that construct in that position does not exist yet.
   - A general flag that is true does not prevent it. Example: `supportsRowLevelLocks` is true for PostgreSQL, and
     `orm.selectExpression()` emits a lock in a scalar body, while core's resolved subquery body refuses one today.
   - A local gap is not fixed by turning a flag off or by adding a flag per position. ADR 0001 asks an adapter to set
     a capability to `false` when it cannot preserve the construct's semantics; that obligation concerns an adapter
     that does not realise the construct at all, not a position that one route has not reached yet.
   - It is raised as a `NotYetSupportedError` (below), never as a bare `Error`.
   - It always names an open issue.
   - It never claims a semantic risk.

### How a not-yet refusal is materialised

1. **A typed error in `@dbsp/types`.** `NotYetSupportedError` lives beside `AmbiguousIncludeError`
   (`packages/types/src/include-errors.ts`), the one package that core, nql and the adapter may all import under
   ARCH-001. It is exported from the package root.
   - Its fields are `construct` (for example `'lock'`), `position` (for example `'scalar subquery body'`) and `issue`, a
     number the constructor requires.
   - The class builds the message, never the call site: `<construct> in a <position> is not supported yet (#<issue>).`
     It writes "an" instead of "a" before a position that starts with a vowel (a, e, i, o, u).
   - A consumer recognises it with `instanceof` or by its `issue` field, without parsing text, at every public entry:
     - an ORM entry point (`orm.select(...)`, a builder's `dump()`, `orm.nql`) throws the `NotYetSupportedError` itself,
       not a generic error built from its message (`packages/core/src/dx/nql.ts:1594` does that today);
     - nql's `compile()` reports it as a failed result whose error carries a dedicated code and the `issue` number, not
       `SEM_UNREACHABLE` (`packages/nql/src/index.ts:181` does that today).
2. **The issue exists before the code.** When a slice is specified, every construct and position it does not realise
   gets an issue, and the refusal names that number.
3. **One test per refusal, driven through a public entry.** It asserts the class (or nql's code), the issue number and
   the exact message as the consumer receives them. When the issue lands, the
   same input becomes a success test; that change is what proves the refusal is gone.
4. **Before a release**, the `NotYetSupportedError` call sites are listed with the state of their issue; one whose
   issue is closed is a defect to fix before publishing.

Semantic refusals keep their existing error classes, such as `InvalidOperationError`. Capability refusals keep the
`<feature> not supported by this adapter` form.

### Intent is the contract

Core never accepts an intent shape that it then compiles differently from its meaning. A construct that a route cannot
honour is refused with one of the three kinds above, never dropped. A silent drop, like the join and `include` above, is
a defect, whatever the route.

## Consequences

- **#891 slice 5b** resolves expression-subquery bodies as nested select executions.
  - It removes core's gate that sends SELECT, ORDER BY and HAVING bodies without a policy or a default-filter scan to
    the legacy route.
  - It removes the adapter's legacy inner-plan compile of those bodies.
  - The resolved body type grows to the root's clauses, which settles #1007 (an expressions SELECT in a scalar body).
  - DISTINCT ON in a body is modelled as at the root. No capability flag covers DISTINCT ON today, and adding one waits
    for an adapter that does not realise it.
  - A projection of more than one column in a scalar body, and a nested-hydration `include` in a scalar body, become
    semantic refusals. A `flat` include in a body is either modelled or a not-yet refusal with its issue.
- **The condition bodies** of `rawExists`, IN and scalar comparisons move to the same nested form afterwards, as the
  remainder of #891.
- **Existing not-yet refusals** move to `NotYetSupportedError` in a migration with its own spec (#1027), which takes the
  inventory. The inventory counts the points where a refusal is raised, not the helpers that build a message: one
  helper can feed several refusals (`packages/types/src/intent/join-include.ts:111` feeds three). A search for "not
  supported yet" or "not yet supported" at `d41cfeb0` already finds these families, and the spec's own search may find
  more:
  - many-to-many traversal (#787);
  - relation predicates inside an include `where` (#892);
  - correlated subqueries inside an include, in core and in the adapter;
  - a recursive include whose target has a default filter;
  - set operations in nql's CTE compiler (`packages/nql/src/compiler/compile-cte.ts:53`, `:68`), which name no issue
    and get one.
- **Existing refusals** that describe a missing shape as a semantic risk are reworded as not-yet refusals with an issue,
  or removed when the shape lands. `assertNoUnsupportedSubqueryModifiers`
  (`packages/types/src/subquery-options.ts:3`) is the first one in scope.
- **Not every construct must land at once.** A construct can stay a not-yet refusal while its issue is open. The rule
  forbids two things only: refusing it as a semantic risk, and dropping it.
- **Cost.** Core's resolved model grows, and published `@dbsp/types` resolved types widen. Each widening is listed in its
  release notes.

## Deliveries

- #891 slice 5b: expression-subquery bodies. Not started; this ADR is its premise.
- #1027: not-yet refusals raised as `NotYetSupportedError`. Delivered for the refusals worded "not yet" and for
  `assertNoUnsupportedSubqueryModifiers`; the refusals worded only "not supported" are classified in #1088.
