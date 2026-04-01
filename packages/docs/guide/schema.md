---
title: Schema Definition
---

# Schema Definition

Define your database schema using the `schema()` function with `ref()` for foreign key relations.

## Basic Schema

```typescript
import { schema, ref } from '@dbsp/core';

const db = schema({
  users: {
    id: 'uuid',
    name: 'string',
    email: 'string',
    active: 'boolean',
    createdAt: 'datetime',
  },
  posts: {
    id: 'uuid',
    title: 'string',
    content: 'string?',   // nullable
    authorId: ref('users'), // foreign key -> users.id
    published: 'boolean',
  },
});
```

## Column Types

| Type | PostgreSQL | Notes |
|------|------------|-------|
| `'string'` | `text` | |
| `'integer'` | `integer` | |
| `'uuid'` | `uuid` | |
| `'boolean'` | `boolean` | |
| `'datetime'` | `timestamptz` | |
| `'date'` | `date` | |
| `'json'` | `jsonb` | |
| `'float'` | `double precision` | |
| `'string?'` | `text` | Nullable (append `?`) |

## Relations

Use `ref()` to define foreign key relationships:

```typescript
authorId: ref('users'),        // -> users.id (auto-detected)
categoryId: ref('categories'), // -> categories.id
```

The planner uses these relations to auto-resolve `.include()` calls and choose optimal join strategies.
