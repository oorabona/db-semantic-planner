---
doc-meta:
  status: draft
  scope: core, nql
  type: specification
  created: 2026-01-26
  updated: 2026-01-26
  complexity: ENTERPRISE
  time-budget: 60-80h
  hardened: 2026-01-26
  hardening-source: adversarial-review
---

# DX-040: Type-Safe Query API

## 0. Quick Reference

| Item | Value |
|------|-------|
| Scope | core, nql |
| Complexity | ENTERPRISE |
| Time budget | ~60-80h |
| Blocks | 8 |
| BDD scenarios | 24 (+3 from hardening) |
| Risk level | MEDIUM |
| Breaking changes | No (additive) |
| Hardened | ✅ 2026-01-26 (adversarial review) |

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
- **INV-04:** Table/column objects MUST have minimal runtime overhead (metadata carriers only, no heavy computation)
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
- **ERR-04:** Invalid alias name (not matching `/^[a-zA-Z_][a-zA-Z0-9_]*$/`) → Runtime error with clear message
- **ERR-05:** Reserved JS identifier as table/column name → Runtime warning (not error) with bracket notation suggestion

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

#### 4.2.0 Metadata Symbols (Hardening: No Collision)

**Problem:** Using `_table`, `_brand` as property names could collide with user columns.

**Solution:** Use ES6 Symbols for internal metadata. Symbols cannot collide with string property names.

```typescript
// packages/core/src/dx/symbols.ts

/** @description Symbol for accessing table name metadata */
export const TABLE_META = Symbol.for('dbsp:table');

/** @description Symbol for accessing column name metadata */
export const COLUMN_META = Symbol.for('dbsp:column');

/** @description Symbol for accessing relation metadata */
export const RELATION_META = Symbol.for('dbsp:relation');

/** @description Symbol for type branding (internal use) */
export const BRAND = Symbol.for('dbsp:brand');
```

**Why `Symbol.for()` instead of `Symbol()`:**
- `Symbol.for()` creates global symbols that survive serialization
- Same key always returns same symbol (useful for cross-module access)

#### 4.2.1 Table Reference Types

```typescript
/**
 * Reference to a table in the schema.
 *
 * @typeParam TName - The table name as a string literal type
 * @typeParam TColumns - Record mapping column names to ColumnRef types
 * @typeParam TRelations - Record mapping relation names to RelationRef types
 *
 * @description
 * TableRef uses Symbols for internal metadata to avoid collision with user columns.
 * The wildcard `'*'` is used for SELECT * (cannot be a valid SQL identifier).
 */
interface TableRef<
  TName extends string,
  TColumns extends Record<string, ColumnRef<TName, string, unknown>>,
  TRelations extends Record<string, RelationRef<string, unknown, RelationType>> = {}
> {
  // Internal metadata via Symbols (no collision possible)
  readonly [TABLE_META]: TName;
  readonly [BRAND]: 'TableRef';

  // All columns as ColumnRef objects
  readonly [K in keyof TColumns]: TColumns[K];

  // All relations as RelationRef objects
  readonly [K in keyof TRelations]: TRelations[K];

  // Wildcard for SELECT * — '*' is never a valid SQL identifier
  readonly '*': AllColumns<TName, TColumns>;
}
```

**Usage:**

```typescript
const { users } = s.tables;

// Column access
users.id           // ColumnRef<'users', 'id', number>
users.name         // ColumnRef<'users', 'name', string>

// Wildcard (SELECT *)
users['*']         // AllColumns<'users', {...}>

// Internal metadata (rarely needed by users)
users[TABLE_META]  // 'users'
```

#### 4.2.2 Column Reference Types

```typescript
/**
 * Reference to a column in a table.
 *
 * @typeParam TTable - The table name
 * @typeParam TColumn - The column name
 * @typeParam TType - The TypeScript type of the column value
 */
interface ColumnRef<
  TTable extends string,
  TColumn extends string,
  TType
> {
  readonly [TABLE_META]: TTable;
  readonly [COLUMN_META]: TColumn;
  readonly [BRAND]: 'ColumnRef';

  // Type phantom (for inference, not runtime)
  readonly _type: TType;

  /**
   * Create an aliased version of this column for result type inference.
   * @param alias - Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ (validated at runtime)
   */
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
 *
 * @typeParam TTarget - The target table name
 * @typeParam TTargetType - The TypeScript type of related records
 * @typeParam TRelationType - 'belongsTo' | 'hasMany' | 'hasOne'
 * @typeParam TTargetColumns - Record mapping target column names to their types
 */
interface RelationRef<
  TTarget extends string,
  TTargetType,
  TRelationType extends 'belongsTo' | 'hasMany' | 'hasOne',
  TTargetColumns extends Record<string, unknown> = Record<string, unknown>
> {
  readonly [RELATION_META]: { target: TTarget; type: TRelationType };
  readonly [BRAND]: 'RelationRef';
  readonly _type: TTargetType;

  // Access columns through relation (for cross-table queries)
  readonly [K in keyof TTargetColumns]: ColumnRef<TTarget, K & string, TTargetColumns[K]>;

  // Wildcard for relation.* in select
  readonly '*': AllColumns<TTarget, TTargetColumns>;
}
```

#### 4.2.4 Proxy Implementation (Reserved Words Support)

**Problem:** JavaScript reserved words (`constructor`, `prototype`, `__proto__`) shadow user columns.

**Solution:** Use Proxy to intercept all property access and prioritize column lookup.

```typescript
const JS_RESERVED = new Set([
  'constructor', 'prototype', '__proto__',
  'toString', 'valueOf', 'hasOwnProperty',
  'isPrototypeOf', 'propertyIsEnumerable'
]);

function createTableRef<TName extends string, TColumns>(
  tableName: TName,
  columns: TColumns,
  relations: Record<string, RelationDef>
): TableRef<TName, TColumns> {
  const columnSet = new Set(Object.keys(columns));

  return new Proxy({} as TableRef<TName, TColumns>, {
    get(target, prop, receiver) {
      // Symbol access (internal metadata)
      if (typeof prop === 'symbol') {
        if (prop === TABLE_META) return tableName;
        if (prop === BRAND) return 'TableRef';
        return undefined;
      }

      // String access
      if (typeof prop === 'string') {
        // Wildcard
        if (prop === '*') {
          return createAllColumns(tableName, columns);
        }

        // Column — ALWAYS prioritized over native properties
        if (columnSet.has(prop)) {
          return createColumnRef(tableName, prop, columns[prop]);
        }

        // Relation
        if (prop in relations) {
          return createRelationRef(relations[prop]);
        }

        // Warn if reserved word that's not a column
        if (JS_RESERVED.has(prop)) {
          // Not a column, but user might expect it to be
          return undefined;
        }
      }

      // Unknown property
      return undefined;
    },

    has(target, prop) {
      if (typeof prop === 'symbol') return prop === TABLE_META || prop === BRAND;
      if (typeof prop === 'string') {
        return prop === '*' || columnSet.has(prop) || prop in relations;
      }
      return false;
    },

    ownKeys() {
      return [...columnSet, '*', ...Object.keys(relations)];
    }
  });
}
```

**Behavior:**

```typescript
// Schema with reserved word as column name
const s = schema({
  users: { id: 'integer', name: 'string', constructor: 'string' }
});

const { users } = s.tables;

users.id          // ColumnRef ✅
users.constructor // ColumnRef ✅ (Proxy intercepts, returns column, NOT Function)
users['*']        // AllColumns ✅
users.unknown     // undefined ✅
```

**Warning at schema creation:**

```typescript
function schema<T>(def: T): Schema<T> {
  for (const [tableName, tableDef] of Object.entries(def)) {
    for (const colName of Object.keys(tableDef)) {
      if (JS_RESERVED.has(colName)) {
        console.warn(
          `⚠️ Column '${tableName}.${colName}' uses a JavaScript reserved identifier. ` +
          `It will work at runtime via Proxy, but TypeScript may show warnings. ` +
          `Consider using bracket notation: ${tableName}['${colName}']`
        );
      }
    }
  }
  // ... rest of implementation
}
```

#### 4.2.5 Schema Table Extraction

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

  // Relations - TRel is a key of TTable where TTable[TRel] is a RelationRef
  include<TRel extends keyof TTable>(
    relation: TRel & (TTable[TRel] extends RelationRef<any, any, any, any> ? TRel : never)
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

// Expression type union for flexibility
type Expr<T> = ColumnRef<any, any, T> | AggregateExpr<T> | ScalarExpr<T> | T;

// Equality - accepts column, aggregate, or literal
function eq<T>(left: Expr<T>, right: Expr<T>): WhereCondition;

// Comparison - accepts column, aggregate, or literal (numeric/date types)
function gt<T extends number | Date>(left: Expr<T>, right: Expr<T>): WhereCondition;
function gte<T extends number | Date>(left: Expr<T>, right: Expr<T>): WhereCondition;
function lt<T extends number | Date>(left: Expr<T>, right: Expr<T>): WhereCondition;
function lte<T extends number | Date>(left: Expr<T>, right: Expr<T>): WhereCondition;

// String operations - column or scalar expression
function like(column: Expr<string>, pattern: string): WhereCondition;
function ilike(column: Expr<string>, pattern: string): WhereCondition;

// Null checks
function isNull<T>(column: ColumnRef<any, any, T | null>): WhereCondition;
function isNotNull<T>(column: ColumnRef<any, any, T | null>): WhereCondition;

// IN clause
function inArray<T>(column: Expr<T>, values: T[]): WhereCondition;

// Boolean composition
function and(...conditions: WhereCondition[]): WhereCondition;
function or(...conditions: WhereCondition[]): WhereCondition;
function not(condition: WhereCondition): WhereCondition;

// Cross-table filter (EXISTS subquery)
function exists<TRel extends RelationRef<any, any, 'hasMany', any>>(
  relation: TRel,
  condition: (rel: TRel) => WhereCondition
): WhereCondition;
```

#### 4.3.3 SQL Functions (Type-Safe)

```typescript
// Aggregates - support column, relation (for count), or expression
function count(): AggregateExpr<number>;                                          // COUNT(*)
function count<T>(column: ColumnRef<any, any, T>): AggregateExpr<number>;         // COUNT(column)
function count<T>(relation: RelationRef<any, T[], any, any>): AggregateExpr<number>; // COUNT(relation.*) → subquery
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

### 4.7 Edge Cases & Considerations

#### 4.7.1 Null/Undefined Semantics

Database `NULL` maps to TypeScript `null`, not `undefined`.

```typescript
// Schema defines nullable column
const s = schema({
  users: {
    id: 'integer',
    nickname: 'string?',  // nullable
    name: 'string'        // required
  }
});

// Result type includes null for nullable columns
type UserResult = {
  id: number;
  nickname: string | null;  // NOT string | undefined
  name: string;
};

// Coalesce removes null from result type
orm.from(users)
  .select(coalesce(users.nickname, users.name).as('displayName'))
// Result: { displayName: string }[]  (not string | null)
```

**Rule:** Nullable columns are typed as `T | null`. Use `coalesce()` or `??` to narrow.

#### 4.7.2 Namespace Collisions (Solved via Symbols + Proxy)

**Previous concern:** Property names could collide with user columns.

**Solution (Hardening 2026-01-26):**

1. **Symbols for metadata:** `TABLE_META`, `COLUMN_META`, `BRAND` are Symbols — cannot collide with string column names.

2. **`'*'` for wildcard:** The asterisk character is never a valid SQL identifier, so `users['*']` cannot collide.

3. **Proxy for JS reserved words:** Even `constructor`, `prototype`, `__proto__` work as column names via Proxy interception (see section 4.2.4).

**No reserved column names exist.** Any valid SQL column name works.

**Only warning (not error):** Schema creation logs a warning for JS reserved words, suggesting bracket notation for TypeScript clarity:

```typescript
// Warning logged at schema creation, but works at runtime
const s = schema({
  users: { id: 'integer', constructor: 'string' }  // ⚠️ Warning logged
});

users.constructor  // Works via Proxy → ColumnRef
users['constructor']  // Also works, clearer for TypeScript
```

#### 4.7.3 Dynamic Query Composition

Building queries conditionally at runtime:

```typescript
// Pattern 1: Conditional where clauses
let query = orm.from(users);

if (filters.name) {
  query = query.where(eq(users.name, filters.name));
}
if (filters.minAge) {
  query = query.where(gt(users.age, filters.minAge));
}

const result = await query.all();

// Pattern 2: Builder accumulator for complex logic
const conditions: WhereCondition[] = [];
if (filters.name) conditions.push(eq(users.name, filters.name));
if (filters.active) conditions.push(eq(users.active, true));

const query = orm.from(users)
  .where(conditions.length > 0 ? and(...conditions) : alwaysTrue())
  .all();

// Pattern 3: Dynamic column selection
const columns = [users.id, users.name];
if (includeEmail) columns.push(users.email);

const query = orm.from(users).pick(...columns);
// Note: Result type is union of all possible shapes
```

#### 4.7.4 Circular Type References

Bidirectional relations create circular types. TypeScript handles this but care is needed.

```typescript
// User has posts, Post has author (User) → circular
const s = schema({
  users: { id: 'integer', name: 'string' },
  posts: { id: 'integer', authorId: ref('users'), title: 'string' }
});

// users.posts.author would be circular
// Solution: Limit relation depth in types (default: 2 levels)

users.posts          // ✅ RelationRef<'posts', ...>
users.posts.title    // ✅ ColumnRef<'posts', 'title', string>
users.posts.author   // ✅ RelationRef<'users', ...> (1 level back)
users.posts.author.posts  // ⚠️ Type becomes `any` to break recursion

// Runtime still works; just no type inference beyond depth limit
```

**Implementation:** Use `type-fest`'s `ConditionalSimplify` or explicit depth counters to prevent "Type instantiation is excessively deep" errors.

#### 4.7.5 Semantic Equivalence Testing

Native API and NQL MUST produce identical IntentIR. Test strategy:

```typescript
it('native and NQL produce same IntentIR', () => {
  const nativeIR = orm.from(users)
    .where(eq(users.name, 'John'))
    .pick(users.id)
    .toIntentIR();

  const nqlIR = orm.nql`users | where name = 'John' | select id`.toIntentIR();

  // Deep equality on IntentIR structure
  expect(normalizeIR(nativeIR)).toEqual(normalizeIR(nqlIR));
});
```

**Note:** SQL string comparison is fragile (whitespace, alias naming). Compare IntentIR instead.

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

### Scenario Group: Edge Cases

```gherkin
@priority:medium @type:edge
Scenario: SC-19 Nullable column type inference
  Given users.nickname is nullable string
  When I execute `orm.from(users).pick(users.nickname).all()`
  Then result type is `{ nickname: string | null }[]`
  And coalesce(users.nickname, 'default') has type string (not null)

@priority:low @type:edge
Scenario: SC-20 JS reserved word as column name (Proxy support)
  Given schema with column named 'constructor'
  When schema is created
  Then console.warn is called suggesting bracket notation
  And `users.constructor` returns ColumnRef (via Proxy)
  And `users['constructor']` also works

@priority:medium @type:edge
Scenario: SC-21 Dynamic query composition
  Given filter object with optional name and minAge fields
  When I build query conditionally:
    ```
    let q = orm.from(users);
    if (filters.name) q = q.where(eq(users.name, filters.name));
    if (filters.minAge) q = q.where(gt(users.age, filters.minAge));
    ```
  Then final query includes only applied filters
  And TypeScript allows reassignment without type errors

@priority:medium @type:edge @hardening
Scenario: SC-22 Empty schema returns empty tables object
  Given schema definition with no tables: `schema({})`
  When I access `s.tables`
  Then it returns typed empty object `{}`
  And TypeScript infers type `{}`

@priority:high @type:error @hardening
Scenario: SC-23 Invalid alias name rejected
  Given a valid query with column alias
  When I use invalid alias `.as('invalid-name')`
  Then throw error "Invalid alias 'invalid-name': must match /^[a-zA-Z_][a-zA-Z0-9_]*$/"
  When I use valid alias `.as('validName')`
  Then query succeeds

@priority:medium @type:edge @hardening
Scenario: SC-24 Wildcard access via bracket notation
  Given a schema with users table
  When I access `users['*']`
  Then it returns AllColumns<'users', {...}>
  And using in select: `orm.from(users).select(users['*']).all()`
  Then SQL contains SELECT *
```

### Coverage Matrix

| Scenario | Nominal | Edge | Error | Security | Hardening |
|----------|---------|------|-------|----------|-----------|
| SC-01 | ✓ | | | | |
| SC-02 | ✓ | | | | |
| SC-03 | | | ✓ | | |
| SC-04 | ✓ | | | | |
| SC-05 | ✓ | | | | |
| SC-06 | ✓ | | ✓ | | |
| SC-07 | ✓ | | | | |
| SC-08 | ✓ | | | | |
| SC-09 | ✓ | | | | |
| SC-10 | ✓ | | | | |
| SC-11 | ✓ | | | | |
| SC-12 | ✓ | | | | |
| SC-13 | ✓ | | | | |
| SC-14 | ✓ | | | | |
| SC-15 | ✓ | | | | |
| SC-16 | | ✓ | | | |
| SC-17 | | ✓ | | | |
| SC-18 | | | ✓ | | |
| SC-19 | | ✓ | | | |
| SC-20 | | ✓ | | | ✓ |
| SC-21 | | ✓ | | | |
| SC-22 | | ✓ | | | ✓ |
| SC-23 | | | ✓ | ✓ | ✓ |
| SC-24 | | ✓ | | | ✓ |

## 6. Implementation Plan

> **Note:** Time estimates revised based on multi-LLM review consensus (Codex, Gemini, LM Studio).
> Original 40h estimate was optimistic. Realistic range: **60-80h** accounting for:
> - TypeScript type complexity and compiler edge cases
> - Comprehensive equivalence testing (Native ↔ NQL)
> - Edge cases (null semantics, circular refs, dynamic composition)

### Block 1: Table/Column Reference Types — 7h (+1h Hardening)

**Type:** Infrastructure
**Dependencies:** None
**Packages:** core

**Files:**
- `packages/core/src/dx/symbols.ts` — TABLE_META, COLUMN_META, RELATION_META, BRAND symbols **(H-01)**
- `packages/core/src/dx/table-ref.ts` — TableRef, ColumnRef, RelationRef types (using Symbols)
- `packages/core/src/dx/table-ref.test.ts` — Type-level tests

**Exit criteria:**
- [ ] Symbols exported: `TABLE_META`, `COLUMN_META`, `RELATION_META`, `BRAND`
- [ ] TableRef<TName, TColumns> type defined with Symbol metadata
- [ ] ColumnRef<TTable, TColumn, TType> type defined with Symbol metadata
- [ ] RelationRef<TTarget, TType, TRelation> type defined
- [ ] `'*'` wildcard property defined on TableRef and RelationRef **(H-02)**
- [ ] Type tests pass with expectTypeOf
- [ ] JSDoc on all exported generic types **(DOC-01)**

### Block 2: Schema Tables Extraction — 6h (+2h Hardening)

**Type:** Feature
**Dependencies:** Block 1
**Packages:** core

**Files:**
- `packages/core/src/dx/schema.ts` — Add `.tables` property with Proxy implementation **(H-03)**
- `packages/core/src/dx/schema.test.ts` — Tests for tables extraction + reserved words

**Exit criteria:**
- [ ] `s.tables` returns typed table objects via Proxy
- [ ] `users.id` returns ColumnRef
- [ ] `users.posts` returns RelationRef (inverse relation)
- [ ] Relations inferred from ref() declarations
- [ ] `users['*']` returns AllColumns **(H-02)**
- [ ] Proxy intercepts JS reserved words (`constructor`, etc.) → returns ColumnRef **(H-03)**
- [ ] `schema({})` returns empty `.tables` typed as `{}` **(SC-22)**
- [ ] Warning logged for reserved word column names **(ERR-05)**

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

### Block 4: Query Builder with Type Inference — 14h ⚠️

> **Revised up from 8h:** Type inference with generics, method chaining, and conditional types
> is where most TypeScript complexity lives. Includes fighting compiler edge cases.

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
- [ ] Dynamic query composition works (conditional where chaining)
- [ ] No "Type instantiation is excessively deep" errors
- [ ] Alias validation: `.as('invalid-name')` throws with clear error **(ERR-04, SC-23)**

### Block 5: SQL Functions (Aggregates, Scalars) — 10h ⚠️

> **Revised up from 6h:** Function overloads, null semantics, and expression type inference
> require careful design. CASE expressions add complexity.

**Type:** Feature
**Dependencies:** Block 4
**Packages:** core

**Files:**
- `packages/core/src/dx/functions.ts` — count, sum, avg, coalesce, case, etc.
- `packages/core/src/dx/functions.test.ts` — Function tests

**Exit criteria:**
- [ ] `count()`, `count(users.id)`, `count(users.posts)` all work
- [ ] `sum(users.amount)` requires number column
- [ ] `coalesce(users.nickname, users.name)` infers `string` (removes null)
- [ ] `.as('alias')` works for result naming
- [ ] `caseWhen().when().else()` builder works
- [ ] Null semantics correct (nullable → T | null)

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

### Block 7: Cross-Table Queries — 12h ⚠️

> **Revised up from 6h:** Relation path resolution, EXISTS/JOIN decisions, and adapter
> modifications are complex. Circular reference handling adds time.

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
- [ ] Circular relation depth limit works (2 levels default)
- [ ] IntentIR matches NQL for all cross-table patterns

### Block 8: NQL Type Integration & Equivalence Testing — 8h ⚠️

> **Revised up from 2h:** Equivalence testing between Native and NQL is critical and
> requires comprehensive test suite with IntentIR comparison (not SQL string comparison).

**Type:** Feature
**Dependencies:** Block 4, Block 7
**Packages:** core, nql

**Files:**
- `packages/core/src/dx/nql.ts` — orm.nql template literal
- `packages/core/src/dx/nql.test.ts` — Tests
- `packages/core/src/dx/equivalence.test.ts` — Native ↔ NQL IntentIR comparison tests

**Exit criteria:**
- [ ] `orm.nql<T>\`query\`` returns T[]
- [ ] NQL and native API produce identical IntentIR (not just SQL)
- [ ] `toIntentIR()` method exposed for debugging
- [ ] 20+ equivalence test cases covering all query patterns
- [ ] Documentation for when to use which API
- [ ] Equivalence tests integrated in CI and block merge on failure **(CI-01)**

## 7. Test Strategy

### Test Pyramid

| Level | Count | Focus |
|-------|-------|-------|
| Unit | 60+ | Type inference, individual functions |
| Integration | 25+ | Query builder → IntentIR → SQL |
| E2E | 10+ | Full execution against PostgreSQL |
| Equivalence | 20+ | Native ↔ NQL IntentIR comparison |

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

### Equivalence Tests (Critical)

Native API and NQL MUST produce identical IntentIR. Compare IntentIR (not SQL strings).

```typescript
describe('Native ↔ NQL Equivalence', () => {
  it.each([
    ['simple select', 'users | select id, name'],
    ['where clause', 'users | where name = "John"'],
    ['cross-table', 'users | where posts.published = true'],
    ['aggregate', 'users | select count(posts.*) as postCount | group by name'],
    // ... 20+ cases
  ])('produces same IntentIR: %s', (_, nql) => {
    const nativeIR = buildNativeEquivalent(nql).toIntentIR();
    const nqlIR = orm.nql`${nql}`.toIntentIR();
    expect(normalizeIR(nativeIR)).toEqual(normalizeIR(nqlIR));
  });
});
```

### Test Data Requirements

- Reuse existing test schemas (blog, pimdam)
- Add specific fixtures for:
  - Cross-table aggregations
  - Window function scenarios
  - Dynamic schema cases

### Performance Tests (Hardening PERF-01, PERF-02)

```typescript
// packages/core/src/dx/performance.test.ts

describe('Type Inference Performance', () => {
  it('PERF-01: tsc completes in < 5s for 100-table schema', async () => {
    // Generate 100-table schema fixture
    const schema100 = generateLargeSchema(100);

    const start = performance.now();
    // Run tsc on fixture file
    await execAsync('pnpm tsc --noEmit fixtures/large-schema.ts');
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(5000);
  });

  it('PERF-02: IDE autocomplete responds in < 500ms (manual)', () => {
    // This is a manual verification criterion
    // Document: Open VSCode, type `users.` and measure autocomplete delay
    // Acceptance: < 500ms on 20-table schema
    expect(true).toBe(true); // Placeholder
  });
});
```

**Test Fixture:** `packages/core/src/dx/__fixtures__/large-schema.ts` — 100-table schema for perf testing.

## 8. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| TypeScript complexity (recursive types) | H | M | Use type tests extensively; simplify if compiler slows |
| API surface too large | M | M | Start with most common operations; add incrementally |
| Semantic drift between Native/NQL | H | L | Share IntentIR generation code; comprehensive tests |
| Dynamic schema DX poor | M | H | Document patterns; provide type cast helpers |
| Breaking existing string API | H | L | Keep string API working; new API is additive |

## 9. Definition of Done

### Core Deliverables

- [ ] All 8 blocks implemented
- [ ] All 24 BDD scenarios have passing tests (+3 from hardening)
- [ ] Type-level tests verify inference
- [ ] Integration tests verify IntentIR equivalence
- [ ] E2E tests verify SQL execution
- [ ] Documentation updated (API reference, examples)
- [ ] TODO.md updated
- [ ] /review clean (no blocking findings)

### Performance Criteria (Hardening PERF-01, PERF-02)

- [ ] **PERF-01:** `tsc` completes type checking in < 5s for 100-table schema test fixture
- [ ] **PERF-02:** IDE autocomplete responds in < 500ms on 20-table schema (manual verification)

### Developer Experience Criteria (Hardening DX-01)

- [ ] **DX-01:** Type error messages do not exceed 3 levels of generic nesting (verified via sample errors)

### Documentation Criteria (Hardening DOC-01)

- [ ] **DOC-01:** All exported generic types have JSDoc comments explaining:
  - Each type parameter's purpose
  - Example usage
  - Any constraints or edge cases

### CI Integration (Hardening CI-01)

- [ ] **CI-01:** Native ↔ NQL equivalence tests run in CI and block merge on failure
- [ ] Equivalence test suite covers 20+ query patterns (simple, filter, join, aggregate, window)

### Security Criteria (Hardening ERR-04)

- [ ] **ERR-04:** Alias validation rejects names not matching `/^[a-zA-Z_][a-zA-Z0-9_]*$/`
- [ ] Validation error message is clear and actionable

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

## 11. Hardening Summary (Adversarial Review 2026-01-26)

This spec was hardened via `/adversarial` review applying 5 perspectives.

### Changes from Hardening

| ID | Type | Change | Section |
|----|------|--------|---------|
| H-01 | Architecture | Use ES6 Symbols for metadata (`TABLE_META`, `COLUMN_META`, `BRAND`) | 4.2.0 |
| H-02 | Architecture | Use `'*'` for wildcard (cannot be SQL identifier) | 4.2.1 |
| H-03 | Architecture | Proxy for JS reserved words support (`constructor`, etc.) | 4.2.4 |
| H-04 | Security | Alias validation regex `/^[a-zA-Z_][a-zA-Z0-9_]*$/` | 3.4 ERR-04 |
| H-05 | Edge Case | Empty schema returns typed `{}` | SC-22 |
| H-06 | Performance | Type inference < 5s for 100-table schema | PERF-01 |
| H-07 | Performance | IDE autocomplete < 500ms on 20-table schema | PERF-02 |
| H-08 | DX | Type errors max 3 levels of generic nesting | DX-01 |
| H-09 | Documentation | JSDoc required on all exported generics | DOC-01 |
| H-10 | CI | Equivalence tests block merge | CI-01 |

### Perspectives Applied

| Perspective | Challenges | Resolved |
|-------------|------------|----------|
| Skeptic 🤔 | 2 | 2 |
| Edge Case Hunter 🔍 | 4 | 4 |
| Security Auditor 🔒 | 3 | 2 (1 out of scope) |
| Performance Pessimist ⚡ | 3 | 3 |
| Future Maintainer 📅 | 3 | 2 (1 deferred) |
| **Total** | **15** | **13** |

### Deferred Items

| Item | Reason | Track In |
|------|--------|----------|
| Alternative wildcard naming (`$all` vs `'*'`) | Current works, revisit on feedback | TODO_DX.md |
| Partial NQL type inference | Complex, explicit types pragmatic | Future enhancement |
