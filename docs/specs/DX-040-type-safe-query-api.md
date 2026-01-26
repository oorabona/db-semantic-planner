---
doc-meta:
  status: draft
  scope: core, nql
  type: specification
  created: 2026-01-26
  updated: 2026-01-26
  complexity: ENTERPRISE
  time-budget: 40h
---

# DX-040: Type-Safe Query API

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | core, nql |
| Complexity | ENTERPRISE |
| Time budget | ~40h |
| Blocks | 8 |
| BDD scenarios | 18 |
| Risk level | MEDIUM |
| Breaking changes | No (additive) |

## 1. Problem Statement

The current ORM API uses **string literals** for table and column names:

```typescript
orm.select('users').where(eq('name', 'John')).all();
```

This provides:
- No IDE autocomplete for table/column names
- No compile-time validation (typos cause runtime errors)
- No refactoring support (renaming requires search/replace)
- Poor AI assistance (no type context for suggestions)

Meanwhile, **NQL already exists** and handles complex queries well, but:
- NQL strings have no TypeScript type inference
- Return types must be explicitly annotated

**Goal:** Provide a **native TypeScript API** with full type inference that coexists with NQL, both producing the same IntentIR and SQL.

## 2. User Stories

### US-01: Developer Autocomplete
```
AS A developer using the ORM
I WANT IDE autocomplete for table and column names
SO THAT I can discover available fields without consulting documentation
ACCEPTANCE: Typing `users.` shows all columns; typing `orm.from(` shows all tables
```

### US-02: Type-Safe Results
```
AS A developer writing queries
I WANT the result type to be automatically inferred from my select clause
SO THAT I don't need to manually annotate types or risk type mismatches
ACCEPTANCE: `orm.from(users).pick(users.id, users.name).all()` returns `{ id: number; name: string }[]`
```

### US-03: Consistent Semantics
```
AS A developer using both NQL and native API
I WANT identical semantics between the two APIs
SO THAT I can choose the syntax I prefer without behavior differences
ACCEPTANCE: Same query in NQL and native API produces identical SQL
```

## 3. Business Rules

### 3.1 Invariants

- **INV-01:** Native API and NQL MUST produce identical IntentIR for equivalent queries
- **INV-02:** Native API MUST support ALL features that NQL supports (no capability gap)
- **INV-03:** Type inference MUST be compile-time only (no runtime type generation)
- **INV-04:** Table/column objects MUST be zero runtime overhead (just metadata carriers)
- **INV-05:** Dynamic schemas (introspection) MUST be supported (with `unknown` types)

### 3.2 Preconditions

- **PRE-01:** Schema MUST be defined using `schema()` builder
- **PRE-02:** Table objects MUST be extracted via `s.tables` destructuring
- **PRE-03:** For NQL type inference, user MUST provide explicit type annotation

### 3.3 Effects

- **EFF-01:** `s.tables.users` returns a `TableRef<'users', UserColumns>` object
- **EFF-02:** `users.id` returns a `ColumnRef<'users', 'id', number>` object
- **EFF-03:** `users.posts` returns a `RelationRef<'posts', Post[], 'hasMany'>` for FK relations
- **EFF-04:** Query builder methods accept `TableRef`/`ColumnRef` instead of strings
- **EFF-05:** Result type is inferred from `.select()` / `.pick()` arguments

### 3.4 Error Handling

- **ERR-01:** Using non-existent column → TypeScript compile error
- **ERR-02:** Type mismatch in `eq(users.id, 'string')` → TypeScript compile error
- **ERR-03:** Dynamic schema with missing column → Runtime error (existing behavior)

## 4. Technical Design

### 4.1 Architecture Decision

**Dual API Strategy:**

```
┌─────────────────────────────────────────────────────────────┐
│                    QUERY API ARCHITECTURE                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────┐         ┌─────────────────┐           │
│  │   Native API    │         │      NQL        │           │
│  │  (TypeScript)   │         │   (String)      │           │
│  │                 │         │                 │           │
│  │ orm.from(users) │         │ orm.nql`users`  │           │
│  │   .pick(...)    │         │   | select ...` │           │
│  │   .where(...)   │         │                 │           │
│  └────────┬────────┘         └────────┬────────┘           │
│           │                           │                     │
│           │  Type inference: ✅        │  Type inference: ❌  │
│           │  Autocomplete: ✅          │  Autocomplete: ❌    │
│           │                           │                     │
│           └───────────┬───────────────┘                     │
│                       ▼                                     │
│              ┌─────────────────┐                            │
│              │    IntentIR     │  ← Same intermediate repr  │
│              └────────┬────────┘                            │
│                       ▼                                     │
│              ┌─────────────────┐                            │
│              │   SQL Compiler  │  ← Same planner/compiler   │
│              └────────┬────────┘                            │
│                       ▼                                     │
│              ┌─────────────────┐                            │
│              │   Executed SQL  │  ← Identical output        │
│              └─────────────────┘                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Rationale:**
- Native API provides full type inference at compile-time
- NQL provides concise syntax for complex queries
- Both use same IntentIR → guaranteed semantic equivalence
- No duplication of planner/compiler logic

### 4.2 Type System Design

#### 4.2.1 Table Reference Types

```typescript
/**
 * Reference to a table in the schema.
 * Carries table name and column types for inference.
 */
interface TableRef<
  TName extends string,
  TColumns extends Record<string, ColumnRef<TName, string, unknown>>,
  TRelations extends Record<string, RelationRef<string, unknown, RelationType>> = {}
> {
  readonly _table: TName;
  readonly _brand: 'TableRef';

  // All columns as ColumnRef objects
  readonly [K in keyof TColumns]: TColumns[K];

  // All relations as RelationRef objects
  readonly [K in keyof TRelations]: TRelations[K];

  // Wildcard for SELECT *
  readonly _: AllColumns<TName, TColumns>;
}
```

#### 4.2.2 Column Reference Types

```typescript
/**
 * Reference to a column in a table.
 * Carries table name, column name, and TypeScript type.
 */
interface ColumnRef<
  TTable extends string,
  TColumn extends string,
  TType
> {
  readonly _table: TTable;
  readonly _column: TColumn;
  readonly _type: TType;
  readonly _brand: 'ColumnRef';

  // Alias support
  as<TAlias extends string>(alias: TAlias): AliasedColumn<TTable, TColumn, TType, TAlias>;
}

/**
 * Column with an alias for result type inference.
 */
interface AliasedColumn<TTable, TColumn, TType, TAlias extends string>
  extends ColumnRef<TTable, TColumn, TType> {
  readonly _alias: TAlias;
}
```

#### 4.2.3 Relation Reference Types

```typescript
/**
 * Reference to a relation (FK-based join path).
 */
interface RelationRef<
  TTarget extends string,
  TTargetType,
  TRelationType extends 'belongsTo' | 'hasMany' | 'hasOne'
> {
  readonly _target: TTarget;
  readonly _type: TTargetType;
  readonly _relationType: TRelationType;
  readonly _brand: 'RelationRef';

  // Access columns through relation (for cross-table queries)
  readonly [K in keyof TTargetColumns]: ColumnRef<TTarget, K, TTargetColumns[K]>;

  // Wildcard for relation.* in select
  readonly _: AllColumns<TTarget, TTargetColumns>;
}
```

#### 4.2.4 Schema Table Extraction

```typescript
// Current schema() returns Schema<T>
const s = schema({
  users: { id: 'integer', name: 'string', email: 'string' },
  posts: { id: 'integer', title: 'string', authorId: ref('users') },
});

// NEW: s.tables provides typed table objects
const { users, posts } = s.tables;

// users is TableRef<'users', { id: ColumnRef<...>, name: ColumnRef<...>, ... }>
// users.id is ColumnRef<'users', 'id', number>
// users.posts is RelationRef<'posts', Post[], 'hasMany'> (from inverse relation)
```

### 4.3 Query Builder API

#### 4.3.1 Select Queries

```typescript
interface TypedQueryBuilder<TResult> {
  // Start from a table
  from<T extends TableRef<any, any>>(table: T): FromBuilder<T>;
}

interface FromBuilder<TTable extends TableRef<any, any>> {
  // Select all columns
  all(): Promise<InferTableRow<TTable>[]>;
  first(): Promise<InferTableRow<TTable> | null>;

  // Select specific columns (infers result type)
  pick<TCols extends ColumnRef<any, any, any>[]>(
    ...columns: TCols
  ): PickBuilder<TTable, TCols>;

  // Select with expressions
  select<TSelect extends SelectItem[]>(
    ...items: TSelect
  ): SelectBuilder<TTable, TSelect>;

  // Filtering
  where(condition: WhereCondition): FromBuilder<TTable>;

  // Relations
  include<TRel extends keyof TTable & RelationRef<any, any, any>>(
    relation: TRel
  ): FromBuilder<TTable & { [K in TRel]: InferRelation<TTable[TRel]> }>;

  // Aggregation
  groupBy<TCols extends ColumnRef<any, any, any>[]>(
    ...columns: TCols
  ): GroupBuilder<TTable, TCols>;

  // Ordering
  orderBy(column: ColumnRef<any, any, any>, direction?: 'asc' | 'desc'): FromBuilder<TTable>;

  // Pagination
  limit(n: number): FromBuilder<TTable>;
  offset(n: number): FromBuilder<TTable>;
}
```

#### 4.3.2 Filter Helpers (Type-Safe)

```typescript
// Current: eq('name', 'John') - no type checking
// New: eq(users.name, 'John') - type checked

function eq<TTable extends string, TCol extends string, TType>(
  column: ColumnRef<TTable, TCol, TType>,
  value: TType
): WhereCondition;

function gt<TTable extends string, TCol extends string, TType extends number | Date>(
  column: ColumnRef<TTable, TCol, TType>,
  value: TType
): WhereCondition;

function like<TTable extends string, TCol extends string>(
  column: ColumnRef<TTable, TCol, string>,
  pattern: string
): WhereCondition;

function isNull<TTable extends string, TCol extends string, TType>(
  column: ColumnRef<TTable, TCol, TType | null>
): WhereCondition;

// Cross-table filter (EXISTS subquery)
function exists<TRel extends RelationRef<any, any, 'hasMany'>>(
  relation: TRel,
  condition: (rel: TRel) => WhereCondition
): WhereCondition;
```

#### 4.3.3 SQL Functions (Type-Safe)

```typescript
// Aggregates
function count(): AggregateExpr<number>;
function count<T>(column: ColumnRef<any, any, T>): AggregateExpr<number>;
function sum<T extends number>(column: ColumnRef<any, any, T>): AggregateExpr<number>;
function avg<T extends number>(column: ColumnRef<any, any, T>): AggregateExpr<number | null>;
function min<T>(column: ColumnRef<any, any, T>): AggregateExpr<T | null>;
function max<T>(column: ColumnRef<any, any, T>): AggregateExpr<T | null>;

// Scalar functions
function coalesce<T>(...values: (ColumnRef<any, any, T | null> | T)[]): ScalarExpr<T>;
function lower(column: ColumnRef<any, any, string>): ScalarExpr<string>;
function upper(column: ColumnRef<any, any, string>): ScalarExpr<string>;
function concat(...values: (ColumnRef<any, any, string> | string)[]): ScalarExpr<string>;

// Window functions
function rank(): WindowExpr<number>;
function denseRank(): WindowExpr<number>;
function rowNumber(): WindowExpr<number>;
function lag<T>(column: ColumnRef<any, any, T>, offset?: number, defaultValue?: T): WindowExpr<T | null>;
function lead<T>(column: ColumnRef<any, any, T>, offset?: number, defaultValue?: T): WindowExpr<T | null>;

// Window specification
interface WindowExpr<T> {
  over(spec: WindowSpec): AliasableExpr<T>;
}

function partitionBy(...columns: ColumnRef<any, any, any>[]): PartitionSpec;
function orderBy(column: ColumnRef<any, any, any>, dir?: 'asc' | 'desc'): OrderSpec;
```

#### 4.3.4 Result Type Inference

```typescript
// Automatic inference from pick()
const result = await orm.from(users)
  .pick(users.id, users.name)
  .all();
// TypeScript infers: { id: number; name: string }[]

// Inference with aliases
const result = await orm.from(users)
  .select(
    users.name,
    count(users.posts).as('postCount'),
    max(users.posts.views).as('maxViews')
  )
  .groupBy(users.name)
  .all();
// TypeScript infers: { name: string; postCount: number; maxViews: number | null }[]

// Inference with relations
const result = await orm.from(users)
  .include(users.posts)
  .all();
// TypeScript infers: (User & { posts: Post[] })[]
```

### 4.4 NQL Integration

#### 4.4.1 Typed NQL Template Literal

```typescript
// Explicit type annotation (required for full type safety)
const result = await orm.nql<{
  name: string;
  postCount: number;
}>`users | select name, count(posts.*) as postCount | group by name`;

// Result is typed as { name: string; postCount: number }[]
```

#### 4.4.2 NQL Type Inference Limitations

TypeScript template literal types can infer **simple patterns** but not the full NQL grammar.

**What CAN be inferred:**

| Pattern | Example | Inferable |
|---------|---------|-----------|
| Table name | `users \| ...` | ✅ Yes |
| Simple columns | `select name, email` | ✅ Yes |
| Column aliases | `name as userName` | ✅ Yes |
| Simple where | `where id = 1` | ✅ Yes |
| Order by | `order by name asc` | ✅ Yes |
| Limit/offset | `limit 10 offset 5` | ✅ Yes |

**What CANNOT be inferred:**

| Pattern | Example | Reason |
|---------|---------|--------|
| Boolean precedence | `a = 1 and b = 2 or c = 3` | No operator precedence |
| Nested parentheses | `(a or b) and c` | Balanced paren matching |
| Multi-arg functions | `coalesce(a, b, c)` | Nested commas |
| CASE expressions | `case when ... end` | Multi-part structure |
| Window functions | `rank() over (...)` | Too many nesting levels |
| Subqueries | `where id in (...)` | Full recursive parsing |

**Conclusion:** For full type inference, use Native API. NQL requires explicit type annotation.

### 4.5 Cross-Table Queries

#### 4.5.1 Implicit Joins (Like NQL)

```typescript
// Native API - relation path creates implicit join
const result = await orm.from(users)
  .where(eq(users.posts.published, true))  // EXISTS subquery
  .all();

// Equivalent NQL
orm.nql`users | where posts.published = true`

// Both produce same SQL:
// SELECT * FROM users WHERE EXISTS (
//   SELECT 1 FROM posts WHERE posts.author_id = users.id AND posts.published = true
// )
```

#### 4.5.2 Cross-Table Select

```typescript
// Native API
const result = await orm.from(users)
  .select(
    users.name,
    users.posts.title,  // Cross-table column
  )
  .groupBy(users.name, users.posts.title)
  .having(gt(count(), 10))
  .all();

// Equivalent NQL
orm.nql`users | select name, posts.title | group by name, posts.title | having count(*) > 10`
```

#### 4.5.3 Quantifiers (ALL, SOME, NONE)

```typescript
// Default: SOME (at least one related row matches)
orm.from(users).where(eq(users.posts.published, true))

// NONE (no related rows match)
orm.from(users).where(none(users.posts, p => eq(p.published, true)))

// EVERY (all related rows match)
orm.from(users).where(every(users.posts, p => eq(p.published, true)))

// Equivalent NQL
orm.nql`users | where posts.published = true`           // SOME
orm.nql`users | where NOT posts.published = true`       // NONE
orm.nql`users | where ALL posts.published = true`       // EVERY
```

### 4.6 Dynamic Schema Support

```typescript
// Introspected schema - columns unknown at compile time
const dynamicDef = await getSchemaFromDb(adapter);
const dynamicSchema = schema(dynamicDef);
const { users } = dynamicSchema.tables;

// users.id exists but typed as ColumnRef<'users', string, unknown>
// No autocomplete, but runtime works

// Option 1: Accept unknown types
const result = await orm.from(users).all();  // unknown[]

// Option 2: Cast with known type
const typedSchema = schema(dynamicDef) as Schema<{
  users: { id: 'integer'; name: 'string' }
}>;
// Now has full autocomplete

// Option 3: Use NQL with explicit type
const result = await orm.nql<{ id: number; name: string }>`users`;
```

## 5. Acceptance Criteria (BDD)

### Scenario Group: Table/Column References

```gherkin
@priority:high @type:nominal
Scenario: SC-01 Extract typed table from schema
  Given a schema with users table having id, name, email columns
  When I destructure `const { users } = s.tables`
  Then users is a TableRef with columns as properties
  And users.id is ColumnRef<'users', 'id', number>
  And users.name is ColumnRef<'users', 'name', string>

@priority:high @type:nominal
Scenario: SC-02 Access relation through table
  Given a schema with users and posts tables
  And posts has authorId as ref('users')
  When I access users.posts
  Then it is RelationRef<'posts', Post[], 'hasMany'>
  And users.posts.title is ColumnRef<'posts', 'title', string>

@priority:high @type:error
Scenario: SC-03 Compile error on invalid column
  Given a schema with users table having id, name columns
  When I write `users.nonexistent`
  Then TypeScript shows compile error "Property 'nonexistent' does not exist"
```

### Scenario Group: Query Building

```gherkin
@priority:high @type:nominal
Scenario: SC-04 Select all columns with type inference
  Given a schema with users table
  When I execute `orm.from(users).all()`
  Then result type is `User[]`
  And result contains all columns from users table

@priority:high @type:nominal
Scenario: SC-05 Pick specific columns with type inference
  Given a schema with users table having id, name, email, createdAt columns
  When I execute `orm.from(users).pick(users.id, users.name).all()`
  Then result type is `{ id: number; name: string }[]`
  And result does NOT contain email or createdAt

@priority:high @type:nominal
Scenario: SC-06 Type-safe filter with eq()
  Given a schema with users.name as string
  When I write `eq(users.name, 123)`
  Then TypeScript shows compile error (number not assignable to string)
  When I write `eq(users.name, 'John')`
  Then it compiles successfully

@priority:high @type:nominal
Scenario: SC-07 Aggregate with alias and type inference
  Given a schema with users and posts tables
  When I execute:
    ```
    orm.from(users)
      .select(users.name, count(users.posts).as('postCount'))
      .groupBy(users.name)
      .all()
    ```
  Then result type is `{ name: string; postCount: number }[]`
```

### Scenario Group: Cross-Table Queries

```gherkin
@priority:high @type:nominal
Scenario: SC-08 Filter on related table (implicit EXISTS)
  Given users with hasMany posts relation
  When I execute `orm.from(users).where(eq(users.posts.published, true)).all()`
  Then SQL contains EXISTS subquery
  And result contains only users with at least one published post

@priority:high @type:nominal
Scenario: SC-09 Cross-table GROUP BY
  Given users with hasMany posts relation
  When I execute:
    ```
    orm.from(users)
      .select(users.name, users.posts.title, count().as('count'))
      .groupBy(users.name, users.posts.title)
      .having(gt(count(), 10))
      .all()
    ```
  Then SQL joins users and posts
  And groups by both users.name and posts.title
  And filters groups with count > 10

@priority:medium @type:nominal
Scenario: SC-10 Quantifier EVERY (all related match)
  Given users with posts, some published some not
  When I execute `orm.from(users).where(every(users.posts, p => eq(p.published, true))).all()`
  Then result contains only users where ALL posts are published
  And SQL uses NOT EXISTS with negated condition
```

### Scenario Group: SQL Functions

```gherkin
@priority:high @type:nominal
Scenario: SC-11 Coalesce with type inference
  Given users.nickname nullable, users.name required
  When I execute:
    ```
    orm.from(users)
      .select(coalesce(users.nickname, users.name).as('displayName'))
      .all()
    ```
  Then result type is `{ displayName: string }[]`
  And SQL contains COALESCE(nickname, name)

@priority:medium @type:nominal
Scenario: SC-12 Window function with partition
  Given posts table with authorId, views columns
  When I execute:
    ```
    orm.from(posts)
      .select(
        posts.title,
        rank().over(partitionBy(posts.authorId).orderBy(posts.views, 'desc')).as('viewRank')
      )
      .all()
    ```
  Then result type is `{ title: string; viewRank: number }[]`
  And SQL contains RANK() OVER (PARTITION BY author_id ORDER BY views DESC)

@priority:medium @type:nominal
Scenario: SC-13 CASE expression
  Given users with postsCount column
  When I execute:
    ```
    orm.from(users)
      .select(
        users.name,
        caseWhen(gt(users.postsCount, 100), 'power')
          .when(gt(users.postsCount, 10), 'active')
          .else('casual')
          .as('userType')
      )
      .all()
    ```
  Then result type is `{ name: string; userType: string }[]`
```

### Scenario Group: NQL Integration

```gherkin
@priority:high @type:nominal
Scenario: SC-14 NQL with explicit type
  Given a schema with users table
  When I execute `orm.nql<{ id: number; name: string }>\`users | select id, name\``
  Then result type is `{ id: number; name: string }[]`

@priority:high @type:nominal
Scenario: SC-15 Native API and NQL produce same SQL
  Given a schema with users and posts
  When I execute native: `orm.from(users).where(eq(users.name, 'John')).pick(users.id).all()`
  And I execute NQL: `orm.nql\`users | where name = 'John' | select id\``
  Then both produce identical SQL
  And both return same data
```

### Scenario Group: Dynamic Schema

```gherkin
@priority:medium @type:edge
Scenario: SC-16 Dynamic schema with unknown types
  Given schema from getSchemaFromDb()
  When I access dynamicSchema.tables.users.id
  Then it is ColumnRef<'users', string, unknown>
  And queries work at runtime

@priority:medium @type:edge
Scenario: SC-17 Dynamic schema with type cast
  Given schema from getSchemaFromDb()
  When I cast: `schema(def) as Schema<{ users: { id: 'integer' } }>`
  Then users.id is ColumnRef<'users', 'id', number>
  And autocomplete works

@priority:medium @type:error
Scenario: SC-18 Runtime error on invalid column in dynamic schema
  Given dynamic schema without 'foo' column
  When I query for 'foo' column at runtime
  Then throw error "Column 'foo' not found in table 'users'"
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security |
|----------|---------|------|-------|----------|
| SC-01 | ✓ | | | |
| SC-02 | ✓ | | | |
| SC-03 | | | ✓ | |
| SC-04 | ✓ | | | |
| SC-05 | ✓ | | | |
| SC-06 | ✓ | | ✓ | |
| SC-07 | ✓ | | | |
| SC-08 | ✓ | | | |
| SC-09 | ✓ | | | |
| SC-10 | ✓ | | | |
| SC-11 | ✓ | | | |
| SC-12 | ✓ | | | |
| SC-13 | ✓ | | | |
| SC-14 | ✓ | | | |
| SC-15 | ✓ | | | |
| SC-16 | | ✓ | | |
| SC-17 | | ✓ | | |
| SC-18 | | | ✓ | |

## 6. Implementation Plan

### Block 1: Table/Column Reference Types — 6h

**Type:** Infrastructure
**Dependencies:** None
**Packages:** core

**Files:**
- `packages/core/src/dx/table-ref.ts` — TableRef, ColumnRef, RelationRef types
- `packages/core/src/dx/table-ref.test.ts` — Type-level tests

**Exit criteria:**
- [ ] TableRef<TName, TColumns> type defined
- [ ] ColumnRef<TTable, TColumn, TType> type defined
- [ ] RelationRef<TTarget, TType, TRelation> type defined
- [ ] Type tests pass with expectTypeOf

### Block 2: Schema Tables Extraction — 4h

**Type:** Feature
**Dependencies:** Block 1
**Packages:** core

**Files:**
- `packages/core/src/dx/schema.ts` — Add `.tables` property to Schema
- `packages/core/src/dx/schema.test.ts` — Tests for tables extraction

**Exit criteria:**
- [ ] `s.tables` returns typed table objects
- [ ] `users.id` returns ColumnRef
- [ ] `users.posts` returns RelationRef (inverse relation)
- [ ] Relations inferred from ref() declarations

### Block 3: Type-Safe Filter Helpers — 4h

**Type:** Feature
**Dependencies:** Block 1
**Packages:** core

**Files:**
- `packages/core/src/dx/filters.ts` — Update eq, gt, lt, etc. to accept ColumnRef
- `packages/core/src/dx/filters.test.ts` — Type-safe filter tests

**Exit criteria:**
- [ ] `eq(users.name, 'John')` compiles
- [ ] `eq(users.name, 123)` fails to compile
- [ ] `gt(users.age, 18)` works for number columns
- [ ] `like(users.name, '%John%')` works for string columns

### Block 4: Query Builder with Type Inference — 8h

**Type:** Feature
**Dependencies:** Block 2, Block 3
**Packages:** core

**Files:**
- `packages/core/src/dx/typed-query-builder.ts` — FromBuilder, PickBuilder, SelectBuilder
- `packages/core/src/dx/typed-query-builder.test.ts` — Query builder tests

**Exit criteria:**
- [ ] `orm.from(users).all()` returns `User[]`
- [ ] `orm.from(users).pick(users.id, users.name).all()` returns `Pick<User, 'id'|'name'>[]`
- [ ] `orm.from(users).where(eq(users.name, 'John')).all()` works
- [ ] Result type inferred from select items

### Block 5: SQL Functions (Aggregates, Scalars) — 6h

**Type:** Feature
**Dependencies:** Block 4
**Packages:** core

**Files:**
- `packages/core/src/dx/functions.ts` — count, sum, avg, coalesce, etc.
- `packages/core/src/dx/functions.test.ts` — Function tests

**Exit criteria:**
- [ ] `count()`, `count(users.id)` return AggregateExpr<number>
- [ ] `sum(users.amount)` requires number column
- [ ] `coalesce(users.nickname, users.name)` infers string
- [ ] `.as('alias')` works for result naming

### Block 6: Window Functions — 4h

**Type:** Feature
**Dependencies:** Block 5
**Packages:** core

**Files:**
- `packages/core/src/dx/window.ts` — rank, rowNumber, lag, lead, partitionBy
- `packages/core/src/dx/window.test.ts` — Window function tests

**Exit criteria:**
- [ ] `rank().over(partitionBy(users.dept).orderBy(users.salary, 'desc'))` works
- [ ] Result type inferred
- [ ] SQL generated correctly

### Block 7: Cross-Table Queries — 6h

**Type:** Feature
**Dependencies:** Block 4
**Packages:** core, adapter-kysely

**Files:**
- `packages/core/src/dx/relation-query.ts` — Cross-table filter/select support
- `packages/core/src/dx/relation-query.test.ts` — Tests
- `packages/adapter-kysely/src/compiler.ts` — Update to handle relation paths

**Exit criteria:**
- [ ] `users.posts.published` creates EXISTS subquery
- [ ] `every()`, `none()` quantifiers work
- [ ] Cross-table GROUP BY generates correct JOIN
- [ ] Same SQL as NQL equivalent

### Block 8: NQL Type Integration — 2h

**Type:** Feature
**Dependencies:** Block 4
**Packages:** core, nql

**Files:**
- `packages/core/src/dx/nql.ts` — orm.nql template literal
- `packages/core/src/dx/nql.test.ts` — Tests

**Exit criteria:**
- [ ] `orm.nql<T>\`query\`` returns T[]
- [ ] NQL and native API produce identical IntentIR
- [ ] Documentation for when to use which API

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 40+ | Type inference, individual functions |
| Integration | 15+ | Query builder → IntentIR → SQL |
| E2E | 5+ | Full execution against PostgreSQL |

### Type-Level Tests

Use `vitest` with `expectTypeOf` for compile-time type assertions:

```typescript
it('pick infers correct result type', () => {
  const query = orm.from(users).pick(users.id, users.name);
  expectTypeOf(query).toMatchTypeOf<QueryBuilder<{ id: number; name: string }>>();
});

it('rejects invalid column type in eq', () => {
  // @ts-expect-error - number not assignable to string
  eq(users.name, 123);
});
```

### Test Data Requirements

- Reuse existing test schemas (blog, pimdam)
- Add specific fixtures for:
  - Cross-table aggregations
  - Window function scenarios
  - Dynamic schema cases

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| TypeScript complexity (recursive types) | H | M | Use type tests extensively; simplify if compiler slows |
| API surface too large | M | M | Start with most common operations; add incrementally |
| Semantic drift between Native/NQL | H | L | Share IntentIR generation code; comprehensive tests |
| Dynamic schema DX poor | M | H | Document patterns; provide type cast helpers |
| Breaking existing string API | H | L | Keep string API working; new API is additive |

## 9. Definition of Done

- [ ] All 8 blocks implemented
- [ ] All 18 BDD scenarios have passing tests
- [ ] Type-level tests verify inference
- [ ] Integration tests verify IntentIR equivalence
- [ ] E2E tests verify SQL execution
- [ ] Documentation updated (API reference, examples)
- [ ] TODO.md updated
- [ ] /review clean (no blocking findings)

## 10. Appendix: TypeScript Template Literal Inference Limits

### What TypeScript CAN Infer

```typescript
// Pipe structure
type ParsePipes<S> = S extends `${infer Table} | ${infer Rest}` ? ... : ...;
// ✅ Works

// Simple columns
type ParseSelect<S> = S extends `select ${infer Cols}` ? Split<Cols, ','> : never;
// ✅ Works

// Aliases
type ParseAlias<S> = S extends `${infer Col} as ${infer Alias}` ? { col: Col; alias: Alias } : ...;
// ✅ Works
```

### What TypeScript CANNOT Infer

```typescript
// Boolean precedence: a AND b OR c
// ❌ Cannot determine: (a AND b) OR c vs a AND (b OR c)

// Nested parentheses: ((a OR b) AND c)
// ❌ Cannot match balanced parentheses

// Multi-arg functions: coalesce(a, b, c)
// ❌ Cannot distinguish argument commas from nested function commas

// CASE expressions: case when x then y when z then w else v end
// ❌ Multi-part structure with variable WHEN clauses

// Window functions: rank() over (partition by x order by y desc)
// ❌ Too many nesting levels

// Subqueries: where id in (select ...)
// ❌ Requires full recursive parser
```

### Coverage Estimate

| Grammar Feature | % of NQL Usage | TypeScript Inferable |
|-----------------|----------------|---------------------|
| Table + pipes | 100% | ✅ |
| Simple select | 80% | ✅ |
| Simple where | 70% | ✅ |
| Order/limit | 90% | ✅ |
| Complex boolean | 30% | ❌ |
| Functions | 40% | ❌ |
| Window | 10% | ❌ |
| Subqueries | 5% | ❌ |

**Conclusion:** ~60-70% of typical queries could theoretically be inferred, but edge cases make it unreliable. **Explicit type annotation for NQL is the pragmatic choice.**
