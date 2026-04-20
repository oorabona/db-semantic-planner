# Architectural Patterns

This document catalogues the recurring design patterns used in db-semantic-planner. Each entry covers intent, structure, a concrete example, naming conventions, and decision criteria for applying the pattern to new code.

---

## Table of Contents

1. [Handler Dispatch](#1-handler-dispatch)
2. [Immutable Fluent Builder](#2-immutable-fluent-builder)
3. [Visitor Dispatcher](#3-visitor-dispatcher)
4. [Strategy Pattern — Include Strategies](#4-strategy-pattern--include-strategies)
5. [Ports and Adapters](#5-ports-and-adapters)
6. [3-Layer AST Pipeline](#6-3-layer-ast-pipeline)
7. [CompilerFns Coordinator](#7-compilerfns-coordinator)
8. [MutationBuilderBase Template Method](#8-mutationbuilderbase-template-method)

---

## 1. Handler Dispatch

### Intent

Decouple the SQL compiler from the logic of each individual operator or expression kind. Each operator registers a handler object; the compiler looks up and dispatches to the correct handler at compile time. Adding a new operator never touches the compiler core.

### Structure

| Role | File |
|------|------|
| Handler interfaces | `packages/adapter-pgsql/src/handlers/types.ts` |
| Registry + lookup | `packages/adapter-pgsql/src/handlers/index.ts` |
| WHERE handlers | `packages/adapter-pgsql/src/handlers/where/` |
| Expression handlers | `packages/adapter-pgsql/src/handlers/expression/` |
| Include handlers | `packages/adapter-pgsql/src/handlers/include/` |

Three independent registries exist, one per handler family:

```
WhereHandler    { operators: string[]; compile(decision, ctx, state, dispatch): Node }
ExpressionHandler { operators: string[]; compile(decision, ctx, state): Node }
IncludeHandler  { operators: string[]; compile(decision, ctx, state): IncludeResult }
```

Registration:

```typescript
registerWhereHandler(handler: WhereHandler): void   // throws on duplicate
registerExpressionHandler(handler: ExpressionHandler): void
registerIncludeHandler(handler: IncludeHandler): void
```

Lookup (throws if missing):

```typescript
getWhereHandler(operator: string): WhereHandler
getExpressionHandler(operator: string): ExpressionHandler
getIncludeHandler(operator: string): IncludeHandler
```

### Example

Adding a WHERE handler for `ILIKE`:

```typescript
// packages/adapter-pgsql/src/handlers/where/pattern.ts
const ilikeHandler: WhereHandler = {
  operators: ['ilike', 'not_ilike'],
  compile(decision, ctx, state, dispatch) {
    // return PostgreSQL AST node
  },
};

// packages/adapter-pgsql/src/handlers/where/index.ts
registerWhereHandler(ilikeHandler);
```

The compiler calls `getWhereHandler(decision.operator).compile(...)` — no switch statements.

### Convention

- Handler files live in `handlers/{where,expression,include}/`
- Each file exports one handler object (not a class)
- Handler registration happens in the `index.ts` of each sub-directory via `registerAllWhereHandlers()` / equivalent
- Handler interfaces are in `handlers/types.ts` — never inline types in handler files
- `ensureHandlersRegistered()` in `handlers/index.ts` is called lazily before first use

### When to use

Use this pattern whenever the compiler must dispatch over a closed set of operator/kind names that is expected to grow over time. Do NOT use a switch statement in the compiler itself.

---

## 2. Immutable Fluent Builder

### Intent

Provide a chainable, type-safe API for constructing query and mutation intents without mutating shared state. Every method call returns a new builder instance with updated state — the original is unchanged. The builder only materializes to SQL/execution at the terminal call (`.all()`, `.one()`, `.execute()`, `.dump()`).

### Structure

| Builder | File | Terminal methods |
|---------|------|-----------------|
| `QueryBuilderImpl` | `packages/core/src/dx/query-builder.ts` | `.all()`, `.one()`, `.count()`, `.exists()`, `.dump()` |
| `InsertBuilder` | `packages/core/src/dx/mutation-builders.ts` | `.execute()`, `.dump()` |
| `UpdateBuilder` | `packages/core/src/dx/mutation-builders.ts` | `.execute()`, `.dump()` |
| `DeleteBuilder` | `packages/core/src/dx/mutation-builders.ts` | `.execute()`, `.dump()` |
| `UpsertBuilder` | `packages/core/src/dx/mutation-builders.ts` | `.execute()`, `.dump()` |
| `CteQueryBuilder` | `packages/core/src/dx/cte-builder.ts` | `.all()`, `.dump()` |
| `RecursiveQueryBuilder` | `packages/core/src/dx/recursive-query-builder.ts` | `.all()`, `.dump()` |
| `SetOperationBuilder` | `packages/core/src/dx/set-operation-builder.ts` | `.all()`, `.dump()` |

Public interface: `QueryBuilder` (in `query-builder-types.ts`). The `Impl` class is internal.

Invariant enforced by `buildIntent()`: the builder collects state into an `Intent` object only when materialization is requested. State is stored as `readonly` fields; each method spreads the current `baseOpts` into a new constructor call.

### Example

```typescript
// Each step produces a new builder — nothing mutated
const result = await orm
  .select('orders')
  .where(eq('status', 'pending'))
  .orderBy('created_at', 'desc')
  .limit(20)
  .all();
```

```typescript
// InsertBuilder — same pattern
const inserted = await orm
  .insert('users')
  .values({ name: 'Alice', email: 'alice@example.com' })
  .returning(['id', 'created_at'])
  .execute();
```

### Convention

- Every fluent method returns `this constructor type` (not `this`) — enables subclass chaining
- Builder state is passed through constructor options (`MutationBaseOpts`, etc.), never via property mutation
- `buildIntent()` is `protected` — called only by terminal methods
- `dump()` is always available without an adapter; execution methods require an adapter

### When to use

Use for any user-facing API that constructs a compound declarative artifact (a query, mutation, CTE, set operation). Do not accumulate state in a mutable object that users pass around.

---

## 3. Visitor Dispatcher

### Intent

Keep the Chevrotain CST visitor class as a thin dispatcher — one method per grammar rule, each delegating immediately to a domain module. All real logic lives in `visit-*.ts` files, not in the visitor class. This makes each domain independently testable and prevents the visitor from becoming a 2000-line monolith.

### Structure

| Role | Location |
|------|----------|
| Dispatcher class | `packages/nql/src/semantic/visitor.ts` — `NqlCstVisitor` |
| Domain modules | `packages/nql/src/semantic/visit-query.ts`, `visit-expression.ts`, `visit-literal.ts`, `visit-mutation.ts`, `visit-cte.ts`, etc. |
| Public entry point | `cstToAst(cst): { ast: NqlProgram; warnings: NqlWarning[] }` |

`NqlCstVisitor` holds a single `VisitFn` (`this.v = (node) => this.visit(node)`) and passes it to every domain function so they can recurse without importing the visitor class.

```typescript
// visitor.ts — thin dispatcher
export class NqlCstVisitor extends BaseCstVisitor {
  private readonly v: VisitFn;

  query(ctx: CstContext) {
    return visitQuery(ctx, this.v);   // delegate immediately
  }

  whereClause(ctx: CstContext) {
    return visitWhereClause(ctx, this.v);
  }
  // ... one line per grammar rule
}
```

```typescript
// visit-query.ts — domain logic
export function visitQuery(ctx: CstContext, visit: VisitFn): NqlQuery {
  // real implementation here
}
```

### Example

Adding a new grammar rule `havingClause`:

1. Add `havingClause(ctx) { return visitHavingClause(ctx, this.v); }` to `NqlCstVisitor`
2. Create `visit-having.ts` with `export function visitHavingClause(ctx, visit): NqlHaving { ... }`
3. Import and call from `visitor.ts` — no other changes

Note: Chevrotain requires a stub method even for rules handled inside another visitor method (`anySuffix` stub in visitor.ts is a documented example of this).

### Convention

- One `visit-*.ts` file per domain (query structure, expression, literal, mutation, CTE)
- Every exported function signature: `visitXxx(ctx: CstContext, visit: VisitFn, ...extras): NqlXxx`
- Warnings are passed as an extra parameter when a visitor may emit them (e.g., `visitJsonAccessExpr`)
- The `NqlCstVisitor` singleton is created once at module load: `export const nqlVisitor = new NqlCstVisitor()`

### When to use

Use when a grammar-driven visitor would exceed ~50 lines of real logic. Add a new `visit-*.ts` module rather than adding logic to `visitor.ts`. The visitor file must remain a pure dispatcher.

---

## 4. Strategy Pattern — Include Strategies

### Intent

The planner must choose how to fetch related data for each `IncludeIntent` without the core logic knowing about PostgreSQL-specific capabilities. The strategy is an enum value on the `IncludeIntent`; the adapter dispatches to the matching `IncludeHandler` at compile time.

### Structure

| Role | Location |
|------|----------|
| Strategy type | `packages/types/src/model-ir.ts` — `IncludeStrategy` |
| Strategy inference | `packages/core/src/planner.ts` — `validateStrategy()` |
| Handler dispatch | `packages/adapter-pgsql/src/handlers/index.ts` — `getIncludeHandler()` |
| Concrete handlers | `packages/adapter-pgsql/src/handlers/include/lateral.ts`, `join.ts`, `json-agg.ts`, `subquery.ts`, `cte.ts` |
| Dialect capabilities | `packages/types/src/adapter.ts` — `DialectCapabilities` |

Strategies:

| Value | SQL form | Best for |
|-------|----------|----------|
| `'join'` | `LEFT JOIN` | to-one relations (belongsTo, hasOne) |
| `'lateral'` | `CROSS JOIN LATERAL` | to-many with LIMIT |
| `'json_agg'` | JSON subquery aggregation | to-many, no row explosion (PostgreSQL default) |
| `'subquery'` | correlated subquery | to-many, safe but potentially N+1 |
| `'cte'` | `WITH RECURSIVE` | recursive / hierarchical trees |
| `'auto'` | planner decides | default — resolved before compilation |

### Example

Schema-level hint:

```typescript
const schema = defineSchema({
  users: table({
    posts: hasMany(() => posts, { includeStrategy: 'lateral' }),
  }),
});
```

Auto-resolution (planner, `planner.ts`):

```
cardinality='one'  → 'join'
cardinality='many' → dialect.supportsJsonAgg ? 'json_agg'
                   → dialect.supportsLateral  ? 'lateral'
                   → 'join' (fallback)
```

### Convention

- `'auto'` is always resolved to a concrete strategy before `PlanReport` is emitted — it never reaches the compiler
- Adapter handlers match the strategy name exactly (file name = strategy name)
- New strategies require: a new literal in `IncludeStrategy`, a capability flag in `DialectCapabilities`, a handler in `include/`, and a planner rule
- Schema-level `includeStrategy` overrides auto, but is validated against `DialectCapabilities`

### When to use

Use the strategy pattern for any decision that has multiple valid implementations and where the choice is delegated to the planner (core) while the implementation lives in the adapter. Never add an `if (strategy === 'json_agg')` branch inside the planner.

---

## 5. Ports and Adapters

### Intent

Keep `packages/core` completely database-agnostic. The core defines the `Adapter` port (interface); adapter packages implement it. This means the entire query planning and DX layer can be unit-tested without a database, and alternative adapters (MySQL, SQLite) can be added without touching core.

### Structure

```
packages/types/src/adapter.ts      ← Port: Adapter interface hierarchy
packages/core/src/dx/              ← Uses Adapter, never imports adapter-pgsql
packages/adapter-pgsql/src/        ← Implements Adapter<DB>
```

Adapter interface hierarchy (composition via extends):

```
BaseAdapter
  └─ CompilingAdapter    (compile, compileWithIncludes, compileInsert, ...)
  └─ ExecutingAdapter    (execute, createDump)
  └─ StreamingAdapter    (stream)
  └─ IntrospectingAdapter (introspect)
  └─ TransactionalAdapter (transaction, withSchema)
  └─ RawSqlAdapter       (raw)
  └─ DDLGeneratingAdapter (generateDDL, compareSchemata, ...)
  └─ TableDDLGeneratorAdapter (truncate, vacuum, alterColumn, ...)
       └─ Adapter<DB>    ← full capability union
```

Injection:

```typescript
const orm = createOrm({
  model: schema,
  adapter: createPgsqlAdapter(pool),   // <-- inject at edge
});
```

### Example

Testing core logic without a database:

```typescript
// core unit tests use createMockAdapter() from test-utils.ts
// which implements only the Adapter methods needed for the test
const adapter = createMockAdapter({ compile: vi.fn().mockReturnValue(...) });
const orm = createOrm({ model: schema, adapter });
```

### Convention

- `packages/core/src/**` MUST NOT contain any import from `packages/adapter-pgsql`
- Adapter interface is the only coupling point — core never calls `PgsqlAdapter` directly
- `compile-only` mode: `createPgsqlCompileOnlyAdapter()` — no `Pool` required, useful for CLI/tooling
- Schema-scoping: `adapter.withSchema(name)` returns a new scoped adapter — core calls this, adapter implements it

### When to use

Any new capability that requires database interaction must be expressed as a method on one of the `*Adapter` interfaces in `packages/types/src/adapter.ts`, then implemented in `adapter-pgsql`. Core code calls the interface method — it never calls pg directly.

---

## 6. 3-Layer AST Pipeline

### Intent

Separate concerns across three distinct AST representations, each adding a layer of resolution. User-facing syntax (NQL string or fluent builder) is never directly compiled to SQL — it passes through two normalizing layers first, making each layer independently testable and substitutable.

### Structure

```
Layer 0: User input
         NQL string  ──or──  fluent builder API
              │                        │
              ▼                        ▼
Layer 1: NQL AST (packages/nql/src/parser/ast.ts)
         NqlProgram → NqlQuery → NqlExpression → ...
         (concrete syntax, close to what the user wrote)
              │
              ▼  NqlCompiler (compile-query.ts, compile-expression.ts, ...)
Layer 2: IntentAST (packages/types/src/intent/)
         QueryIntent / MutationIntent / IncludeIntent / WhereIntent / SelectIntent
         (semantic intent, DB-agnostic)
              │
              ▼  Planner (packages/core/src/planner.ts)
Layer 3: PlanReport (packages/types/src/planner.ts)
         { decisions: PlanDecision[], warnings: PlanWarning[], intent: QueryIntent }
         (resolved decisions with strategy choices and reasoning)
              │
              ▼  Adapter compiler (packages/adapter-pgsql/src/compiler.ts)
Layer 4: SQL + Parameters
         { sql: string, parameters: unknown[] }
```

Layer 1 is produced only when NQL is used. The fluent builder API emits Layer 2 directly.

### Key types per layer

| Layer | Key type | Package |
|-------|----------|---------|
| NQL AST | `NqlProgram`, `NqlQuery`, `NqlExpression` | `@dbsp/nql` |
| IntentAST | `QueryIntent`, `MutationIntent`, `IncludeIntent` | `@dbsp/types` |
| PlanReport | `PlanReport`, `PlanDecision`, `PlanWarning` | `@dbsp/types` |
| Compiled | `CompiledQuery` | `@dbsp/types` |

### Example

Observability — `dump()` exposes all layers:

```typescript
const { plan, sql, params } = await orm.select('users').where(eq('active', true)).dump();
// plan.decisions — every strategy choice with reasoning
// sql            — final parameterized SQL
// params         — bound parameter values
```

### Convention

- IntentAST is the canonical exchange format between core and adapter — never pass NQL AST to the adapter
- `PlanReport.intent` preserves the original `QueryIntent` for debugging
- `PlanDecision` records: `kind`, `strategy`, `reasoning`, `alternatives[]` — never omit reasoning
- Mutations bypass the planner (no `PlanReport`) — they go IntentAST → adapter compiler directly

### When to use

When adding a new query feature: define the `*Intent` type in `packages/types` first, then implement the builder method (Layer 2), the planner decision (Layer 3), and the compiler handler (Layer 4) independently. Tests can be written for each layer without wiring the whole pipeline.

---

## 7. CompilerFns Coordinator

### Intent

Break circular import cycles between NQL compiler modules (`compile-query` ↔ `compile-select` ↔ `compile-expression`) by passing function references explicitly rather than importing them. The `NqlCompiler` class acts as the wiring point — it constructs the `CompilerFns` bag and passes it down to every domain module.

### Structure

| Role | File |
|------|------|
| Interface | `packages/nql/src/compiler/types.ts` — `CompilerFns` |
| Wiring (coordinator) | `packages/nql/src/compiler/index.ts` — `NqlCompiler` constructor |
| Consumers | `compile-query.ts`, `compile-select.ts`, `compile-expression.ts`, `compile-mutation.ts`, `compile-cte.ts` |

```typescript
// types.ts
export interface CompilerFns {
  compileQuery(query: NqlQuery, ctx: CompilerContext): QueryIntent | SetOperationIntent;
  compileSelectClause(clause: NqlSelectClause, ctx: CompilerContext, fns: CompilerFns): SelectIntent;
  compileExpression(expr: NqlExpression, ctx: CompilerContext, fns: CompilerFns, ...): WhereIntent;
}
```

```typescript
// NqlCompiler constructor — wires the functions once
this.fns = {
  compileQuery:       (query, ctx)        => compileQuery(query, ctx, this.fns),
  compileSelectClause:(clause, ctx, fns)  => compileSelectClause(clause, ctx, fns),
  compileExpression:  (...args)           => compileExpression(...args),
};
```

Every domain function receives `fns` as a parameter and calls `fns.compileQuery(...)` rather than importing `compileQuery` directly.

### Example

A new compiler module that needs to recursively compile sub-expressions:

```typescript
// compile-window.ts
export function compileWindowClause(
  clause: NqlWindowClause,
  ctx: CompilerContext,
  fns: CompilerFns,       // <-- receive, don't import
): WindowIntent {
  const partitionExprs = clause.partition.map(e => fns.compileExpression(e, ctx, fns));
  // ...
}
```

### Convention

- `CompilerFns` contains only the three cross-cutting functions that cause circular dependencies
- Every new compiler module that needs recursion must accept `fns: CompilerFns` as a parameter — never import sibling compiler modules directly
- `NqlCompiler` is the single wiring point; `createCompiler()` is its factory
- `CompilerContext` (immutable) and `CompilerFns` are always passed together

### When to use

Use this pattern whenever two or more modules in the same compiler layer need to call each other. Passing function references through `CompilerFns` instead of direct imports eliminates the circular dependency without resorting to dynamic `require()` or lazy imports.

---

## 8. MutationBuilderBase Template Method

### Intent

Share the `dump()` and `execute()` terminal methods across all four mutation builders (`InsertBuilder`, `UpdateBuilder`, `DeleteBuilder`, `UpsertBuilder`) while allowing each subclass to define its own intent construction and compilation logic. The abstract base provides the skeleton; subclasses fill in the variable steps.

### Structure

| Role | Location |
|------|----------|
| Abstract base | `packages/core/src/dx/mutation-builders.ts` — `MutationBuilderBase<T, TIntent>` |
| Concrete builders | `InsertBuilder`, `UpdateBuilder`, `DeleteBuilder`, `UpsertBuilder` in the same file |
| Dump type | `MutationDump` interface |

Template method skeleton (on `MutationBuilderBase`):

```
dump()      → buildIntent() → compileIntent(adapter, intent, options) → MutationDump
execute()   → buildIntent() → compileIntent(adapter, intent, options) → adapter.execute(...)
```

Abstract methods that subclasses must implement:

```typescript
protected abstract buildIntent(): TIntent;
protected abstract compileIntent(
  adapter: Adapter,
  intent: TIntent,
  options?: CompileOptions,
): CompiledQuery;
```

Concrete methods shared by all subclasses (on base):

- `dump()` — compiles without executing, returns `{ sql, params, intent }`
- `execute()` — compiles then executes via adapter, returns `T`

### Example

`InsertBuilder` overrides the two abstract methods:

```typescript
protected buildIntent(): InsertIntent {
  if (this.valuesData.length === 0) {
    throw new InvalidOperationError('insert', 'No values provided for insert');
  }
  return { type: 'insert', table: this.table, values: this.valuesData };
}

protected compileIntent(adapter: Adapter, intent: InsertIntent, options?: CompileOptions): CompiledQuery {
  return adapter.compileInsert(intent, options);
}
```

Adding a new mutation type (e.g., `MergeBuilder`) requires only implementing `buildIntent()` and `compileIntent()` — `dump()` and `execute()` are inherited.

### Convention

- All state for a mutation builder is stored in `readonly` properties set via the constructor
- `baseOpts` (spread pattern) is used to propagate existing state into new instances from fluent methods
- `compileIntent` calls the corresponding `adapter.compileXxx()` method — one-to-one mapping
- `MutationDump` is the common return type for all `dump()` calls — `{ sql, params, intent }`
- Mutations do NOT go through the planner — there is no `PlanReport` for mutations

### When to use

Use `MutationBuilderBase` whenever adding a new DML operation type that follows the build → compile → execute lifecycle. Do not duplicate `dump()` / `execute()` logic in a standalone builder class.

---

## Pattern Interaction Map

```
User NQL string
  │  Visitor Dispatcher (Pattern 3) — thin dispatch to visit-*.ts modules
  ▼
NQL AST
  │  CompilerFns Coordinator (Pattern 7) — wires compile-query/select/expression
  ▼
IntentAST
  │  Strategy Pattern (Pattern 4) — planner selects IncludeStrategy
  ▼
PlanReport
  │  Ports and Adapters (Pattern 5) — Adapter interface, not pg directly
  │  Handler Dispatch (Pattern 1) — operator/kind → handler.compile()
  ▼
SQL + Parameters

User fluent API
  │  Immutable Fluent Builder (Pattern 2) — select/where/orderBy chain
  │  MutationBuilderBase (Pattern 8) — insert/update/delete/upsert template
  ▼
IntentAST → (same pipeline from IntentAST above)

All layers: 3-Layer AST Pipeline (Pattern 6) governs how layers relate
```
