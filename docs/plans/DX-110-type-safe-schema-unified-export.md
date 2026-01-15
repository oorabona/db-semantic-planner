# DX-110: Type-Safe Schema with Full Inference Chain + Unified Export

## Status: DRAFT
## Priority: HIGH
## Complexity: COMPLEX (architectural change)

---

## 1. Overview

### 1.1 Problem Statement

**Current state:**
- Type inference stops at column level - relations not included in query results
- 3 packages to import for basic usage (`@dbsp/schema`, `core`, `adapter-kysely`)
- No autocomplete on `include('xxx')` - string literals not validated
- Verbose package names (`@dbsp/*`)

**Target state:**
- Prisma-like conditional type inference based on `include()` calls
- Single `dbsp` package for 99% of use cases
- Full LSP support with autocomplete on table names, column names, and relation names
- Clean, memorable package names (`dbsp`, `@dbsp/*`)

### 1.2 User Story

> As a developer using db-semantic-planner,
> I want TypeScript to automatically infer the shape of my query results including relations,
> So that I get compile-time safety and autocomplete without manual type annotations.

### 1.3 Success Criteria

- [ ] `orm.select('users')` autocompletes table names
- [ ] `.include('posts')` autocompletes relation names for the selected table
- [ ] Result type includes nested relations when `include()` is called
- [ ] Single import: `import dbsp, { eq, and } from 'dbsp'`
- [ ] All 1500+ existing tests pass
- [ ] New type-level tests validate inference

---

## 2. Technical Design

### 2.1 Package Structure (Breaking Change)

#### Before
```
packages/
├── schema/           → @dbsp/schema
├── core/             → @dbsp/core
├── adapter-kysely/   → @dbsp/adapter-kysely
├── cli/              → @dbsp/cli
└── mcp-server/       → @dbsp/mcp-server
```

#### After
```
packages/
├── dbsp/             → dbsp (NEW: merged schema + core)
├── kysely/           → @dbsp/kysely (adapter)
├── cli/              → @dbsp/cli
└── mcp-server/       → @dbsp/mcp
```

### 2.2 Type Inference Architecture

#### 2.2.1 Schema Definition with Relations

```typescript
// New schema definition API
const schema = dbsp.schema({
  users: {
    columns: {
      id: { type: 'uuid', primaryKey: true },
      name: { type: 'string' },
      email: { type: 'string', nullable: true },
    },
    relations: {
      posts: dbsp.hasMany('posts', { foreignKey: 'authorId' }),
      profile: dbsp.hasOne('profiles', { foreignKey: 'userId' }),
    },
  },
  posts: {
    columns: {
      id: { type: 'uuid', primaryKey: true },
      title: { type: 'string' },
      authorId: { type: 'uuid' },
    },
    relations: {
      author: dbsp.belongsTo('users', { foreignKey: 'authorId' }),
    },
  },
});
```

#### 2.2.2 Type Inference Chain

```typescript
// 1. Schema → Table Names (literal union)
type TableNames = keyof typeof schema.tables; // 'users' | 'posts'

// 2. Table → Column Types
type UserColumns = InferColumns<typeof schema.tables.users>;
// { id: string; name: string; email: string | null }

// 3. Table → Relation Names
type UserRelations = InferRelationNames<typeof schema.tables.users>;
// 'posts' | 'profile'

// 4. Include → Nested Types (conditional)
type WithPosts = InferWithInclude<typeof schema, 'users', 'posts'>;
// { id: string; name: string; email: string | null; posts: Post[] }
```

#### 2.2.3 Query Builder Type Flow

```typescript
// QueryBuilder is generic over Schema and current Include state
interface QueryBuilder<
  S extends Schema,
  Table extends keyof S['tables'],
  Included extends Record<string, any> = {}
> {
  // include() returns new builder with updated Included type
  include<R extends RelationNamesOf<S, Table>>(
    relation: R
  ): QueryBuilder<S, Table, Included & { [K in R]: InferRelationType<S, Table, R> }>;

  // all() returns merged base type + included relations
  all(): Promise<Array<InferColumns<S['tables'][Table]> & Included>>;
}
```

### 2.3 Unified Export API

```typescript
// dbsp namespace (default export)
const dbsp = {
  // Schema definition
  schema: <T>(def: T) => createTypedSchema(def),

  // Relation helpers (also exported individually)
  hasOne,
  hasMany,
  belongsTo,
  belongsToMany,

  // ORM factory
  createOrm: <S extends Schema>(options: OrmOptions<S>) => createTypedOrm(options),

  // Plan/compile utilities
  plan,
  planRecursive,
};

// Named exports (filter helpers for common usage)
export { eq, neq, gt, gte, lt, lte, like, and, or, not, isNull, isNotNull, inArray };
export { raw, coalesce }; // Expression helpers
export { rank, rowNumber, denseRank, lag, lead }; // Window functions

export default dbsp;
```

---

## 3. BDD Scenarios

### 3.1 Type Inference - Basic

```gherkin
Feature: Type-safe schema inference

  Scenario: Infer column types from schema
    Given a schema with users table having columns (id: uuid, name: string, email: string?)
    When I create an ORM instance with this schema
    And I call orm.select('users').all()
    Then the result type should be { id: string; name: string; email: string | null }[]

  Scenario: Autocomplete table names
    Given a schema with tables (users, posts, comments)
    When I type orm.select('')
    Then LSP should suggest 'users', 'posts', 'comments'

  Scenario: Autocomplete column names in where()
    Given a schema with users table having columns (id, name, email)
    When I type orm.select('users').where(eq(''))
    Then LSP should suggest 'id', 'name', 'email'
```

### 3.2 Type Inference - Relations

```gherkin
Feature: Relation type inference

  Scenario: Include single hasMany relation
    Given a schema where users hasMany posts
    When I call orm.select('users').include('posts').all()
    Then the result type should include posts: Post[]

  Scenario: Include single belongsTo relation
    Given a schema where posts belongsTo users as author
    When I call orm.select('posts').include('author').all()
    Then the result type should include author: User

  Scenario: Include multiple relations
    Given a schema where users hasMany posts and hasOne profile
    When I call orm.select('users').include('posts').include('profile').all()
    Then the result type should include posts: Post[] and profile: Profile

  Scenario: Nested includes
    Given a schema where users hasMany posts, posts hasMany comments
    When I call orm.select('users').include({ posts: { include: 'comments' } }).all()
    Then the result type should include posts: (Post & { comments: Comment[] })[]

  Scenario: Autocomplete relation names
    Given a schema where users hasMany posts and hasOne profile
    When I type orm.select('users').include('')
    Then LSP should suggest 'posts', 'profile'
```

### 3.3 Unified Export

```gherkin
Feature: Unified package export

  Scenario: Import from single package
    Given a project with dbsp installed
    When I write import dbsp, { eq, and } from 'dbsp'
    Then all symbols should be available
    And TypeScript should not report errors

  Scenario: Adapter as separate package
    Given a project with dbsp and @dbsp/kysely installed
    When I write import { kyselyAdapter } from '@dbsp/kysely'
    Then kyselyAdapter should be available
    And kysely should be a peer dependency
```

---

## 4. Implementation Plan

### Block 1: Type System Foundation (packages/dbsp)
**Vertical slice: Schema type inference**

1. Create `packages/dbsp/` directory structure
2. Implement `InferColumns<T>` - column type mapping
3. Implement `InferRelationNames<T>` - relation name extraction
4. Implement `InferRelationType<S, T, R>` - single relation type
5. Write type-level tests with `expectTypeOf`

**Tests:** Type inference for columns and relations
**Deliverable:** Types compile correctly, no runtime changes yet

### Block 2: QueryBuilder Generic Refactor
**Vertical slice: Type-safe query builder**

1. Add schema type parameter to QueryBuilder
2. Make `select<T extends TableNames>()` constrain table names
3. Make `where()` constrain to table columns
4. Make `include<R extends RelationNames>()` track included relations
5. Update `all()` return type to merge base + included

**Tests:** Query builder type tests
**Deliverable:** Autocomplete works for select/where/include

### Block 3: Conditional Include Types (Prisma-like)
**Vertical slice: Include changes result type**

1. Implement `IncludeState` type accumulator
2. Update `include()` to return new builder with updated state
3. Implement `ResolveIncludeType<S, T, I>` for final type resolution
4. Handle nested includes recursively
5. Handle hasMany (array) vs hasOne/belongsTo (object)

**Tests:** Nested include type tests
**Deliverable:** Full Prisma-like type inference

### Block 4: Package Restructure
**Vertical slice: New package layout**

1. Create `packages/dbsp/` with merged schema + core
2. Create `packages/kysely/` (renamed from adapter-kysely)
3. Update all internal imports
4. Create unified `dbsp` namespace export
5. Update package.json files with new names

**Tests:** All existing tests pass with new imports
**Deliverable:** `dbsp` and `@dbsp/kysely` packages ready

### Block 5: CLI and MCP Migration
**Vertical slice: Tooling packages**

1. Rename `packages/cli/` → update to `@dbsp/cli`
2. Rename `packages/mcp-server/` → update to `@dbsp/mcp`
3. Update dependencies to use new package names
4. Update CLI commands if needed

**Tests:** CLI and MCP tests pass
**Deliverable:** Full package ecosystem migrated

---

## 5. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| TypeScript inference limits | Complex nested types may hit TS limits | Limit nesting depth, provide escape hatch |
| Breaking change adoption | Users need to update imports | Provide migration guide, deprecation period |
| npm package availability | `dbsp` may be taken | Check availability, have backup name |
| Build complexity | Merged package may complicate builds | Keep tsup config simple, test thoroughly |

---

## 6. Out of Scope

- Runtime performance changes (types only affect compile-time)
- New query features (focus on types and packaging)
- Database introspection changes
- Migration tooling (separate story)

---

## 7. Dependencies

- TypeScript 5.0+ (for const type parameters)
- Vitest with `expectTypeOf` for type-level tests
- pnpm workspace for monorepo management

---

## 8. Checklist

- [ ] Block 1: Type system foundation
- [ ] Block 2: QueryBuilder generic refactor
- [ ] Block 3: Conditional include types
- [ ] Block 4: Package restructure
- [ ] Block 5: CLI and MCP migration
- [ ] All tests pass (1500+)
- [ ] Type-level tests added
- [ ] Documentation updated
- [ ] Migration guide written
