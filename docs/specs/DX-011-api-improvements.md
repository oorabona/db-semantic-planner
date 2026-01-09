---
doc-meta:
  status: draft
  scope: dx
  type: specification
  created: 2026-01-09
  updated: 2026-01-09
---

# Specification: DX-011 API Improvements

## Overview

Three developer experience improvements identified from E2E test implementation feedback:

1. **Type Inference**: Query results typed based on `select()` fields
2. **WHERE AND Chaining**: `.where(a).where(b)` produces AND automatically
3. **Direct Include**: `include('relationName')` works when relation name is known

## 1. User Stories

### US-1: Type-Safe Query Results
**AS A** developer using db-semantic-planner
**I WANT** the result of `execute()` to be typed based on my `select()` fields
**SO THAT** I get compile-time safety and IDE autocomplete for query results

### US-2: Intuitive WHERE Chaining
**AS A** developer building complex queries
**I WANT** `.where(a).where(b)` to automatically AND conditions
**SO THAT** I can chain filters naturally without explicit `and()` wrapper

### US-3: Direct Relation Includes
**AS A** developer including related data
**I WANT** to write `.include('author')` when the relation is unambiguous
**SO THAT** I don't need verbose `{ via }` syntax for simple cases

## 2. Business Rules

### BR-1: WHERE Chaining (BREAKING CHANGE)

**Current behavior** (to be changed):
```typescript
query.where(a).where(b)  // b replaces a
```

**New behavior**:
```typescript
query.where(a).where(b)  // AND(a, b)
```

**Invariants:**
- Single `where()` call: condition used directly (no wrapper)
- Multiple `where()` calls: all conditions ANDed together
- `where(or(...))` followed by `where(x)`: `AND(or(...), x)`
- `where(and(...))` followed by `where(x)`: `AND(and(...), x)` (nested)

### BR-2: Include Resolution Order

When `include(target, options?)` is called:

1. If `options.via` provided → use that relation directly
2. If `target` matches a relation name exactly → use that relation
3. If `target` matches a target table name → find relations to that table
4. Apply strictMode / hints as before

### BR-3: Type Inference

**Scope:** Compile-time only, no runtime overhead

| Method Chain | Result Type |
|-------------|-------------|
| `.execute()` | `Promise<unknown[]>` (backward compat) |
| `.select(['id', 'name']).execute()` | `Promise<Pick<TTable, 'id' \| 'name'>[]>` |
| `.select(['id']).findFirst()` | `Promise<Pick<TTable, 'id'> \| undefined>` |
| `.findFirstOrThrow()` | `Promise<unknown>` (no select = unknown) |

## 3. Technical Impact

### Package: `packages/dx` only

| File | Changes |
|------|---------|
| `types.ts` | Add generic parameters to QueryBuilder interface |
| `orm.ts` | Accumulate where conditions, update include resolution |
| `index.ts` | No changes |
| `filters.ts` | No changes |

### No changes to:
- `packages/core` (receives final WhereIntent, unchanged)
- `packages/adapter-kysely` (compiles WhereIntent, unchanged)

## 4. Acceptance Criteria (BDD Scenarios)

### Feature: WHERE AND Chaining

```gherkin
Scenario: Single where condition
  Given a QueryBuilder for table 'users'
  When I call where(eq('active', true))
  Then buildIntent().where equals { kind: 'comparison', field: 'active', op: '=', value: true }

Scenario: Multiple where conditions produce AND
  Given a QueryBuilder for table 'users'
  When I call where(eq('active', true))
  And I call where(eq('role', 'admin'))
  Then buildIntent().where equals { kind: 'and', conditions: [cond1, cond2] }

Scenario: Chaining with OR condition
  Given a QueryBuilder for table 'users'
  When I call where(or(eq('role', 'admin'), eq('role', 'super')))
  And I call where(eq('active', true))
  Then buildIntent().where equals { kind: 'and', conditions: [orCond, activeCond] }

Scenario: Three where conditions
  Given a QueryBuilder for table 'users'
  When I call where(a).where(b).where(c)
  Then buildIntent().where equals { kind: 'and', conditions: [a, b, c] }
```

### Feature: Direct Include by Relation Name

```gherkin
Scenario: Include by exact relation name
  Given a model with table 'posts' having relation 'author' → 'users'
  When I call include('author')
  Then the plan uses relation 'author'

Scenario: Include by target table (existing behavior)
  Given a model with table 'users' having relation 'authoredPosts' → 'posts'
  When I call include('posts', { via: 'authoredPosts' })
  Then the plan uses relation 'authoredPosts'

Scenario: Relation name takes precedence over table name
  Given a model where 'posts' is both a relation name and a table name
  When I call include('posts')
  Then the relation 'posts' is used (not table lookup)

Scenario: Ambiguous target still requires disambiguation
  Given a model with table 'users' having relations ['authoredPosts', 'reviewedPosts'] → 'posts'
  When I call include('posts') without via
  And strictMode is true
  Then AmbiguousRelationError is thrown

Scenario: Explicit relation name avoids ambiguity
  Given a model with table 'users' having relations ['authoredPosts', 'reviewedPosts'] → 'posts'
  When I call include('authoredPosts')
  Then the plan uses relation 'authoredPosts' (no ambiguity check needed)
```

### Feature: Type Inference on Select/Execute

```gherkin
Scenario: Select with fields infers result type
  Given a QueryBuilder<{ id: number, name: string, email: string }>
  When I call select(['id', 'name']).execute()
  Then the return type is Promise<{ id: number, name: string }[]>

Scenario: No select returns unknown
  Given a QueryBuilder for table 'users'
  When I call execute() without select()
  Then the return type is Promise<unknown[]>

Scenario: FindFirst infers single result type
  Given a QueryBuilder with select(['id'])
  When I call findFirst()
  Then the return type is Promise<{ id: unknown } | undefined>

Scenario: Stream infers element type
  Given a QueryBuilder with select(['id', 'name'])
  When I call stream()
  Then the iterator type is AsyncIterableIterator<{ id: unknown, name: unknown }>
```

## 5. Implementation Plan

### Block 1: WHERE AND Chaining (BREAKING)

**Effort:** S (< 30 min)

**Changes:**
- `QueryBuilderImpl.whereIntent` → `whereIntents: WhereIntent[]` (accumulate)
- `where()` method: push to array instead of replace
- `buildIntent()`: if length > 1, wrap in `{ kind: 'and', conditions: whereIntents }`

**Tests:**
- 4 unit tests for BDD scenarios above
- Update any existing tests that relied on replacement behavior

**Files:**
- `packages/dx/src/orm.ts`
- `packages/dx/src/orm.test.ts` (new tests)

### Block 2: Include Direct Relation Name

**Effort:** S (< 30 min)

**Changes:**
- Update `include()` resolution logic:
  1. Check if `target` matches a relation name in model
  2. If yes, use that relation directly
  3. If no, proceed with existing table-based lookup

**Tests:**
- 5 unit tests for BDD scenarios above

**Files:**
- `packages/dx/src/orm.ts` (include method and helper)
- `packages/dx/src/orm.test.ts` (new tests)

### Block 3: Type Inference

**Effort:** M (30 min - 2h)

**Changes:**
- Add generic parameter `TSelect` to QueryBuilder interface
- `select<K extends keyof TTable>(fields: K[])` returns `QueryBuilder<Pick<TTable, K>>`
- `execute()` returns `Promise<TSelect[]>`
- `findFirst()` returns `Promise<TSelect | undefined>`
- `stream()` returns `AsyncIterableIterator<TSelect>`

**Complexity:**
- TypeScript conditional types for inference
- Backward compatibility: default generic = `unknown`
- No runtime changes (compile-time only)

**Tests:**
- Type tests using `expectTypeOf` or `@ts-expect-error` comments
- 4 type assertion tests

**Files:**
- `packages/dx/src/types.ts` (generic interface)
- `packages/dx/src/orm.ts` (QueryBuilderImpl generic)
- `packages/dx/src/type-inference.test.ts` (new file)

## 6. Test Strategy

| Scenario | Unit | Integration | E2E |
|----------|------|-------------|-----|
| WHERE AND chaining | Yes (4 tests) | - | - |
| Include by relation name | Yes (5 tests) | - | - |
| Type inference | Yes (type tests) | - | - |

**Total new tests:** ~13-15

## 7. Migration Guide

### Breaking Change: WHERE Chaining

**Before (v1.x):**
```typescript
// Second where() replaced first
query.where(eq('a', 1)).where(eq('b', 2))
// Result: WHERE b = 2
```

**After (v2.x):**
```typescript
// where() conditions are ANDed
query.where(eq('a', 1)).where(eq('b', 2))
// Result: WHERE a = 1 AND b = 2

// To get old behavior (replacement), build new query:
const q1 = query.where(eq('a', 1));
const q2 = orm.query('users').where(eq('b', 2));  // Fresh query
```

---

## Definition of Done

- [ ] All blocks implemented
- [ ] All BDD scenarios have passing tests
- [ ] All existing tests pass (or updated for breaking change)
- [ ] Lint/typecheck pass
- [ ] Documentation updated (migration guide)
- [ ] TODO_DX.md updated
