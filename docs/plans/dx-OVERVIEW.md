---
doc-meta:
  status: draft
  scope: dx
  type: design
  created: 2026-01-06
  updated: 2026-01-06
---

# DX (Developer Experience) Scope Overview

## Purpose

The **dx** scope (`packages/dx`) enhances developer experience with safety features and familiar APIs:

1. **Ambiguity Handling** - Strict mode + override API for relation disambiguation
2. **Compatibility Layer** - Drizzle-like helpers for easier adoption

**Phase:** P1 (after MVP)

## Architecture Constraint

```
┌─────────────────────────────────────────────────────────────┐
│                        packages/dx                          │
│                                                             │
│  Imports from: packages/core, packages/adapter-kysely       │
│  This is a LEAF package (nothing depends on it)             │
│                                                             │
│  Provides: Strict mode, Override API, Compat helpers        │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Features

### Ambiguity Handling

#### Problem

When a model has multiple relations to the same target:

```typescript
// User has both 'createdPosts' and 'editedPosts' to Post
// Query: "include posts" - which relation?
```

#### Solution: Strict Mode (Q3 Golden Test)

```typescript
const orm = createOrm({
  kysely: db,
  model: schema,
  strictMode: true // Fail on ambiguous paths
});

// This MUST throw AmbiguousRelationError
await orm.query(User)
  .include('posts')  // Ambiguous!
  .findMany();

// Error message includes available options:
// "Ambiguous relation 'posts' on User. Available: ['createdPosts', 'editedPosts']"
```

#### Solution: Override API

```typescript
// Per-include override (disambiguate)
query.include('posts', { via: 'createdPosts' });

// Per-query default
query.withRelationHint('Post', 'createdPosts');

// Both work in strict mode
```

### Compatibility Layer

Drizzle-like helpers for familiar DX:

#### Filter Helpers

```typescript
import { eq, and, or, gt, lt, like, isNull, inArray } from 'db-semantic-planner/compat';

query.where(
  and(
    eq(User.status, 'active'),
    or(
      gt(User.age, 18),
      eq(User.role, 'admin')
    )
  )
);
```

#### Query Shortcuts

```typescript
// Instead of: query.execute().then(r => r[0])
const user = await User.findFirst({ where: eq(User.id, 1) });

// With error on not found
const user = await User.findFirstOrThrow({ where: eq(User.id, 1) });

// Multiple results
const users = await User.findMany({ where: eq(User.status, 'active') });
```

---

## Golden Query Test (Q3): Strict Mode Ambiguity

This test validates that strict mode correctly detects and reports ambiguous relations.

### Schema Setup

```typescript
const schema = defineSchema({
  users: {
    id: 'number',
    name: 'string',
  },
  posts: {
    id: 'number',
    title: 'string',
    createdById: 'number',
    editedById: 'number',
  },
})
.relations({
  users: {
    createdPosts: hasMany('posts', { foreignKey: 'createdById' }),
    editedPosts: hasMany('posts', { foreignKey: 'editedById' }),
  },
  posts: {
    creator: belongsTo('users', { foreignKey: 'createdById' }),
    editor: belongsTo('users', { foreignKey: 'editedById' }),
  },
});
```

### Test Case

```typescript
// Intent: Include "posts" without specifying which relation
const orm = createOrm({ kysely: db, model: schema, strictMode: true });

// This MUST throw
expect(() =>
  orm.query(User).include('posts').compile()
).toThrow(AmbiguousRelationError);

// Error must include options
try {
  orm.query(User).include('posts').compile();
} catch (e) {
  expect(e).toBeInstanceOf(AmbiguousRelationError);
  expect(e.options).toEqual(['createdPosts', 'editedPosts']);
  expect(e.message).toContain('createdPosts');
  expect(e.message).toContain('editedPosts');
}
```

### Expected Behavior

| Scenario | strictMode: true | strictMode: false |
|----------|------------------|-------------------|
| Ambiguous include | Throws `AmbiguousRelationError` | Uses first relation (warn) |
| With `via:` override | Works | Works |
| Unambiguous include | Works | Works |

---

## Non-Goals (P1)

- **No Prisma-like nested writes**: Focus on reads
- **No automatic relation inference**: Must be explicit
- **No runtime type validation**: TypeScript compile-time only

---

## Target Users

- Developers migrating from Drizzle/Prisma
- Teams wanting stricter type safety
- Projects with complex relation graphs

## Dependencies

- `packages/core` (schema, query AST, planner)
- `packages/adapter-kysely` (execution)

## Dependents

- None (leaf package)

## Implementation Specs

- DX-001-strict-mode.md (planned)
- DX-002-compat-layer.md (planned)
