---
doc-meta:
  status: canonical
  scope: core, cli, adapter
  type: spec
  created: 2026-01-25
  updated: 2026-01-25
  breaking: yes
  reviewed-by: codex, lmstudio
---

# ARCH-005: Unified Schema API

## Summary

Replace the three existing schema definition APIs (`defineSchema()`, `TypedSchema`, `GeneratedSchema`) with a single unified `schema()` function using `ref()` for foreign keys and automatic relation inference.

**Key simplification:** Only 2 exports: `schema()` and `ref()`. No `manyToMany()`, `hasOne()`, `hasMany()`, `belongsTo()`.

## Problem Statement

### Current State: 3 APIs

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  ResolvedSchema │     │   TypedSchema   │     │ GeneratedSchema │
│  (defineSchema) │     │ (hasOne/hasMany)│     │  (CLI codegen)  │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         ▼                       ▼                       ▼
buildModelFromResolved   typedSchemaToModelIR   buildModelFromSchema
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 ▼
                            ┌─────────┐
                            │ ModelIR │
                            └─────────┘
```

### Issues

1. **DX Confusion**: Which API to use? 3 different syntax styles
2. **Redundancy**: Relations declared twice (FK column + explicit relation)
3. **Bug Surface**: `hasOne` not supported in GeneratedSchema (discovered bug)
4. **Maintenance**: 3 conversion paths to ModelIR = 3x bugs potential
5. **Verbosity**: `hasOne()`, `hasMany()`, `belongsTo()` add no value when FK exists

### Root Cause

- Organic evolution without unified vision
- Premature optimization for TypeScript ergonomics
- No "single source of truth" constraint

## Solution: Unified `schema()` + `ref()` API

### Design Principles

1. **Single entry point**: `schema()` for all use cases
2. **FK as source of truth**: Relations deduced from `ref()` declarations
3. **Minimal syntax**: String for simple types, object for options
4. **Explicit only when ambiguous**: Self-ref roles, multi-FK naming
5. **No magic**: Junction tables are normal tables, no auto-inference
6. **camelCase everywhere**: Schema is JS/TS, adapter handles physical naming

### New API

```typescript
import { schema, ref } from '@dbsp/core';

const db = schema({
  // ═══════════════════════════════════════════════════════════════
  // COLUMNS: Hybrid format (string | object)
  // ═══════════════════════════════════════════════════════════════
  users: {
    id: 'uuid',                              // Short form
    name: 'text',
    email: { type: 'text', unique: true },   // With options
    age: { type: 'integer', nullable: true },
  },

  // ═══════════════════════════════════════════════════════════════
  // FK SIMPLE (1:N) - Inverse auto: {relation}_{table}
  // ═══════════════════════════════════════════════════════════════
  posts: {
    id: 'uuid',
    title: 'text',
    authorId: ref('users'),
    // Generates:
    //   posts.author (belongsTo) - name derived from column (authorId → author)
    //   users.author_posts (hasMany) - pattern {relation}_{table}
  },

  // ═══════════════════════════════════════════════════════════════
  // FK with custom inverse
  // ═══════════════════════════════════════════════════════════════
  comments: {
    id: 'uuid',
    content: 'text',
    postId: ref('posts', { inverse: 'comments' }),
    // Generates:
    //   comments.post (belongsTo)
    //   posts.comments (hasMany) ← custom name
  },

  // ═══════════════════════════════════════════════════════════════
  // FK 1:1 (unique on the FK column)
  // ═══════════════════════════════════════════════════════════════
  profiles: {
    id: 'uuid',
    bio: 'text',
    userId: ref('users', { unique: true }),
    // Generates:
    //   profiles.user (belongsTo)
    //   users.user_profile (hasOne because FK is unique)
  },

  // ═══════════════════════════════════════════════════════════════
  // MULTI-FK to same table - explicit naming required
  // ═══════════════════════════════════════════════════════════════
  documents: {
    id: 'uuid',
    title: 'text',
    createdById: ref('users', { as: 'createdBy' }),
    updatedById: ref('users', { as: 'updatedBy', nullable: true }),
    // Generates:
    //   documents.createdBy, documents.updatedBy
    //   users.createdBy_documents, users.updatedBy_documents
  },

  // ═══════════════════════════════════════════════════════════════
  // SELF-REF with roles (MANDATORY for self-ref)
  // ═══════════════════════════════════════════════════════════════
  categories: {
    id: 'uuid',
    name: 'text',
    parentId: ref('categories', {
      nullable: true,
      onDelete: 'SET NULL',
      roles: {
        parent: 'parent',           // required
        children: 'children',       // required
        ancestors: 'ancestors',     // optional, defaults to 'ancestors'
        descendants: 'descendants', // optional, defaults to 'descendants'
      },
    }),
    // Generates:
    //   categories.parent (direct up)
    //   categories.children (direct down)
    //   categories.ancestors (recursive up via CTE)
    //   categories.descendants (recursive down via CTE)
  },

  // ═══════════════════════════════════════════════════════════════
  // SELF-REF with custom role names (org hierarchy)
  // ═══════════════════════════════════════════════════════════════
  employees: {
    id: 'uuid',
    name: 'text',
    managerId: ref('employees', {
      nullable: true,
      roles: {
        parent: 'manager',
        children: 'directReports',
        ancestors: 'managementChain',
        descendants: 'allReports',
      },
    }),
    // Generates:
    //   employees.manager, employees.directReports
    //   employees.managementChain (recursive CTE up)
    //   employees.allReports (recursive CTE down)
  },

  // ═══════════════════════════════════════════════════════════════
  // M:N - Just a normal table with refs! No magic.
  // ═══════════════════════════════════════════════════════════════
  tags: {
    id: 'uuid',
    name: 'text',
  },

  postTags: {
    // Junction table = normal table
    postId: ref('posts'),
    tagId: ref('tags'),
    // Can add metadata anytime:
    // createdAt: 'timestamp',
  },

  // ═══════════════════════════════════════════════════════════════
  // M:N with metadata - same pattern, just add columns
  // ═══════════════════════════════════════════════════════════════
  projectAssignments: {
    id: 'uuid',
    userId: ref('users', { as: 'assignee' }),
    projectId: ref('projects'),
    role: 'text',
    assignedAt: 'timestamp',
    // Query via: projectAssignments with include assignee, project
    // No magic users.projects relation - explicit is better
  },

  projects: {
    id: 'uuid',
    title: 'text',
  },
});
```

## Type Signatures

### `schema()`

```typescript
type ColumnType = 'uuid' | 'text' | 'string' | 'integer' | 'boolean' |
                  'timestamp' | 'date' | 'decimal' | 'json' | 'jsonb';

type ColumnDef = ColumnType | {
  type: ColumnType;
  nullable?: boolean;
  unique?: boolean;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  default?: string;
  index?: boolean;
};

type TableDef = {
  [columnName: string]: ColumnDef | RefDefinition;
};

type SchemaDefinition = {
  [tableName: string]: TableDef;  // tableName in camelCase
};

function schema<T extends SchemaDefinition>(def: T): Schema<T>;
```

### `ref()`

```typescript
interface RefOptions {
  // FK column constraints (applied to THIS column)
  nullable?: boolean;        // Is this FK nullable? → optional relation
  unique?: boolean;          // Is this FK unique? → 1:1 instead of 1:N

  // FK behavior
  onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';

  // Relation naming
  as?: string;               // Local relation name (e.g., 'createdBy')
  inverse?: string;          // Inverse relation name (e.g., 'createdDocuments')

  // Self-ref only (MANDATORY when source === target)
  roles?: {
    parent: string;          // required - e.g., 'manager'
    children: string;        // required - e.g., 'directReports'
    ancestors?: string;      // optional - defaults to 'ancestors'
    descendants?: string;    // optional - defaults to 'descendants'
  };
}

function ref(target: string, options?: RefOptions): RefDefinition;
```

**Note:** `ref()` does NOT accept `type` - it's automatically inferred from the target table's primary key.

## Relation Inference Rules

### Deduction Table

| Declaration | Local Relation | Inverse Relation | Cardinality |
|-------------|----------------|------------------|-------------|
| `authorId: ref('users')` | `posts.author` | `users.author_posts` | N:1 / 1:N |
| `authorId: ref('users', { inverse: 'writings' })` | `posts.author` | `users.writings` | N:1 / 1:N |
| `authorId: ref('users', { as: 'writer' })` | `posts.writer` | `users.writer_posts` | N:1 / 1:N |
| `userId: ref('users', { unique: true })` | `profiles.user` | `users.user_profile` | 1:1 |
| `parentId: ref('categories', { roles: {...} })` | `.parent`, `.children`, `.ancestors`, `.descendants` | — | self-ref |

### Cardinality Detection

| FK Property | Result |
|-------------|--------|
| `unique: false` (default) | 1:N (hasMany on inverse) |
| `unique: true` | 1:1 (hasOne on inverse) |
| `nullable: true` | Optional relation |
| `nullable: false` (default) | Required relation |

### Naming Conventions

All naming is **camelCase** (JS/TS standard). Physical naming (snake_case) is handled by the adapter.

- **Local relation**: Column name without `Id` suffix → `authorId` → `author`
- **Inverse relation**: `{localRelation}_{tableName}` → `author_posts`
- **Self-ref**: Uses `roles.parent`, `roles.children`, `roles.ancestors`, `roles.descendants`

### M:N Relations

**No automatic M:N inference.** Junction tables are normal tables with refs.

```typescript
// This is just a table, not magic
postTags: {
  postId: ref('posts'),
  tagId: ref('tags'),
}

// To query M:N, use explicit includes:
// posts with include postTags.tag
// NOT: posts with include tags (this doesn't exist)
```

**Why no manyToMany()?**
1. Junction tables often grow metadata (createdAt, role, etc.)
2. Explicit is better than implicit
3. No naming ambiguity
4. One pattern for everything

## Validation Rules

Build-time errors from `schema()`:

| Condition | Error |
|-----------|-------|
| `ref('nonexistent')` | FK to non-existent table |
| Two refs to same table without `as` | Multi-FK requires explicit naming |
| `ref('sameTable')` without `roles` | Self-ref requires roles |
| `roles` on non-self-ref | Roles only valid for self-referential FK |
| Duplicate relation names | Collision between relations or columns |

## Migration Path

### Files to DELETE (no backward compat)

```
packages/core/src/schema-dsl.ts           → DELETE
packages/core/src/schema-dsl-types.ts     → DELETE
packages/core/src/dx/prisma-types.ts      → DELETE (TypedSchema, hasOne, hasMany, belongsTo)
```

### Files to CREATE

```
packages/core/src/dx/schema.ts            → NEW (schema, ref)
packages/core/src/dx/schema.test.ts       → NEW (unit tests)
```

### Files to MODIFY

| File | Changes |
|------|---------|
| `packages/core/src/dx/schema-bridge.ts` | Keep `buildModelFromSchema` but make INTERNAL |
| `packages/core/src/dx/orm.ts` | Use new schema API, remove `typedSchemaToModelIR` |
| `packages/core/src/dx/index.ts` | Export `schema`, `ref` only; remove old exports |
| `packages/cli/src/generators/schema-codegen.ts` | Generate `schema()` + `ref()` |
| `examples/*.schema.ts` | Rewrite all 6 files |
| `tests/**/*.test.ts` | Rewrite ~40 files |

## Implementation Blocks

### Block 1: Core API (packages/core)

**Files:** `schema.ts`, `schema.test.ts`
**Effort:** M (~2h)

- [ ] Implement `ref()` function with all options
- [ ] Implement `schema()` function with validation
- [ ] Implement `schemaToModelIR()` direct conversion
- [ ] Unit tests for all relation patterns (1:1, 1:N, self-ref, multi-FK)

### Block 2: Remove Legacy APIs (packages/core)

**Files:** Multiple deletions
**Effort:** S (~30min)

- [ ] Delete `schema-dsl.ts` and `schema-dsl-types.ts`
- [ ] Delete `prisma-types.ts` (TypedSchema, helpers)
- [ ] Remove `typedSchemaToModelIR` from `orm.ts`
- [ ] Update `index.ts` exports (only `schema`, `ref`)
- [ ] Verify no internal imports of deleted files

### Block 3: Update ORM Integration (packages/core)

**Files:** `orm.ts`, `types.ts`
**Effort:** M (~1h)

- [ ] Update `createOrm()` to accept new schema format
- [ ] Remove `OrmOptionsWithTypedSchema`
- [ ] Update type inference for new schema

### Block 4: CLI Codegen (packages/cli)

**Files:** `schema-codegen.ts`, `schema-codegen.test.ts`
**Effort:** M (~1h)

- [ ] Generate `import { schema, ref } from '@dbsp/core'`
- [ ] Generate `ref()` for FK columns with appropriate options
- [ ] Generate short form for simple columns
- [ ] Generate `roles` for self-referential tables
- [ ] Update codegen tests

### Block 5: Migrate Examples (examples/)

**Files:** 6 `.schema.ts` files
**Effort:** M (~1h)

- [ ] `blog.schema.ts` - 1:N, junction tables
- [ ] `blog-extended.schema.ts` - Complex
- [ ] `ecommerce.schema.ts` - Self-ref (categories)
- [ ] `minimal.schema.ts` - Simple
- [ ] `pimdam.schema.ts` - Complex hierarchy
- [ ] `scheduling.schema.ts` - Multi-FK

### Block 6: Migrate E2E Tests (tests/e2e/)

**Files:** ~7 test files
**Effort:** M (~1h)

- [ ] `ddl-introspect-roundtrip.test.ts`
- [ ] `advanced-queries.test.ts`
- [ ] `strategy-matrix.test.ts`
- [ ] `testkit/*.model.ts` files

### Block 7: Migrate Unit Tests

**Files:** ~30 test files
**Effort:** L (~3h)

- [ ] `packages/core/src/*.test.ts`
- [ ] `packages/adapter-kysely/src/*.test.ts`
- [ ] `packages/cli/src/**/*.test.ts`

### Block 8: json_agg Unification

**Files:** Adapter compiler
**Effort:** S (~30min)

- [ ] Remove hasOne vs hasMany strategy distinction for fetch
- [ ] Use json_agg for all relations
- [ ] Extract `[0]` in post-processing for hasOne
- [ ] Update relevant tests

## Test Strategy

### Type-Level Tests (tsd)

```typescript
// Verify inference works
const db = schema({
  users: { id: 'uuid', name: 'text' },
  posts: { id: 'uuid', authorId: ref('users') }
});

// Should infer:
// db.tables.users.columns.id.type === 'uuid'
// db.relations.posts.author exists
// db.relations.users.author_posts exists
```

### Unit Tests

- All relation patterns (1:1, 1:N, self-ref, multi-FK)
- Edge cases (custom naming, nullable FK)
- Validation errors (missing roles, ambiguous refs)

### E2E Tests

- DDL round-trip (schema → DDL → introspect → schema)
- Query execution with all relation types
- Recursive queries (ancestors/descendants)

## Success Criteria

1. **Minimal API**: Only `schema()` and `ref()` exported
2. **Zero legacy**: No `defineSchema`, `TypedSchema`, `GeneratedSchema`, `manyToMany`, `hasOne`, `hasMany`, `belongsTo` in public API
3. **All tests pass**: Unit, E2E, type tests
4. **Examples work**: All 6 examples migrated and functional
5. **CLI generates new syntax**: `dbsp introspect` produces `schema()` + `ref()` code
6. **Documentation updated**: CLAUDE.md, README, API docs

## Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Breaking change for external users | H | L | Project is pre-1.0, clean break acceptable |
| Missed file during migration | M | M | CI catches (tests fail) |
| Type inference regression | M | M | tsd tests, manual verification |
| Self-ref edge cases | M | L | Comprehensive tests, existing behavior preserved |

## Out of Scope

- Migration tooling (codemod) - manual migration acceptable
- Deprecation period - clean break, no warnings
- GeneratedSchema public API - becomes internal only
- Automatic M:N inference - explicitly rejected

## References

- [Orange ORM](https://github.com/alfateam/orange-orm) - Inspiration for fluent API
- [ARCH-002](ARCH-002-one-ring.md) - Current schema architecture
- [CORE-001](CORE-001-model-ir.md) - ModelIR specification
- LLM Review: Codex (gpt-5.2-codex), LM Studio (qwen3-coder-30b)

---

## Appendix: Current vs New Syntax Comparison

### Before (defineSchema)

```typescript
import { defineSchema } from '@dbsp/core';

export default defineSchema(
  {
    categories: {
      id: { type: 'integer', primaryKey: true, autoIncrement: true },
      name: { type: 'string', nullable: false },
      parentId: {
        type: 'integer',
        nullable: true,
        references: { table: 'categories', onDelete: 'SET NULL' },
        index: true
      },
    },
  },
  {
    relations: {
      'categories.parent': {
        kind: 'belongsTo',
        target: 'categories',
        foreignKey: 'parentId',
      },
      'categories.children': {
        kind: 'hasMany',
        target: 'categories',
        foreignKey: 'parentId',
      },
      'categories.ancestors': {
        kind: 'hasMany',
        target: 'categories',
        foreignKey: 'parentId',
        recursive: { direction: 'up', through: 'parent', maxDepth: 10 },
      },
      'categories.descendants': {
        kind: 'hasMany',
        target: 'categories',
        foreignKey: 'parentId',
        recursive: { direction: 'down', through: 'children', maxDepth: 10 },
      },
    },
  },
);
```

### After (schema + ref)

```typescript
import { schema, ref } from '@dbsp/core';

export default schema({
  categories: {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    name: 'string',
    parentId: ref('categories', {
      nullable: true,
      onDelete: 'SET NULL',
      roles: { parent: 'parent', children: 'children' },
    }),
  },
});
```

**Lines of code: 47 → 13 (72% reduction)**

---

## Appendix: API Exports

### Before

```typescript
// 10+ exports
export {
  defineSchema,
  TypedSchema,
  GeneratedSchema,
  hasOne,
  hasMany,
  belongsTo,
  manyToMany,
  buildModelFromSchema,
  buildModelFromResolvedSchema,
  typedSchemaToModelIR,
  // ...
};
```

### After

```typescript
// 2 exports
export { schema, ref };
```
