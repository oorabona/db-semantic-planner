---
doc-meta:
  status: canonical
  scope: dx
  type: specification
  created: 2026-01-09
  updated: 2026-01-09
---

# Specification: DX-010 Mutations (insert/update/delete)

## 1. User Stories

### US1: Insert Records
**AS A** developer using db-semantic-planner
**I WANT** to insert records using `orm.insert('table').values({...})`
**SO THAT** I can create data with the same intent-first, observable approach as queries

**ACCEPTANCE:** `orm.insert('users').values({ name: 'Alice' }).execute()` inserts a row

### US2: Update Records
**AS A** developer using db-semantic-planner
**I WANT** to update records using `orm.update('table').where(...).set({...})`
**SO THAT** I can modify existing data with explicit filtering and observability

**ACCEPTANCE:** `orm.update('users').where(eq('id', 1)).set({ name: 'Bob' }).execute()` updates the row

### US3: Delete Records
**AS A** developer using db-semantic-planner
**I WANT** to delete records using `orm.delete('table').where(...)`
**SO THAT** I can remove data with safety guards and cascade options

**ACCEPTANCE:** `orm.delete('users').where(eq('id', 1)).execute()` deletes the row

---

## 2. Business Rules

### Insert Operations
- **BR1:** `values()` accepts a single object OR an array of objects for bulk insert
- **BR2:** Empty values array MUST throw `InvalidOperationError`
- **BR3:** `insert()` returns an immutable `InsertBuilder`
- **BR4:** `execute()` returns `Promise<void>` (MVP - no RETURNING)
- **BR5:** `dump()` returns `{ sql, parameters, intent }` without executing

### Update Operations
- **BR6:** `set()` accepts an object with fields to update
- **BR7:** Empty set object MUST throw `InvalidOperationError`
- **BR8:** `where()` is REQUIRED - calling `execute()` without it throws `UnsafeOperationError`
- **BR9:** `update()` returns an immutable `UpdateBuilder`
- **BR10:** Multiple `set()` calls merge fields (last value wins)

### Delete Operations
- **BR11:** `where()` is REQUIRED - calling `execute()` without it throws `UnsafeOperationError`
- **BR12:** `delete()` returns an immutable `DeleteBuilder`
- **BR13:** `cascade()` enables explicit cascade delete via relations
- **BR14:** `cascade()` without arguments deletes ALL related records
- **BR15:** `cascade(['posts'])` deletes only specified relations

### Safety Guards
- **BR16:** Update without WHERE throws: "WHERE clause required. Use updateAll() for full-table updates."
- **BR17:** Delete without WHERE throws: "WHERE clause required. Use deleteAll() for full-table deletes."
- **BR18:** `updateAll()` and `deleteAll()` bypass WHERE requirement (explicit intent)

### Multi-tenant
- **BR19:** `orm.withSchema('schema').insert('table')` targets `schema.table`
- **BR20:** Multi-tenant mutations require `db` in OrmOptions

### Observability
- **BR21:** All mutation builders expose `dump()` returning `{ sql, parameters, intent }`
- **BR22:** Intent includes operation type, table, values/set fields, where conditions

### Error Handling
- **BR23:** Invalid table name throws existing `NotFoundError`
- **BR24:** Invalid relation in cascade throws existing `RelationNotFoundError`
- **BR25:** Missing `db` throws existing `ExecutionError`

---

## 3. Technical Impact

| Layer | Changes | Validation |
|-------|---------|------------|
| packages/core/src/intent-ast.ts | NEW: InsertIntent, UpdateIntent, DeleteIntent types | Type guards |
| packages/adapter-kysely/src/compiler.ts | NEW: compileInsert, compileUpdate, compileDelete | Unit tests |
| packages/dx/src/mutation-builders.ts | NEW: InsertBuilder, UpdateBuilder, DeleteBuilder | Unit tests |
| packages/dx/src/types.ts | Add insert/update/delete methods to OrmInstance | Type compatibility |
| packages/dx/src/orm.ts | Implement insert/update/delete factory methods | Integration tests |
| packages/dx/src/errors.ts | NEW: InvalidOperationError, UnsafeOperationError | Error tests |
| packages/dx/src/index.ts | Export mutation builders and errors | Import verification |

---

## 4. Acceptance Criteria (BDD Scenarios)

### Feature 1: Insert Operations

#### Scenario 1.1: Single record insert
```gherkin
Given an ORM instance with db configured
When orm.insert('users').values({ name: 'Alice', email: 'alice@test.com' }).execute() is called
Then a single row is inserted into the users table
And the SQL is: INSERT INTO "users" ("name", "email") VALUES ($1, $2)
```

#### Scenario 1.2: Bulk insert
```gherkin
Given an ORM instance with db configured
When orm.insert('users').values([{ name: 'A' }, { name: 'B' }, { name: 'C' }]).execute() is called
Then three rows are inserted in a single statement
And the SQL is: INSERT INTO "users" ("name") VALUES ($1), ($2), ($3)
```

#### Scenario 1.3: Insert dump (observability)
```gherkin
Given an ORM instance
When orm.insert('users').values({ name: 'Test' }).dump() is called
Then it returns { sql, parameters, intent }
And intent.type is 'insert'
And intent.table is 'users'
And intent.values contains { name: 'Test' }
And no database query is executed
```

#### Scenario 1.4: Insert with empty values
```gherkin
Given an ORM instance
When orm.insert('users').values([]).execute() is called
Then InvalidOperationError is thrown with message "No values provided for insert"
```

### Feature 2: Update Operations

#### Scenario 2.1: Update with where clause
```gherkin
Given an ORM instance with db configured
When orm.update('users').where(eq('id', 1)).set({ name: 'Bob', active: true }).execute() is called
Then the matching row is updated
And the SQL is: UPDATE "users" SET "name" = $1, "active" = $2 WHERE "id" = $3
```

#### Scenario 2.2: Update without where (safety)
```gherkin
Given an ORM instance with db configured
When orm.update('users').set({ active: false }).execute() is called
Then UnsafeOperationError is thrown
And message includes "WHERE clause required. Use updateAll() for full-table updates."
```

#### Scenario 2.3: updateAll() explicit full-table
```gherkin
Given an ORM instance with db configured
When orm.updateAll('users').set({ active: false }).execute() is called
Then all rows are updated
And the SQL is: UPDATE "users" SET "active" = $1
```

#### Scenario 2.4: Update dump (observability)
```gherkin
Given an ORM instance
When orm.update('users').where(eq('id', 1)).set({ name: 'Test' }).dump() is called
Then it returns { sql, parameters, intent }
And intent.type is 'update'
And intent.table is 'users'
And intent.set contains { name: 'Test' }
And intent.where contains the condition
```

#### Scenario 2.5: Update with empty set
```gherkin
Given an ORM instance
When orm.update('users').where(eq('id', 1)).set({}).execute() is called
Then InvalidOperationError is thrown with message "No fields to update"
```

### Feature 3: Delete Operations

#### Scenario 3.1: Delete with where clause
```gherkin
Given an ORM instance with db configured
When orm.delete('users').where(eq('id', 1)).execute() is called
Then the matching row is deleted
And the SQL is: DELETE FROM "users" WHERE "id" = $1
```

#### Scenario 3.2: Delete without where (safety)
```gherkin
Given an ORM instance with db configured
When orm.delete('users').execute() is called
Then UnsafeOperationError is thrown
And message includes "WHERE clause required. Use deleteAll() for full-table deletes."
```

#### Scenario 3.3: deleteAll() explicit full-table
```gherkin
Given an ORM instance with db configured
When orm.deleteAll('users').execute() is called
Then all rows are deleted
And the SQL is: DELETE FROM "users"
```

#### Scenario 3.4: Delete with cascade
```gherkin
Given an ORM instance with db configured
And a 'users' table with 'posts' relation (hasMany)
When orm.delete('users').where(eq('id', 1)).cascade().execute() is called
Then related posts are deleted first
Then the user is deleted
And multiple statements are executed in order
```

#### Scenario 3.5: Delete with selective cascade
```gherkin
Given an ORM instance with db configured
And a 'users' table with 'posts' and 'comments' relations
When orm.delete('users').where(eq('id', 1)).cascade(['posts']).execute() is called
Then only related posts are deleted
Then the user is deleted
And comments are NOT deleted
```

### Feature 4: Multi-tenant Mutations

#### Scenario 4.1: Insert in tenant schema
```gherkin
Given an ORM instance with db configured
When orm.withSchema('acme').insert('users').values({ name: 'Alice' }).execute() is called
Then the SQL is: INSERT INTO "acme"."users" ("name") VALUES ($1)
```

#### Scenario 4.2: Update in tenant schema
```gherkin
Given an ORM instance with db configured
When orm.withSchema('acme').update('users').where(eq('id', 1)).set({ name: 'Bob' }).execute() is called
Then the SQL is: UPDATE "acme"."users" SET "name" = $1 WHERE "id" = $2
```

#### Scenario 4.3: Delete in tenant schema
```gherkin
Given an ORM instance with db configured
When orm.withSchema('acme').delete('users').where(eq('id', 1)).execute() is called
Then the SQL is: DELETE FROM "acme"."users" WHERE "id" = $1
```

### Feature 5: Error Handling

#### Scenario 5.1: Invalid table name
```gherkin
Given an ORM instance
When orm.insert('nonexistent').values({ name: 'Test' }).dump() is called
Then NotFoundError is thrown with message containing "Table 'nonexistent' not found"
```

#### Scenario 5.2: Invalid relation in cascade
```gherkin
Given an ORM instance
When orm.delete('users').where(eq('id', 1)).cascade(['nonexistent']).dump() is called
Then RelationNotFoundError is thrown with suggestions
```

#### Scenario 5.3: Execute without db
```gherkin
Given an ORM instance WITHOUT db configured
When orm.insert('users').values({ name: 'Test' }).execute() is called
Then ExecutionError is thrown with message "Database not configured"
```

---

## 5. Implementation Plan

### Block 1: Core Intent Types
**Packages:** packages/core

- **Intent AST:** Add InsertIntent, UpdateIntent, DeleteIntent interfaces
- **Type guards:** isInsertIntent(), isUpdateIntent(), isDeleteIntent()
- **Tests:** Unit tests for intent construction

**Complexity:** S
**Dependencies:** None
**Acceptance criteria covered:** Type foundation for #3, #6, #11

### Block 2: Adapter Mutation Compiler
**Packages:** packages/adapter-kysely

- **Compiler:** compileInsert(), compileUpdate(), compileDelete()
- **Multi-tenant:** Schema prefix for mutations
- **Tests:** SQL snapshot tests for each operation

**Complexity:** M
**Dependencies:** Block 1
**Acceptance criteria covered:** #1, #2, #4, #7, #10, #11

### Block 3: DX Insert Builder
**Packages:** packages/dx

- **InsertBuilder:** values(), dump(), execute()
- **OrmInstance.insert():** Factory method
- **Errors:** InvalidOperationError for empty values
- **Tests:** Unit tests + integration tests

**Complexity:** M
**Dependencies:** Block 1, Block 2
**Acceptance criteria covered:** #1, #2, #3, #4, #11

### Block 4: DX Update Builder
**Packages:** packages/dx

- **UpdateBuilder:** where(), set(), dump(), execute()
- **OrmInstance.update():** Factory method
- **OrmInstance.updateAll():** No-WHERE variant
- **Errors:** UnsafeOperationError, InvalidOperationError
- **Tests:** Unit tests + integration tests

**Complexity:** M
**Dependencies:** Block 1, Block 2
**Acceptance criteria covered:** #4, #5, #6, #10, #11

### Block 5: DX Delete Builder
**Packages:** packages/dx

- **DeleteBuilder:** where(), cascade(), dump(), execute()
- **OrmInstance.delete():** Factory method
- **OrmInstance.deleteAll():** No-WHERE variant
- **Cascade logic:** Topological sort on relations
- **Tests:** Unit tests + integration tests

**Complexity:** L
**Dependencies:** Block 1, Block 2
**Acceptance criteria covered:** #7, #8, #9, #10, #11

### Block 6: Multi-tenant Mutations
**Packages:** packages/dx

- **withSchema() integration:** Pass schema to mutation builders
- **Tests:** Multi-tenant insert/update/delete tests

**Complexity:** S
**Dependencies:** Blocks 3, 4, 5
**Acceptance criteria covered:** #10

---

## 6. Test Strategy

### Test Matrix

| Scenario | Unit | Integration | E2E |
|----------|------|-------------|-----|
| 1.1 Single insert | Yes | Yes | - |
| 1.2 Bulk insert | Yes | Yes | - |
| 1.3 Insert dump | Yes | - | - |
| 1.4 Empty values | Yes | - | - |
| 2.1 Update with where | Yes | Yes | - |
| 2.2 Update without where | Yes | - | - |
| 2.3 updateAll | Yes | Yes | - |
| 2.4 Update dump | Yes | - | - |
| 2.5 Empty set | Yes | - | - |
| 3.1 Delete with where | Yes | Yes | - |
| 3.2 Delete without where | Yes | - | - |
| 3.3 deleteAll | Yes | Yes | - |
| 3.4 Delete cascade | Yes | Yes | - |
| 3.5 Selective cascade | Yes | Yes | - |
| 4.1-4.3 Multi-tenant | Yes | - | - |
| 5.1-5.3 Errors | Yes | - | - |

### Test Data Strategy

- **Fixtures:** Use existing `defineSchema()` pattern from DX tests
- **Mocking:** Mock Kysely `db` for unit tests with `vi.fn()` spies
- **Integration:** Use actual Kysely with in-memory assertions

### Test Files

- `packages/core/src/intent-ast.test.ts` - Add mutation intent tests
- `packages/adapter-kysely/src/mutation-compiler.test.ts` - NEW
- `packages/dx/src/insert-builder.test.ts` - NEW
- `packages/dx/src/update-builder.test.ts` - NEW
- `packages/dx/src/delete-builder.test.ts` - NEW
- `packages/dx/src/mutations-integration.test.ts` - NEW (optional)

---

## Definition of Done

- [ ] All 6 blocks implemented
- [ ] All 17 BDD scenarios have passing tests
- [ ] All tests pass (pnpm test, pnpm typecheck)
- [ ] Lint passes (pnpm biome check)
- [ ] Documentation updated (TODO_DX.md, DOCUMENTATION_INDEX.md)
- [ ] Exports verified in index.ts files
