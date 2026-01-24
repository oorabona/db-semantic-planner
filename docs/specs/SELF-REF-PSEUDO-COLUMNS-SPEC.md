# Spec: Self-Referential Pseudo-Columns

**Status:** Canonical (V1.0 implemented)
**Created:** 2026-01-24
**Updated:** 2026-01-24
**Implemented:** 2026-01-24 (V1.0: single-hop parent/child filtering)
**Reviewed:** 2026-01-24 (multi-LLM consensus: Codex, Gemini, LM Studio) — spec + NQL-EBNF v2.2
**Scope:** core, nql, adapter-kysely

## 1. Problem Statement

Currently, self-referential relations (e.g., category hierarchies) require explicit `relations` configuration in the schema:

```typescript
defineSchema(tables, {
  relations: {
    'categories.parent': { kind: 'belongsTo', target: 'categories', foreignKey: 'parentId' },
    'categories.children': { kind: 'hasMany', target: 'categories', foreignKey: 'parentId' },
  },
});
```

This is redundant — the FK definition already contains all necessary information.

## 2. Solution: Pseudo-Columns

Auto-generate **pseudo-columns** from self-referential FKs that enable intuitive traversal in NQL.

### 2.1 Single Self-Ref FK (Simple Case)

```typescript
defineSchema({
  categories: {
    id: { type: 'integer', primaryKey: true },
    name: { type: 'string' },
    parentId: { type: 'integer', nullable: true, references: { table: 'categories' } },
  },
});
```

The FK `parentId → categories.id` (same table) automatically generates 4 pseudo-columns:

| Pseudo-Column | Direction | Depth | Description |
|---------------|-----------|-------|-------------|
| `parent` | ↑ | 1 | Direct parent |
| `child` | ↓ | 1 | Direct children |
| `ascendant` | ↑ | N | All ancestors (recursive CTE) |
| `descendant` | ↓ | N | All descendants (recursive CTE) |

### 2.2 Custom Roles with `parentRole` / `childRole` (Optional for Single FK)

For **single self-ref FK**, `parentRole`/`childRole` are **optional**. Defaults:
- `parentRole` → `'parent'` (always, regardless of FK column name)
- `childRole` → `'child'` (always)

For semantic clarity, you can specify custom names:

```typescript
defineSchema({
  employees: {
    id: { type: 'integer', primaryKey: true },
    name: { type: 'string' },
    managerId: {
      type: 'integer',
      nullable: true,
      references: {
        table: 'employees',
        parentRole: 'manager',   // pseudo-column name for parent direction
        childRole: 'reports',    // pseudo-column name for child direction
      }
    },
  },
});
```

Generated pseudo-columns:

| Pseudo-Column | Direction | Equivalent |
|---------------|-----------|------------|
| `manager` | ↑ | `parent` |
| `reports` | ↓ | `child` |
| `ascendant` | ↑ | (unchanged) |
| `descendant` | ↓ | (unchanged) |

NQL usage:
```sql
employees | where manager.name = 'Alice'
employees | where reports.active = true
```

### 2.3 Multiple Self-Ref FKs (Mandatory Custom Names)

When a table has multiple self-referential FKs:
- `parentRole`/`childRole` are **required** (no defaults, no inference)
- `ascendant`/`descendant` are **scoped per role**: `manager.ascendant`, `mentor.ascendant`

```typescript
defineSchema({
  employees: {
    id: { type: 'integer', primaryKey: true },
    name: { type: 'string' },
    managerId: {
      type: 'integer',
      references: {
        table: 'employees',
        parentRole: 'manager',    // ✅ required
        childRole: 'directReports',
      }
    },
    mentorId: {
      type: 'integer',
      references: {
        table: 'employees',
        parentRole: 'mentor',     // ✅ required
        childRole: 'mentees',
      }
    },
  },
});
```

**Validation:** Schema throws error if multiple self-ref FKs exist without distinct `parentRole`/`childRole`.

NQL usage (no ambiguity):
```sql
employees | where manager.name = 'Alice'
employees | where mentor.name = 'Bob'
employees | where directReports.active = true
employees | where mentees.department = 'Engineering'

-- Recursive traversal is scoped per role
employees | where manager.ascendant.title = 'VP'      -- management chain
employees | where mentor.ascendant.name = 'Founder'   -- mentorship chain
```

## 3. NQL Syntax

### 3.1 Basic Traversal (1 Level)

```sql
-- Direct parent
categories | where parent.name = 'Electronics'

-- Direct children
categories | where child.active = true

-- With custom names
employees | where manager.name = 'Alice'
employees | where reports.department = 'Engineering'
```

### 3.2 Chained Traversal (Exact Depth)

```sql
-- Grand-parent (exactly 2 levels up)
categories | where parent.parent.name = 'Root'

-- Great-grand-parent (exactly 3 levels up)
categories | where parent.parent.parent.name = 'Root'

-- Grand-children (exactly 2 levels down)
categories | where child.child.active = true

-- With custom names
employees | where manager.manager.name = 'CEO'
```

### 3.3 Recursive Traversal (Bounded)

```sql
-- Any ancestor (unlimited depth)
categories | where ascendant.name = 'Root'

-- Ancestors up to 3 levels
categories | where ascendant[3].name = 'Root'

-- Any descendant (unlimited depth)
categories | where descendant.active = true

-- Descendants up to 5 levels
categories | where descendant[5].active = true
```

### 3.4 Escaping Column Name Conflicts

If a real column named `parent`, `child`, `ascendant`, or `descendant` exists:

```sql
-- Real column named "parent" (escaped with quotes)
categories | where "parent" = 'some value'

-- Pseudo-column parent (unquoted)
categories | where parent.name = 'Electronics'

-- Both in same query
categories | where "parent" = 'value' and parent.name = 'Electronics'
```

### 3.5 Difference: Chained vs Bounded

| Syntax | Meaning | Matches |
|--------|---------|---------|
| `parent.parent.name` | **Exactly** level 2 | Only grand-parent |
| `ascendant[2].name` | **Up to** level 2 | Parent OR grand-parent |
| `ascendant.name` | **Any** level | All ancestors |

## 4. Grammar

**See [NQL-EBNF.md](NQL-EBNF.md) Section 4** for the complete pseudo-table grammar (source of truth).

### 4.1 Key Constraints

**Direction enforcement:** Mixed direction chains like `parent.child.name` are **forbidden**.
Parser rejects at parse time or semantic validation rejects with clear error.

| Syntax | Valid | Reason |
|--------|-------|--------|
| `parent.parent.name` | ✅ | Same direction (up, up) |
| `child.child.name` | ✅ | Same direction (down, down) |
| `parent.child.name` | ❌ | Mixed (up, down) — undefined semantics |
| `manager.ascendant.title` | ✅ | Scoped recursive (multi-FK) |

### 4.2 Keyword Resolution

1. Check if identifier is quoted (`"parent"`) → real column
2. Check if identifier matches pseudo-column name from schema → pseudo-column
3. Otherwise → real column

## 5. SQL Generation (Set-Based CTE)

**Key Decision:** Use **inverted set-based CTE** strategy — find target nodes first, then recurse to find related rows.

**Why:** The naive approach (`WHERE id = :current_id` per row) doesn't work for set-based queries. We must:
1. Find nodes matching the condition (e.g., `name = 'Root'`)
2. Recurse from those nodes to find all related rows
3. Filter main query using the result set

### 5.1 Template: Ascendant Query (Find rows whose ancestor matches)

```sql
-- NQL: categories | where ascendant.name = 'Root'
-- Meaning: Find all categories that have 'Root' as an ancestor

WITH RECURSIVE descendants_of_target AS (
  -- Base case: find the target node(s)
  SELECT id, parent_id, 0 AS __depth, ARRAY[id] AS __visited
  FROM categories
  WHERE name = 'Root'                    -- the condition from NQL

  UNION ALL

  -- Recurse DOWN to find all descendants of 'Root'
  SELECT c.id, c.parent_id, d.__depth + 1, d.__visited || c.id
  FROM categories c
  JOIN descendants_of_target d ON c.parent_id = d.id
  WHERE c.id <> ALL(d.__visited)         -- cycle detection
    AND d.__depth < :maxDepth            -- default 100
)
SELECT * FROM categories
WHERE id IN (SELECT id FROM descendants_of_target WHERE __depth > 0);
```

### 5.2 Template: Descendant Query (Find rows whose descendant matches)

```sql
-- NQL: categories | where descendant.name = 'Phones'
-- Meaning: Find all categories that have 'Phones' as a descendant

WITH RECURSIVE ancestors_of_target AS (
  -- Base case: find the target node(s)
  SELECT id, parent_id, 0 AS __depth, ARRAY[id] AS __visited
  FROM categories
  WHERE name = 'Phones'                  -- the condition from NQL

  UNION ALL

  -- Recurse UP to find all ancestors of 'Phones'
  SELECT c.id, c.parent_id, a.__depth + 1, a.__visited || c.id
  FROM categories c
  JOIN ancestors_of_target a ON c.id = a.parent_id
  WHERE c.id <> ALL(a.__visited)         -- cycle detection
    AND a.__depth < :maxDepth
)
SELECT * FROM categories
WHERE id IN (SELECT id FROM ancestors_of_target WHERE __depth > 0);
```

### 5.3 Template: Exact Depth (Chained Traversal)

```sql
-- NQL: categories | where parent.parent.name = 'Root'
-- Meaning: Find categories whose grand-parent is named 'Root'

WITH RECURSIVE ancestors AS (
  -- Start from all categories (we'll filter by depth)
  SELECT id, parent_id, 0 AS __depth, ARRAY[id] AS __visited
  FROM categories

  UNION ALL

  -- Recurse UP
  SELECT c.id, c.parent_id, a.__depth + 1, a.__visited || a.id
  FROM ancestors a
  JOIN categories c ON a.parent_id = c.id
  WHERE c.id <> ALL(a.__visited)
    AND a.__depth < 2                    -- chain length
)
SELECT DISTINCT cat.*
FROM categories cat
JOIN ancestors a ON a.id = cat.id
WHERE a.__depth = 2                      -- exactly depth 2
  AND EXISTS (
    SELECT 1 FROM categories target
    WHERE target.id = a.parent_id        -- the ancestor at depth 2
      AND target.name = 'Root'
  );
```

### 5.4 Cycle Detection (Mandatory)

All recursive CTEs **must** include cycle detection:

```sql
-- Using PostgreSQL ARRAY for visited tracking
ARRAY[id] AS __visited                   -- in base case
c.id <> ALL(d.__visited)                 -- in recursive term
d.__visited || c.id                      -- append to path
```

This prevents infinite loops when data contains cycles (A → B → A).

### 5.5 Depth Limits

| Syntax | Max Depth | Filter |
|--------|-----------|--------|
| `parent.name` | 1 | `__depth = 1` |
| `parent.parent.name` | 2 | `__depth = 2` |
| `ascendant.name` | `recursiveMaxDepth` (default 100) | `__depth > 0` |
| `ascendant[3].name` | 3 | `__depth > 0 AND __depth <= 3` |

### 5.6 Using Schema Column Names

SQL templates use the actual column names from the schema:
- `parent_id` comes from the FK column definition
- `id` comes from `references.column` or PK detection

```typescript
// Schema defines:
parentId: { references: { table: 'categories', column: 'id' } }
// SQL uses: c.parent_id = d.id (with camelCase→snake_case transform)
```

## 6. Schema API Changes

### 6.1 Extended `references` Type

```typescript
interface ColumnReference {
  table: string;
  column?: string;         // default: 'id'
  onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT';

  // NEW: Custom pseudo-column names for self-ref
  // For SINGLE self-ref FK: optional, defaults to 'parent'/'child'
  // For MULTIPLE self-ref FKs: REQUIRED, no defaults
  parentRole?: string;
  childRole?: string;
}
```

**Defaults (single self-ref FK only):**
- `parentRole` → `'parent'` (simple, predictable)
- `childRole` → `'child'` (simple, predictable)

**No defaults for multi self-ref FK** — explicit names required.

### 6.2 Validation Rules

```typescript
const RESERVED_PSEUDO_NAMES = ['parent', 'child', 'ascendant', 'descendant'];

function validateSelfRefFKs(tableName: string, table: TableDef): void {
  const selfRefFKs = Object.entries(table)
    .filter(([_, col]) => col.references?.table === tableName);

  if (selfRefFKs.length === 0) return;

  if (selfRefFKs.length > 1) {
    // Multiple self-ref FKs: parentRole/childRole REQUIRED
    for (const [colName, col] of selfRefFKs) {
      if (!col.references.parentRole || !col.references.childRole) {
        throw new SchemaValidationError(
          `Column '${colName}' is one of multiple self-referential FKs. ` +
          `'parentRole' and 'childRole' are required to avoid ambiguity.`
        );
      }
    }
  }

  // Collect all role names (explicit or defaults)
  const parentRoles = selfRefFKs.map(([_, c]) =>
    c.references.parentRole ?? 'parent'
  );
  const childRoles = selfRefFKs.map(([_, c]) =>
    c.references.childRole ?? 'child'
  );
  const allRoles = [...parentRoles, ...childRoles];

  // Check for duplicates within each set
  if (new Set(parentRoles).size !== parentRoles.length) {
    throw new SchemaValidationError('Duplicate parentRole in self-ref FKs');
  }
  if (new Set(childRoles).size !== childRoles.length) {
    throw new SchemaValidationError('Duplicate childRole in self-ref FKs');
  }

  // Check for cross-collision (parentRole = childRole)
  const crossCollision = parentRoles.find(p => childRoles.includes(p));
  if (crossCollision) {
    throw new SchemaValidationError(
      `Role name '${crossCollision}' used as both parentRole and childRole`
    );
  }

  // Check collision with reserved names (only for custom roles, not defaults)
  for (const [_, col] of selfRefFKs) {
    const { parentRole, childRole } = col.references;
    if (parentRole && RESERVED_PSEUDO_NAMES.includes(parentRole) && parentRole !== 'parent') {
      throw new SchemaValidationError(
        `parentRole '${parentRole}' conflicts with reserved pseudo-column name`
      );
    }
    if (childRole && RESERVED_PSEUDO_NAMES.includes(childRole) && childRole !== 'child') {
      throw new SchemaValidationError(
        `childRole '${childRole}' conflicts with reserved pseudo-column name`
      );
    }
  }

  // Check collision with real column names
  const realColumns = Object.keys(table);
  for (const role of allRoles) {
    if (realColumns.includes(role)) {
      throw new SchemaValidationError(
        `Role name '${role}' conflicts with existing column in table '${tableName}'`
      );
    }
  }
}
```

### 6.3 ORM Configuration: Default maxDepth

```typescript
const orm = createOrm({
  model: schema,
  adapter: createKyselyAdapter(db),
  options: {
    recursiveMaxDepth: 100,  // default for ascendant/descendant without [N]
  },
});
```

**Note:** 100 is a safe default that prevents runaway recursion while supporting deep hierarchies.
Cycle detection (§5.4) prevents infinite loops regardless of this limit.

## 7. Implementation Phases

### Phase 1: Schema Detection & Validation
- [ ] Add `parentRole`/`childRole` to `ColumnReference` type in `schema-dsl-types.ts`
- [ ] Implement self-ref FK detection in `conventions.ts`
- [ ] Add comprehensive validation (§6.2): multi-FK required roles, cross-collision, reserved names
- [ ] Generate pseudo-column metadata from schema
- [ ] Remove/refactor `getSelfRefInverseName` to use new defaults

### Phase 2: NQL Parser
- [ ] Add pseudo-column tokens: `parent`, `child`, `ascendant`, `descendant`
- [ ] Support upward chain: `parent.parent.name` (same direction only)
- [ ] Support downward chain: `child.child.name` (same direction only)
- [ ] Support bounded traversal: `ascendant[N]` with N ≥ 1 validation
- [ ] Support scoped traversal: `role.ascendant` for multi-FK
- [ ] Handle escaping: `"parent"` for real columns
- [ ] **Reject mixed direction chains** at parse/validation time

### Phase 3: SQL Compiler (adapter-kysely)
- [ ] Implement **set-based CTE** strategy (inverted approach, §5.1-5.3)
- [ ] Add **cycle detection** using `ARRAY[id]` visited tracking (§5.4)
- [ ] Direction parameter (up/down based on FK column)
- [ ] Depth parameter (exact for chained, bounded for `ascendant[N]`)
- [ ] Use schema column names (not hardcoded `id`/`parentId`)
- [ ] Handle custom `parentRole`/`childRole` and scoped traversal

### Phase 4: ORM Integration
- [ ] Add `recursiveMaxDepth` option (default: 100)
- [ ] Wire pseudo-columns to query builder intent system
- [ ] Ensure type inference recognizes pseudo-column paths

### Phase 5: Testing & Documentation
- [ ] Unit tests: validation rules, all error cases
- [ ] Integration tests: single FK, multi-FK, cycle detection
- [ ] E2E tests: real PostgreSQL queries with hierarchical data
- [ ] Update QUICKSTART.md with examples
- [ ] Remove explicit `relations` from example schemas

## 8. Examples

### 8.1 Category Hierarchy (Simple)

```typescript
// Schema
defineSchema({
  categories: {
    id: { type: 'integer', primaryKey: true },
    name: { type: 'string' },
    parentId: { type: 'integer', nullable: true, references: { table: 'categories' } },
    active: { type: 'boolean', default: 'true' },
  },
});

// NQL
categories | where parent.name = 'Electronics'           // direct parent
categories | where child.active = true                   // direct children
categories | where parent.parent.name = 'Root'           // grand-parent
categories | where ascendant.name = 'Root'               // any ancestor
categories | where descendant[3].active = false          // descendants up to 3 levels
```

### 8.2 Employee Hierarchy (Custom Names)

```typescript
// Schema
defineSchema({
  employees: {
    id: { type: 'integer', primaryKey: true },
    name: { type: 'string' },
    title: { type: 'string' },
    managerId: {
      type: 'integer',
      nullable: true,
      references: {
        table: 'employees',
        parentRole: 'manager',
        childRole: 'directReports',
      },
    },
  },
});

// NQL
employees | where manager.name = 'Alice'                 // direct manager
employees | where directReports.title = 'Engineer'       // direct reports
employees | where manager.manager.name = 'CEO'           // skip-level manager
employees | where ascendant.title = 'VP'                 // any manager above who is VP
```

### 8.3 Dual Hierarchy (Multi Self-Ref)

```typescript
// Schema
defineSchema({
  employees: {
    id: { type: 'integer', primaryKey: true },
    name: { type: 'string' },
    managerId: {
      type: 'integer',
      references: {
        table: 'employees',
        parentRole: 'manager',      // required
        childRole: 'directReports', // required
      },
    },
    mentorId: {
      type: 'integer',
      references: {
        table: 'employees',
        parentRole: 'mentor',       // required (distinct)
        childRole: 'mentees',       // required (distinct)
      },
    },
  },
});

// NQL - no ambiguity due to distinct names
employees | where manager.name = 'Alice'
employees | where mentor.name = 'Bob'
employees | where directReports.active = true
employees | where mentees.department = 'Engineering'

// Scoped recursive traversal
employees | where manager.ascendant.title = 'CEO'
employees | where mentor.descendant.active = false
```

## 9. Migration Guide

### Before (Explicit Relations)

```typescript
defineSchema(
  {
    categories: {
      id: { type: 'integer', primaryKey: true },
      name: { type: 'string' },
      parentId: { type: 'integer', references: { table: 'categories' } },
    },
  },
  {
    relations: {
      'categories.parent': { kind: 'belongsTo', target: 'categories', foreignKey: 'parentId' },
      'categories.children': { kind: 'hasMany', target: 'categories', foreignKey: 'parentId' },
    },
  }
);
```

### After (Auto-Generated)

```typescript
defineSchema({
  categories: {
    id: { type: 'integer', primaryKey: true },
    name: { type: 'string' },
    parentId: { type: 'integer', references: { table: 'categories' } },
  },
});
// Pseudo-columns auto-generated: parent, child, ascendant, descendant
```

**Breaking Change:** None. Explicit `relations` still supported but no longer required for self-ref.

## 10. Summary

| Feature | Syntax | SQL Strategy |
|---------|--------|--------------|
| Direct parent | `parent.name` | Set-based CTE, depth=1 |
| Direct child | `child.name` | Set-based CTE, depth=1 |
| Exact ancestor level | `parent.parent.name` | Set-based CTE, exact depth |
| Any ancestor | `ascendant.name` | Set-based CTE + cycle detection |
| Bounded ancestor | `ascendant[3].name` | Set-based CTE, max depth=3 |
| Any descendant | `descendant.name` | Set-based CTE + cycle detection |
| Bounded descendant | `descendant[5].name` | Set-based CTE, max depth=5 |
| Custom names | `manager.name` | via `parentRole` config |
| Scoped recursive | `manager.ascendant.name` | Multi-FK: role-scoped CTE |
| Escape real column | `"parent"` | direct column reference |

## 11. Out of Scope (V1)

The following features are explicitly **not supported** in V1:

### 11.1 Composite Primary Keys

Self-referential FKs with composite keys are not supported:

```typescript
// ❌ NOT SUPPORTED in V1
defineSchema({
  tenant_users: {
    tenantId: { type: 'integer', primaryKey: true },
    userId: { type: 'integer', primaryKey: true },
    name: { type: 'string' },
    // Composite FK to same table
    parentTenantId: { type: 'integer' },
    parentUserId: { type: 'integer' },
    // references: { table: 'tenant_users', columns: ['tenantId', 'userId'] }
  },
});
```

**Rationale:** Composite FKs require tuple-based CTE joins `(col1, col2) = (p_col1, p_col2)`, significantly increasing SQL complexity.

### 11.2 Aggregations on Pseudo-Columns

Aggregate functions on pseudo-column traversals are not supported:

```sql
-- ❌ NOT SUPPORTED in V1
employees | where directReports.count > 5
categories | where descendant.sum(price) > 1000
```

**Rationale:** Aggregations require `LEFT JOIN` + `GROUP BY` instead of `EXISTS`, a fundamentally different SQL generation path.

**Workaround:** Use explicit subqueries or CTEs in raw SQL.

### 11.3 Projection of Pseudo-Columns

Using pseudo-columns in `select` to hydrate tree data is not supported:

```sql
-- ❌ NOT SUPPORTED in V1
employees | select id, name, manager.name as managerName
categories | select *, ascendant as ancestors
```

**Rationale:** Tree hydration requires recursive data fetching and nested result construction.

**Workaround:** Use multiple queries or dedicated tree-fetching functions.

### 11.4 Self-Reference via `id = id` Pattern

Some legacy schemas use `parentId = id` (self-pointing) instead of `NULL` for root nodes:

```sql
-- Root node where parentId points to itself
INSERT INTO categories (id, name, parentId) VALUES (1, 'Root', 1);
```

**Handled by:** Cycle detection (§5.4) prevents infinite recursion, but this pattern is discouraged.

## 12. Review Notes

This spec was reviewed by multi-LLM consensus (2025-01-24):
- **Codex (GPT-5.2)**: Identified SQL correlation issue, grammar ambiguity
- **Gemini**: Identified aggregation gap, performance tradeoffs
- **LM Studio**: Validated design completeness

Key fixes applied:
- ✅ Set-based CTE strategy (inverted approach)
- ✅ Mandatory cycle detection
- ✅ Single-direction chain enforcement
- ✅ Scoped `ascendant`/`descendant` for multi-FK
- ✅ Comprehensive validation rules
- ✅ Bounded traversal N ≥ 1 constraint
