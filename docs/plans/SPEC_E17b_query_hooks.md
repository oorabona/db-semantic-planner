---
doc-meta:
  status: draft
  scope: core
  type: specification
  created: 2026-02-05
  updated: 2026-02-05
  complexity: COMPLEX
  time-budget: 4h
---

# Specification: E17b Query Hooks System

## 0. Quick Reference (ALWAYS VISIBLE)

| Item | Value |
|------|-------|
| Scope | core (packages/core/src/dx/) |
| Complexity | COMPLEX |
| Time budget | ~5h |
| Blocks | 6 |
| BDD scenarios | 22 |
| Risk level | MEDIUM |
| Multi-LLM review | ✅ Codex + Gemini + Copilot |

## 1. Problem Statement

Developers need to intercept query/mutation execution for cross-cutting concerns (logging, auditing, caching, data transformation, tenant injection) without modifying every query call site. Drizzle ORM lacks this feature and the community has explicitly requested it (GitHub #1513, #1426, #2266). This is a key differentiator.

## 2. User Stories

### US-01: Query Auditing
**AS A** backend developer
**I WANT** to log all SELECT queries with their execution time
**SO THAT** I can monitor slow queries and debug performance issues

**ACCEPTANCE:** Hook receives query context, can access intent + SQL, timing info available in afterQuery

### US-02: Tenant Context Injection
**AS A** multi-tenant application developer
**I WANT** to automatically inject tenant context into all queries
**SO THAT** I don't have to manually add tenant filters at every call site

**ACCEPTANCE:** beforeQuery hook can modify intent (add WHERE conditions), changes reflected in executed SQL

### US-03: Query Result Transformation
**AS A** developer building a caching layer
**I WANT** to intercept query results before they're returned
**SO THAT** I can cache results or transform them (redact fields, enrich data)

**ACCEPTANCE:** afterQuery receives results, can return modified results to caller

## 3. Business Rules

### 3.1 Invariants (always true)

- **INV-01:** Hooks MUST NOT bypass security (defaultFilters applied AFTER user hooks)
- **INV-02:** `before*` hooks execute in registration order (FIFO)
- **INV-03:** `after*` hooks execute in reverse registration order (LIFO — middleware semantics)
- **INV-04:** Query execution is atomic — hooks don't create partial execution states
- **INV-05:** Hook context is frozen (Object.freeze) — mutations MUST return new objects
- **INV-06:** Type safety preserved — hook return types match expected types
- **INV-07:** Re-entrant queries (hook calling ORM) skip hooks to prevent infinite loops
- **INV-08:** Intent is validated by planner AFTER `beforeQuery` modifications (no injection bypass)

### 3.2 Preconditions (required before action)

- **PRE-01:** Hooks must be registered before query execution
- **PRE-02:** Adapter must be configured for execution-phase hooks
- **PRE-03:** beforeMutation hooks ONLY fire for mutations (insert/update/delete/upsert)

### 3.3 Effects (what changes)

- **EFF-01:** beforeQuery can modify QueryIntent → changes SQL output
- **EFF-02:** afterQuery can transform results → changes return value
- **EFF-03:** beforeMutation can modify data/intent → changes SQL output
- **EFF-04:** afterMutation can transform RETURNING results
- **EFF-05:** onError receives error + context → can log/transform errors

### 3.4 Error Handling

- **ERR-01:** When hook throws → default behavior: propagate error (abort query)
- **ERR-02:** When hook throws + onHookError configured → call onHookError handler
- **ERR-03:** onHookError returns 'continue' → skip hook, continue chain
- **ERR-04:** onHookError returns 'abort' → propagate original error
- **ERR-05:** Async hook rejection treated same as sync throw

## 4. Technical Design

### 4.1 Architecture Decision

**Pattern:** Middleware chain with typed contexts (inspired by Prisma but adapted to semantic-first architecture)

**Why not Prisma's exact pattern:**
- Prisma middleware operates at Prisma Client level (ORM-centric)
- DBSP operates at Intent level (semantic-first) → hooks intercept Intent, not SQL
- Allows pre-planning and post-planning interception points

**Integration point:** Hook manager injected into `createOrm()` options, stored on OrmInstance.

### 4.2 API Design

**Usage Example:**
```typescript
import { createOrm, createHookManager } from '@dbsp/core';

// Create hook manager with desired hooks
const hooks = createHookManager()
  .beforeQuery(ctx => {
    console.log(`Query on ${ctx.table}`);
    return ctx; // or modified context
  })
  .afterQuery((ctx, results) => {
    console.log(`Got ${results.length} rows in ${ctx.duration}ms`);
    return results; // or transformed results
  })
  .onError(ctx => {
    console.error(`Error in ${ctx.operation}:`, ctx.error);
  });

// Inject hooks into ORM
const orm = createOrm({ schema, adapter, hooks });

// Hooks apply to all queries
const users = await orm.select('users').all(); // hooks fire
```

**Type Definitions:**
```typescript
// Hook types (v1.1 - updated per multi-LLM review consensus)

// Query execution types for afterQuery generics
type QueryResultType = 'all' | 'first' | 'count' | 'exists' | 'aggregate';

type QueryHookContext<T = unknown> = {
  readonly table: string;
  readonly operation: 'select';
  readonly intent: QueryIntent;
  readonly schemaName?: string;
  readonly inTransaction?: boolean;  // Transaction awareness (Gemini, Copilot)
  readonly correlationId?: string;   // Request tracing (Copilot)
  readonly resultType: QueryResultType;  // Distinguish all/first/count/exists (Codex)
  readonly isStreaming?: boolean;  // True for stream() calls (Codex, Gemini, Copilot consensus)
  // Available in afterQuery only:
  readonly sql?: string;
  readonly parameters?: readonly unknown[];
  readonly duration?: number;
};

type MutationHookContext<T = unknown> = {
  readonly table: string;
  readonly operation: 'insert' | 'update' | 'delete' | 'upsert';
  readonly intent: MutationIntent;
  readonly schemaName?: string;
  readonly inTransaction?: boolean;  // Transaction awareness
  readonly correlationId?: string;   // Request tracing
  readonly cardinality: 'single' | 'bulk';  // Batch awareness (Gemini)
  // Data varies by operation (Codex suggestion)
  readonly data?: T | T[] | Partial<T>;  // insert: T|T[], update: Partial<T>, delete: undefined
  // Available in afterMutation only:
  readonly sql?: string;
  readonly parameters?: readonly unknown[];
  readonly duration?: number;
  readonly affectedRows?: number;
};

type ErrorHookContext = {
  readonly table: string;
  readonly operation: string;
  readonly error: Error;
  readonly intent: QueryIntent | MutationIntent;
  readonly phase: 'beforeQuery' | 'afterQuery' | 'beforeMutation' | 'afterMutation';
  readonly sql?: string;
  readonly inTransaction?: boolean;
};

// Hook signatures - generics on result type (Codex consensus)
type BeforeQueryHook = (ctx: QueryHookContext) =>
  QueryHookContext | Promise<QueryHookContext> | void;

// Result type varies: T[] for all(), T|undefined for first(), number for count(), boolean for exists()
type AfterQueryHook = <R>(ctx: QueryHookContext, result: R) =>
  R | Promise<R> | void;

type BeforeMutationHook = <T>(ctx: MutationHookContext<T>) =>
  MutationHookContext<T> | Promise<MutationHookContext<T>> | void;

// Mutations with RETURNING always return arrays (Codex, Gemini consensus)
type AfterMutationHook = <T>(ctx: MutationHookContext<T>, result: T[]) =>
  T[] | Promise<T[]> | void;

type OnErrorHook = (ctx: ErrorHookContext) =>
  void | Error | Promise<void | Error>;

// Hook error handler with full context (Codex, Copilot suggestion)
type HookErrorHandler = (
  error: Error,
  hookName: string,
  ctx: QueryHookContext | MutationHookContext,
  phase: string
) => 'continue' | 'abort';

// Hook manager - immutable builder pattern (clarified per Codex/Copilot)
// Each method returns a NEW HookManager instance (immutable chain)
interface HookManager {
  beforeQuery(hook: BeforeQueryHook): HookManager;
  afterQuery(hook: AfterQueryHook): HookManager;
  beforeMutation(hook: BeforeMutationHook): HookManager;
  afterMutation(hook: AfterMutationHook): HookManager;
  onError(hook: OnErrorHook): HookManager;
  // Freeze the manager (optional, called implicitly by createOrm)
  freeze(): HookManager;
}

// ORM options extension
interface OrmOptions {
  // ... existing options
  hooks?: HookManager;
  onHookError?: HookErrorHandler;  // Enhanced with context
}
```

**Mutability Clarification (per Codex, Copilot feedback):**
- `HookManager` uses immutable builder pattern — each method returns a new instance
- Context objects are frozen (`Object.freeze`) — hooks cannot mutate them directly
- To modify context, return a new object: `return { ...ctx, intent: modifiedIntent }`
- `createOrm()` implicitly freezes the hook manager — no hooks can be added after ORM creation

### 4.3 Execution Flow

```
Query Execution:
  1. buildIntent()
  2. [beforeQuery hooks] ← can modify intent
  3. apply defaultFilters
  4. plan()
  5. compile()
  6. adapter.execute()
  7. hydrate results
  8. [afterQuery hooks] ← can transform results
  9. return to caller

Mutation Execution:
  1. buildIntent()
  2. [beforeMutation hooks] ← can modify intent/data
  3. compileIntent()
  4. adapter.execute()
  5. [afterMutation hooks] ← can transform RETURNING
  6. return to caller

Error Flow:
  any step throws → [onError hooks] → propagate or swallow based on config
```

### 4.4 Data Model Changes

| Entity | Change | Migration needed |
|--------|--------|------------------|
| OrmOptions | Add `hooks?: HookManager` | No |
| OrmOptions | Add `onHookError?: (...)` | No |
| OrmInstance | Store hook manager internally | No |
| QueryBuilderImpl | Invoke hooks in `all()`, `first()`, etc. | No |
| MutationBuilderBase | Invoke hooks in `execute()` | No |

### 4.5 File Structure

```
packages/core/src/dx/
├── hooks.ts           # NEW: HookManager, hook types, createHookManager()
├── hooks.test.ts      # NEW: Hook system tests
├── orm.ts             # MODIFIED: integrate hooks into createOrm()
├── types.ts           # MODIFIED: export hook types
└── mutation-builders.ts  # MODIFIED: invoke mutation hooks
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: Query Hooks

```gherkin
@priority:high @type:nominal
Scenario: SC-01 beforeQuery receives correct context
  Given an ORM with a beforeQuery hook registered
  When I execute a select query on "users" table
  Then the hook receives context with table="users", operation="select"
  And the context contains the QueryIntent

@priority:high @type:nominal
Scenario: SC-02 beforeQuery can modify intent
  Given an ORM with a beforeQuery hook that adds a WHERE clause
  When I execute a select query
  Then the final SQL includes the hook's WHERE clause

@priority:high @type:nominal
Scenario: SC-03 afterQuery receives results
  Given an ORM with an afterQuery hook
  When I execute a select query returning 3 rows
  Then the hook receives the 3 rows and context

@priority:high @type:nominal
Scenario: SC-04 afterQuery can transform results
  Given an ORM with an afterQuery hook that redacts "email" field
  When I execute a select query
  Then the returned results have email field redacted

@priority:medium @type:edge
Scenario: SC-05 multiple hooks execute in order
  Given an ORM with hooks A, B, C registered in order
  When I execute a query
  Then hooks execute as: beforeA → beforeB → beforeC → query → afterC → afterB → afterA

@priority:high @type:nominal
Scenario: SC-06 async hooks are awaited
  Given an ORM with an async beforeQuery hook
  When I execute a query
  Then the query waits for the hook to complete before proceeding
```

### Scenario Group: Mutation Hooks

```gherkin
@priority:high @type:nominal
Scenario: SC-07 beforeMutation receives data
  Given an ORM with a beforeMutation hook
  When I execute an insert with data {name: "John"}
  Then the hook receives context with operation="insert" and data={name: "John"}

@priority:high @type:nominal
Scenario: SC-08 beforeMutation can modify data
  Given an ORM with a beforeMutation hook that adds "createdAt"
  When I execute an insert
  Then the SQL includes the createdAt value

@priority:medium @type:nominal
Scenario: SC-09 afterMutation receives RETURNING
  Given an ORM with an afterMutation hook and RETURNING clause
  When I execute an insert with returning("id")
  Then the hook receives the returned id
```

### Scenario Group: Error Handling

```gherkin
@priority:high @type:error
Scenario: SC-10 hook error propagates by default
  Given an ORM with a beforeQuery hook that throws
  When I execute a query
  Then the query rejects with the hook's error

@priority:high @type:error
Scenario: SC-11 onHookError can continue
  Given an ORM with onHookError returning 'continue'
  And a beforeQuery hook that throws
  When I execute a query
  Then the query succeeds (hook skipped)

@priority:medium @type:error
Scenario: SC-12 onError hook receives error context
  Given an ORM with an onError hook
  When a query fails
  Then the onError hook receives the error and query context
```

### Scenario Group: Security

```gherkin
@priority:critical @type:security
Scenario: SC-13 defaultFilters applied AFTER beforeQuery
  Given a schema with defaultFilters for soft delete
  And a beforeQuery hook that adds tenant filter
  When I execute a query
  Then SQL has: WHERE tenant_id = $1 AND deleted_at IS NULL
  And defaultFilters cannot be bypassed by hooks

@priority:high @type:security
Scenario: SC-14 hooks cannot access raw adapter
  Given a malicious beforeQuery hook
  Then the hook context does NOT expose the adapter instance
  And the hook context does NOT expose connection credentials
  And the hook cannot execute arbitrary SQL
```

### Scenario Group: Integration

```gherkin
@priority:medium @type:integration
Scenario: SC-15 hooks work with schema scoping
  Given an ORM with withSchema("tenant_1")
  And a beforeQuery hook
  When I execute a query
  Then the hook context includes schemaName="tenant_1"
```

### Scenario Group: Edge Cases (from multi-LLM consensus)

```gherkin
@priority:medium @type:edge
Scenario: SC-16 hooks fire inside transactions
  Given an ORM with a beforeQuery hook
  When I execute a query inside a transaction
  Then the hook context has inTransaction=true
  And the hook fires normally

@priority:medium @type:edge
Scenario: SC-17 batch insert fires hook once
  Given an ORM with a beforeMutation hook
  When I execute a bulk insert with 100 rows
  Then the hook fires ONCE with cardinality="bulk"
  And data contains the array of 100 rows

@priority:high @type:edge
Scenario: SC-18 re-entrant queries skip hooks
  Given an ORM with a beforeQuery hook that calls orm.select()
  When I execute a query
  Then the nested query DOES NOT trigger hooks
  And no infinite loop occurs

@priority:medium @type:edge
Scenario: SC-19 afterQuery receives correct type for first()
  Given an ORM with an afterQuery hook
  When I execute first() returning one user
  Then the hook receives result as T|undefined (not T[])
  And resultType="first" in context

@priority:medium @type:edge
Scenario: SC-20 afterQuery receives correct type for count()
  Given an ORM with an afterQuery hook
  When I execute count()
  Then the hook receives result as number
  And resultType="count" in context

@priority:low @type:edge
Scenario: SC-21 void return from hook preserves original
  Given an ORM with an afterQuery hook that returns void
  When I execute a query returning [{id: 1}]
  Then the final result is [{id: 1}] (unchanged)

@priority:medium @type:edge
Scenario: SC-22 streaming query sets isStreaming flag
  Given an ORM with a beforeQuery hook that logs isStreaming
  When I execute a streaming query via stream()
  Then beforeQuery fires with ctx.isStreaming = true
  And afterQuery does NOT fire
  And onError fires if stream fails mid-execution
```

**Coverage matrix:**

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | ✓ | | | |
| SC-02 | ✓ | | | |
| SC-03 | ✓ | | | |
| SC-04 | ✓ | | | |
| SC-05 | | ✓ | | |
| SC-06 | ✓ | | | |
| SC-07 | ✓ | | | |
| SC-08 | ✓ | | | |
| SC-09 | ✓ | | | |
| SC-10 | | | ✓ | |
| SC-11 | | | ✓ | |
| SC-12 | | | ✓ | |
| SC-13 | | | | ✓ |
| SC-14 | | | | ✓ |
| SC-15 | | ✓ | | |
| SC-16 | | ✓ | | |
| SC-17 | | ✓ | | |
| SC-18 | | ✓ | | |
| SC-19 | | ✓ | | |
| SC-20 | | ✓ | | |
| SC-21 | | ✓ | | |
| SC-22 | | ✓ | | |

## 6. Implementation Plan

### Block 1: Hook Types & Manager — 45min
**Type:** Feature slice
**Dependencies:** None
**Files:**
- `packages/core/src/dx/hooks.ts` — Create hook types, contexts, HookManager class
- `packages/core/src/dx/hooks.test.ts` — Unit tests for HookManager
- `packages/core/src/dx/index.ts` — Export hook types

**Exit criteria:**
- [ ] HookManager can register hooks
- [ ] Hook types are properly typed
- [ ] createHookManager() factory exported
- [ ] 6 unit tests pass

### Block 2: Query Hook Integration — 60min
**Type:** Feature slice
**Dependencies:** Block 1
**Files:**
- `packages/core/src/dx/orm.ts` — Add hooks to createOrm options, invoke in QueryBuilderImpl
- `packages/core/src/dx/types.ts` — Extend OrmOptions with hooks

**Exit criteria:**
- [ ] beforeQuery invoked before plan()
- [ ] afterQuery invoked after hydration
- [ ] Context correctly populated
- [ ] SC-01 to SC-06 tests pass

### Block 3: Mutation Hook Integration — 45min
**Type:** Feature slice
**Dependencies:** Block 1
**Files:**
- `packages/core/src/dx/mutation-builders.ts` — Invoke hooks in MutationBuilderBase.execute()

**Exit criteria:**
- [ ] beforeMutation invoked before compile
- [ ] afterMutation invoked after execute
- [ ] Data available in context
- [ ] SC-07 to SC-09 tests pass

### Block 4: Error Handling — 45min
**Type:** Feature slice
**Dependencies:** Block 2, Block 3
**Files:**
- `packages/core/src/dx/hooks.ts` — Add error handling logic
- `packages/core/src/dx/orm.ts` — Wire onHookError option

**Exit criteria:**
- [ ] Hook errors propagate by default
- [ ] onHookError can continue/abort
- [ ] onError hook receives context
- [ ] SC-10 to SC-12 tests pass

### Block 5: Security & Integration Tests — 45min
**Type:** Validation
**Dependencies:** Block 4
**Files:**
- `packages/core/src/dx/hooks.test.ts` — Security + integration tests

**Exit criteria:**
- [ ] defaultFilters applied AFTER hooks (SC-13)
- [ ] Hooks cannot bypass security (SC-14)
- [ ] Schema scoping works (SC-15)
- [ ] SC-13 to SC-15 tests pass

### Block 6: Edge Cases (from multi-LLM review) — 45min
**Type:** Hardening
**Dependencies:** Block 5
**Files:**
- `packages/core/src/dx/hooks.ts` — Re-entrancy guard, batch handling
- `packages/core/src/dx/hooks.test.ts` — Edge case tests

**Exit criteria:**
- [ ] Transaction awareness (SC-16)
- [ ] Batch operations fire once (SC-17)
- [ ] Re-entrancy guard prevents loops (SC-18)
- [ ] Correct types for first()/count()/exists() (SC-19, SC-20)
- [ ] Void return handling (SC-21)
- [ ] All 21 scenarios pass
- [ ] No regression on existing tests

## 7. Test Strategy

### Test pyramid:

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 20+ | Hook registration, context creation, chain execution |
| Integration | 10+ | Full query/mutation flow with hooks |
| E2E | 0 | Not needed (covered by integration) |

### Test data requirements:
- **Fixtures:** Simple schema with users/posts tables
- **Mocks:** MockAdapter for compile-only tests
- **Spies:** vi.fn() for hook invocation order verification

### Test file locations:
- `packages/core/src/dx/hooks.test.ts` — Main hook tests
- `packages/core/src/dx/orm.ts` — Add integration tests in existing file

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Hook overhead impacts performance | M | L | Benchmark before/after; hooks are opt-in |
| Breaking change to OrmOptions | H | L | Hooks are optional, backward compatible |
| Async hook timing issues | M | M | Proper await handling, test async scenarios |
| Hook bypasses defaultFilters | H | L | Explicit order: hooks → defaultFilters (INV-01) |

## 9. Out of Scope (v2)

- Transaction hooks (beforeTransaction, afterTransaction)
- Hook priority/ordering beyond registration order
- Hook removal API (hooks are immutable after ORM creation)
- Hook timeout configuration
- Hook-level caching integration
- Hook metrics/observability built-in

## 9b. Clarifications

### withSchema() Inheritance
Hooks ARE inherited when calling `orm.withSchema('tenant')`. The scoped ORM shares the same hook manager as the parent. To use different hooks per schema, create separate ORM instances.

### Streaming Support (v1)
For streaming queries (`stream()`):
- `beforeQuery` fires with `ctx.isStreaming = true` (allows logging/auditing)
- `afterQuery` does NOT fire (no result interception — results are streamed)
- `onError` fires if the stream fails mid-execution
- Hooks can detect streaming via `ctx.isStreaming` and adapt behavior (e.g., skip caching logic)

## 9c. Multi-LLM Review Summary (2026-02-05)

**LLMs consulted:** Codex (GPT-5.2), Gemini (gemini-cli), Copilot (gemini-3-pro-preview)

| Finding | Codex | Gemini | Copilot | Resolution |
|---------|-------|--------|---------|------------|
| AfterMutation result: T → T[] | ✓ | ✓ | | Applied |
| AfterQuery type varies (first/count) | ✓ | | | Applied via resultType |
| Context immutability clarification | ✓ | | ✓ | Applied (Object.freeze) |
| onHookError needs context | ✓ | | ✓ | Applied |
| Transaction awareness | | ✓ | ✓ | Applied (inTransaction) |
| Batch ops fire once | | ✓ | | Applied (cardinality) |
| Re-entrancy prevention | ✓ | | | Added INV-07 |
| Stream hooks (isStreaming) | ✓ | ✓ | ✓ | Applied (v1) |
| correlationId | | | ✓ | Applied |

**Rejected:** Short-circuit for caching (Codex only) — over-engineering, better handled at application layer, bypasses security filters.

## 10. Definition of Done

- [ ] All 6 blocks implemented
- [ ] All 22 BDD scenarios have passing tests
- [ ] All tests pass (unit + integration)
- [ ] Lint/typecheck pass
- [ ] API documentation in hooks.ts
- [ ] /review clean (no blocking findings)
- [ ] README.md updated with hooks example
