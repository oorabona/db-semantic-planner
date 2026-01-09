---
doc-meta:
  status: draft
  scope: dx
  type: specification
  created: 2026-01-09
  updated: 2026-01-09
---

# Specification: DX-012 - API Ergonomics

## 1. User Stories

### US-1: Object Filter Syntax
AS A developer writing queries
I WANT to use object syntax for simple filters like `where({ status: 'active' })`
SO THAT I can write more concise and readable queries without importing helper functions

ACCEPTANCE: Filter object is converted to WhereIntent internally

### US-2: Typed Schema Generics
AS A TypeScript developer
I WANT autocomplete on table names, field names, and relation names
SO THAT I get compile-time safety and IDE assistance without code generation

ACCEPTANCE: Using `createOrm<DB>()` enables autocomplete on `query()` and `where()`

### US-3: Subquery Builder
AS A developer building complex queries
I WANT to use scalar subqueries in WHERE clauses without raw SQL
SO THAT I can express correlated conditions type-safely

ACCEPTANCE: Subquery builder produces valid WhereIntent for scalar comparisons

## 2. Business Rules

### BR-1: Object Filter Conversion
- Plain object values mean equality: `{ status: 'active' }` → `eq('status', 'active')`
- Operator objects use `$` prefix: `{ age: { $gt: 18 } }` → `gt('age', 18)`
- Multiple keys in object = implicit AND
- null values = isNull: `{ deletedAt: null }` → `isNull('deletedAt')`

### BR-2: Supported Object Operators
| Operator | Intent Generated | Example |
|----------|------------------|---------|
| (none/value) | eq | `{ status: 'active' }` |
| `$eq` | eq | `{ status: { $eq: 'active' } }` |
| `$neq` | neq | `{ status: { $neq: 'deleted' } }` |
| `$gt` | gt | `{ age: { $gt: 18 } }` |
| `$gte` | gte | `{ age: { $gte: 18 } }` |
| `$lt` | lt | `{ price: { $lt: 100 } }` |
| `$lte` | lte | `{ price: { $lte: 100 } }` |
| `$in` | inArray | `{ status: { $in: ['a', 'b'] } }` |
| `$like` | like | `{ name: { $like: '%john%' } }` |
| `$ilike` | like (caseInsensitive) | `{ name: { $ilike: '%john%' } }` |
| `null` | isNull | `{ deletedAt: null }` |
| `$notNull` | isNotNull | `{ email: { $notNull: true } }` |

### BR-3: Typed Generics Contract
- `DB` type = `Record<TableName, RowType>`
- `createOrm<DB>()` returns `OrmInstance<DB>`
- `query<K extends keyof DB>(table: K)` returns `QueryBuilder<DB[K]>`
- `where(filter: WhereFilter<T>)` accepts object typed by `T`
- Untyped usage (`createOrm()` without generic) still works → `unknown`

### BR-4: Subquery Builder Rules
- Must specify target table, select field, and produce scalar result
- Can reference parent query columns via `ref('columnName')` or `ref('alias.column')`
- Produces WhereIntent with `kind: 'subquery'` (new intent type)
- Only scalar subqueries supported (single column, single row expected)

## 3. Technical Impact

### 3.1 packages/core

| Change | Validation |
|--------|------------|
| Add `WhereSubqueryIntent` type | Type tests |
| Add `SubqueryRef` expression type | Type tests |

New types in `intent-ast.ts`:
```typescript
export interface WhereSubqueryIntent {
  readonly kind: 'subquery';
  readonly field: string;
  readonly operator: ComparisonOperator;
  readonly subquery: QueryIntent;
}

export interface SubqueryRefExpressionIntent {
  readonly kind: 'ref';
  readonly column: string;  // e.g., 'id' or 't0.id'
}
```

### 3.2 packages/adapter-kysely

| Change | Validation |
|--------|------------|
| Compile `WhereSubqueryIntent` | Integration tests |
| Handle `SubqueryRefExpressionIntent` | Unit tests |

### 3.3 packages/dx

| Change | Validation |
|--------|------------|
| New `objectToWhereIntent()` function | Unit tests |
| Update `QueryBuilder.where()` signature | Type tests |
| New `OrmInstance<DB>` generic interface | Type tests |
| New `subquery()` builder function | Unit tests |
| New `ref()` helper function | Unit tests |
| Export `WhereFilter<T>` type | Type tests |

## 4. Acceptance Criteria (BDD Scenarios)

### Feature 1: Object Filter Syntax

#### Scenario 1.1: Simple equality filter
```gherkin
Given an ORM instance with users table
When I call query('users').where({ active: true })
Then the plan.intent.where should be { kind: 'comparison', field: 'active', operator: 'eq', value: true }
```

#### Scenario 1.2: Multiple fields produce AND
```gherkin
Given an ORM instance with users table
When I call query('users').where({ active: true, role: 'admin' })
Then the plan.intent.where should be { kind: 'and', conditions: [eq, eq] }
```

#### Scenario 1.3: Operator object ($gt)
```gherkin
Given an ORM instance with users table
When I call query('users').where({ age: { $gt: 18 } })
Then the plan.intent.where should be { kind: 'comparison', field: 'age', operator: 'gt', value: 18 }
```

#### Scenario 1.4: Mixed values and operators
```gherkin
Given an ORM instance with users table
When I call query('users').where({ active: true, age: { $gte: 18 }, status: { $in: ['a', 'b'] } })
Then the plan.intent.where should be AND of 3 conditions
```

#### Scenario 1.5: Null handling
```gherkin
Given an ORM instance with users table
When I call query('users').where({ deletedAt: null })
Then the plan.intent.where should be { kind: 'null', field: 'deletedAt', operator: 'isNull' }
```

#### Scenario 1.6: $like operator
```gherkin
Given an ORM instance with users table
When I call query('users').where({ name: { $like: '%john%' } })
Then the plan.intent.where should be { kind: 'like', field: 'name', pattern: '%john%' }
```

#### Scenario 1.7: $ilike (case insensitive)
```gherkin
Given an ORM instance with users table
When I call query('users').where({ email: { $ilike: '%@EXAMPLE.COM' } })
Then the plan.intent.where should be { kind: 'like', field: 'email', pattern: '%@EXAMPLE.COM', caseInsensitive: true }
```

#### Scenario 1.8: $notNull operator
```gherkin
Given an ORM instance with users table
When I call query('users').where({ email: { $notNull: true } })
Then the plan.intent.where should be { kind: 'null', field: 'email', operator: 'isNotNull' }
```

#### Scenario 1.9: Backward compatibility with WhereIntent
```gherkin
Given an ORM instance with users table
When I call query('users').where(eq('status', 'active'))
Then the query should work exactly as before
And the plan should be identical to legacy usage
```

### Feature 2: Typed Schema Generics

#### Scenario 2.1: Typed query() autocomplete
```gherkin
Given a DB type interface with users and posts tables
When I create orm with createOrm<DB>({ model, db })
Then orm.query('users') should be type-safe
And orm.query('invalid') should produce TypeScript error
```

#### Scenario 2.2: Typed where() object
```gherkin
Given a typed QueryBuilder<User>
When I call .where({ name: 'John' })
Then the field 'name' should be autocompleted
And .where({ invalid: 'x' }) should produce TypeScript error
```

#### Scenario 2.3: Typed results
```gherkin
Given orm.query<User>('users')
When I call .findMany()
Then the return type should be Promise<User[]>
```

#### Scenario 2.4: Untyped fallback
```gherkin
Given createOrm() without DB generic
When I call query('anyTable').where({ anyField: 'value' })
Then it should compile without errors
And return unknown[]
```

#### Scenario 2.5: DB type reuse from Kysely
```gherkin
Given an existing Kysely Database type
When I use createOrm<Database>({ model, db })
Then it should accept the same type
And provide autocomplete based on Kysely's schema
```

### Feature 3: Subquery Builder

#### Scenario 3.1: Basic scalar subquery
```gherkin
Given an ORM with orders and orderLines tables
When I call:
  query('orders').where({
    total: { $eq: subquery('orderLines').select('price').where({ orderId: ref('id') }) }
  })
Then the plan should contain a subquery intent
And the SQL should have a correlated subquery
```

#### Scenario 3.2: ref() column reference
```gherkin
Given a subquery context
When I use ref('parentTable.id')
Then it should produce a SubqueryRefExpressionIntent
And compile to the correct column reference in SQL
```

#### Scenario 3.3: Subquery with aggregation
```gherkin
Given an ORM with products and reviews tables
When I call:
  query('products').where({
    avgRating: { $gt: subquery('reviews').where({ productId: ref('id') }).avg('rating') }
  })
Then the SQL should contain AVG() in the subquery
```

#### Scenario 3.4: Subquery builder dump()
```gherkin
Given a subquery builder
When I call .dump()
Then it should return the SubqueryIntent for debugging
```

## 5. Implementation Plan

### Block 1: Object Filter Syntax (packages/dx)

**Package:** packages/dx

**Tasks:**
1. Create `WhereFilter<T>` type with operator definitions
2. Create `objectToWhereIntent(filter: WhereFilter<unknown>)` converter function
3. Update `QueryBuilder.where()` to accept both `WhereIntent` and `WhereFilter<T>`
4. Add type overloads for typed `where()` when `TResult` is known
5. Unit tests for all operators and edge cases

**Files:**
- `packages/dx/src/object-filter.ts` (new)
- `packages/dx/src/query-builder.ts` (update)
- `packages/dx/src/types.ts` (update)
- `packages/dx/src/object-filter.test.ts` (new)

**Tests:** 12+ unit tests
**Complexity:** M

### Block 2: Typed Schema Generics (packages/dx)

**Package:** packages/dx

**Tasks:**
1. Add `DB` generic parameter to `OrmInstance<DB>`
2. Update `createOrm<DB>()` function signature
3. Update `query<K extends keyof DB & string>()` to infer table type
4. Update `QueryBuilder<T>` to use `T` for `where()` filtering
5. Add `WhereFilter<T>` type inference
6. Type-level tests with `expectTypeOf`

**Files:**
- `packages/dx/src/types.ts` (update)
- `packages/dx/src/orm.ts` (update)
- `packages/dx/src/typed-schema.test.ts` (new)

**Tests:** 8+ type-level tests
**Complexity:** M

### Block 3: Subquery Builder (packages/core + packages/adapter-kysely + packages/dx)

**Package:** packages/core, packages/adapter-kysely, packages/dx

**Tasks:**

**Core (intent types):**
1. Add `WhereSubqueryIntent` to `intent-ast.ts`
2. Add `SubqueryRefExpressionIntent` to `intent-ast.ts`
3. Update `WhereIntent` union type
4. Add type guards

**Adapter (compilation):**
1. Add `compileSubqueryWhere()` in compiler
2. Handle ref() column references
3. Integration tests

**DX (builder):**
1. Create `SubqueryBuilder` class with chainable API
2. Create `subquery(table: string)` factory function
3. Create `ref(column: string)` helper function
4. Unit tests for subquery builder

**Files:**
- `packages/core/src/intent-ast.ts` (update)
- `packages/adapter-kysely/src/compiler.ts` (update)
- `packages/dx/src/subquery-builder.ts` (new)
- `packages/dx/src/subquery-builder.test.ts` (new)

**Tests:** 10+ tests
**Complexity:** L

## 6. Test Strategy

### Test Matrix

| Scenario | Unit | Integration | Type |
|----------|------|-------------|------|
| Object filter simple equality | Yes | - | Yes |
| Object filter operators | Yes | - | Yes |
| Object filter null handling | Yes | - | - |
| Object filter AND combination | Yes | - | - |
| Backward compat (WhereIntent) | Yes | - | - |
| Typed createOrm<DB> | - | - | Yes |
| Typed query() autocomplete | - | - | Yes |
| Typed where() object | - | - | Yes |
| Untyped fallback | - | - | Yes |
| Subquery basic | Yes | Yes | - |
| Subquery with ref() | Yes | Yes | - |
| Subquery with aggregate | Yes | Yes | - |

### Test Files

| Block | Test File | Count |
|-------|-----------|-------|
| 1 | `object-filter.test.ts` | 12+ |
| 2 | `typed-schema.test.ts` | 8+ |
| 3 | `subquery-builder.test.ts` | 10+ |

---

## Definition of Done

- [ ] Block 1: Object filter syntax implemented and tested
- [ ] Block 2: Typed schema generics implemented and tested
- [ ] Block 3: Subquery builder implemented and tested
- [ ] All BDD scenarios have passing tests
- [ ] All tests pass (unit + integration + type)
- [ ] Lint/typecheck pass
- [ ] Documentation updated
- [ ] Backward compatibility verified
