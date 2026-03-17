---
doc-meta:
  status: canonical
  scope: core + adapter-pgsql
  type: specification
  created: 2026-02-26
  origin: astix migration (docs/plans/migrate-raw-sql-to-dbsp.md)
---

# DX-050: `dbType` Escape Hatch for Schema DSL

## Problem Statement

The schema DSL (`schema()` function) has no way to specify a custom database column type.
`ColumnIR.originalDbType` exists and is consumed by `mapColumnType()` for DDL generation,
but it can only be populated via database introspection — not from the DSL.

This means users defining schemas in code cannot express:
- `vector(768)` (pgvector)
- `real` / `float4` (vs `NUMERIC` from `decimal`)
- `citext`, `ltree`, `hstore`, or any extension-provided type
- Precision/scale overrides like `numeric(10,2)` (vs bare `NUMERIC`)

Additionally, `compareSchemata()` only compares `.type` (the abstract `ColumnType`),
silently ignoring `originalDbType`. This means schema-diff cannot detect:
- `vector(768)` → `vector(1024)` dimension changes
- `numeric(10,2)` → `numeric(12,4)` precision changes
- `varchar(255)` → `varchar(100)` length changes

## Motivation: astix as first production consumer

astix (AST-based code intelligence MCP server) is dbsp's first production project.
Its schema requires 2 columns that cannot be expressed via the current DSL:

| Table | Column | Actual PG Type | Without `dbType` | With `dbType` |
|-------|--------|---------------|-------------------|---------------|
| `embeddings` | `vector` | `vector(768)` | ERROR (no mapping) | `{ type: 'text', dbType: 'vector(768)' }` → DDL: `VECTOR(768)` |
| `calls` | `confidence` | `REAL` | `NUMERIC` (wrong semantics) | `{ type: 'decimal', dbType: 'real' }` → DDL: `REAL` |

Without this fix, astix must use supplementary `ALTER TABLE` DDL to override column types
after `generateDDL()` — defeating the purpose of a single schema source of truth.

## Solution

4 touch points across 2 packages. No breaking changes.

### Touch point 1: `ColumnDef` type — `packages/core/src/dx/schema.ts`

Add `dbType?: string` to the long-form column definition.

**Current** (L51-61):
```typescript
export type ColumnDef =
  | SchemaColumnType
  | {
      type: SchemaColumnType;
      nullable?: boolean;
      unique?: boolean;
      primaryKey?: boolean;
      autoIncrement?: boolean;
      default?: unknown;
      index?: boolean;
    };
```

**After:**
```typescript
export type ColumnDef =
  | SchemaColumnType
  | {
      type: SchemaColumnType;
      dbType?: string;           // Override actual database column type
      nullable?: boolean;
      unique?: boolean;
      primaryKey?: boolean;
      autoIncrement?: boolean;
      default?: unknown;
      index?: boolean;
    };
```

### Touch point 2: `normalizeColumnDef()` — `packages/core/src/dx/schema.ts`

Add `dbType?` to the return type signature.

**Current** (L992-1005):
```typescript
function normalizeColumnDef(def: ColumnDef): {
  type: SchemaColumnType;
  nullable?: boolean;
  unique?: boolean;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  default?: unknown;
  index?: boolean;
}
```

**After:**
```typescript
function normalizeColumnDef(def: ColumnDef): {
  type: SchemaColumnType;
  dbType?: string;
  nullable?: boolean;
  unique?: boolean;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  default?: unknown;
  index?: boolean;
}
```

No body changes needed — `return def` already passes through all properties.

### Touch point 3: `buildTables()` — `packages/core/src/dx/schema.ts`

Propagate `dbType` → `originalDbType` when building `ColumnIR`.

**Current** (L862-877, regular column path):
```typescript
const def = normalizeColumnDef(columnDef);
const col: Mutable<ColumnIR> = {
  name: columnName,
  type: def.type,
  nullable: def.nullable ?? false,
};
if (def.unique) { col.unique = def.unique; }
if (def.autoIncrement) { col.autoIncrement = def.autoIncrement; }
if (def.default !== undefined) { col.default = def.default; }
```

**After:**
```typescript
const def = normalizeColumnDef(columnDef);
const col: Mutable<ColumnIR> = {
  name: columnName,
  type: def.type,
  nullable: def.nullable ?? false,
};
if (def.dbType) { col.originalDbType = def.dbType; }
if (def.unique) { col.unique = def.unique; }
if (def.autoIncrement) { col.autoIncrement = def.autoIncrement; }
if (def.default !== undefined) { col.default = def.default; }
```

### Touch point 4 (CRITICAL): `compareColumnDetails()` — `packages/adapter-pgsql/src/ddl/schema-diff.ts`

Fix schema-diff to compare `originalDbType` when available, falling back to base `type`.

**Current** (L175-218):
```typescript
function compareColumnDetails(tableName, schema, db, changes) {
  if (schema.type !== db.type) {
    changes.push({
      kind: 'alter_column_type',
      table: tableName,
      column: schema.name,
      destructive: true,
      details: `Change type of "${schema.name}" from ${db.type} to ${schema.type}`,
      meta: { fromType: db.type, toType: schema.type, column: schema },
    });
  }
  // ... nullable, default comparison ...
}
```

**After:**
```typescript
function compareColumnDetails(tableName, schema, db, changes) {
  const schemaDbType = schema.originalDbType?.toLowerCase();
  const dbDbType = db.originalDbType?.toLowerCase();

  if (schemaDbType && dbDbType && schemaDbType !== dbDbType) {
    // Both have originalDbType and they differ → precision/type change
    changes.push({
      kind: 'alter_column_type',
      table: tableName,
      column: schema.name,
      destructive: true,
      details: `Change type of "${schema.name}" from ${db.originalDbType} to ${schema.originalDbType}`,
      meta: { fromType: db.originalDbType, toType: schema.originalDbType, column: schema },
    });
  } else if (schema.type !== db.type) {
    // Fall back to base type comparison
    changes.push({
      kind: 'alter_column_type',
      table: tableName,
      column: schema.name,
      destructive: true,
      details: `Change type of "${schema.name}" from ${db.type} to ${schema.type}`,
      meta: { fromType: db.type, toType: schema.type, column: schema },
    });
  }
  // ... nullable, default comparison ...
}
```

**Why this matters:** Without it, `compareSchemata()` silently ignores:
- `vector(768)` → `vector(1024)` dimension changes
- `numeric(10,2)` → `numeric(12,4)` precision changes
- `varchar(255)` → `varchar(100)` length changes
- `real` → `double precision` type variant changes

### What already works (no changes needed)

**`mapColumnType()`** in `packages/adapter-pgsql/src/ddl/type-mapping.ts` (L21-24):
```typescript
export function mapColumnType(col: ColumnIR): string {
  if (col.originalDbType) {
    return col.originalDbType.toUpperCase();
  }
  // ... standard mapping fallback ...
}
```

Already consumes `originalDbType` and uses it for DDL generation.

**`ColumnIR.originalDbType`** in `packages/types/src/model-ir.ts` (L186):
```typescript
readonly originalDbType?: string;
```

Already defined. Currently only populated by introspection — this spec enables population from the DSL too.

## Tests

### Schema DSL tests — `packages/core/src/dx/schema.spec.ts`

```typescript
describe('dbType escape hatch', () => {
  it('propagates dbType to originalDbType in ColumnIR', () => {
    const db = schema({
      embeddings: {
        id: { type: 'integer', autoIncrement: true, primaryKey: true },
        vector: { type: 'text', dbType: 'vector(768)' },
      },
    });
    const vectorCol = db.model.tables
      .find(t => t.name === 'embeddings')!
      .columns.find(c => c.name === 'vector')!;
    expect(vectorCol.originalDbType).toBe('vector(768)');
    expect(vectorCol.type).toBe('text');
  });

  it('does not set originalDbType when dbType is absent', () => {
    const db = schema({
      users: {
        id: { type: 'integer', autoIncrement: true, primaryKey: true },
        name: 'text',
      },
    });
    const nameCol = db.model.tables
      .find(t => t.name === 'users')!
      .columns.find(c => c.name === 'name')!;
    expect(vectorCol.originalDbType).toBeUndefined();
  });
});
```

### DDL generation tests — `packages/adapter-pgsql/src/ddl/ddl-generator.spec.ts`

```typescript
describe('dbType DDL override', () => {
  it('generates correct DDL with dbType override', () => {
    const db = schema({
      measurements: {
        id: { type: 'integer', autoIncrement: true, primaryKey: true },
        value: { type: 'decimal', dbType: 'real' },
      },
    });
    const ddl = generateDDL(db.model);
    const joined = ddl.join('\n');
    expect(joined).toContain('REAL');
    expect(joined).not.toContain('NUMERIC');
  });

  it('generates vector type via dbType', () => {
    const db = schema({
      embeddings: {
        id: { type: 'integer', autoIncrement: true, primaryKey: true },
        vector: { type: 'text', dbType: 'vector(768)' },
      },
    });
    const ddl = generateDDL(db.model);
    expect(ddl.join('\n')).toContain('VECTOR(768)');
  });
});
```

### Schema-diff tests — `packages/adapter-pgsql/src/ddl/schema-diff.spec.ts`

```typescript
describe('originalDbType comparison', () => {
  it('detects vector dimension change via originalDbType', () => {
    const before = makeModel({
      embeddings: {
        vector: { type: 'text', originalDbType: 'vector(768)' },
      },
    });
    const after = makeModel({
      embeddings: {
        vector: { type: 'text', originalDbType: 'vector(1024)' },
      },
    });
    const diff = compareSchemata(after, before);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].kind).toBe('alter_column_type');
    expect(diff.changes[0].meta.fromType).toBe('vector(768)');
    expect(diff.changes[0].meta.toType).toBe('vector(1024)');
  });

  it('detects precision change via originalDbType', () => {
    const before = makeModel({
      prices: {
        amount: { type: 'decimal', originalDbType: 'numeric(10,2)' },
      },
    });
    const after = makeModel({
      prices: {
        amount: { type: 'decimal', originalDbType: 'numeric(12,4)' },
      },
    });
    const diff = compareSchemata(after, before);
    expect(diff.changes).toHaveLength(1);
  });

  it('ignores matching originalDbType', () => {
    const before = makeModel({
      embeddings: {
        vector: { type: 'text', originalDbType: 'vector(768)' },
      },
    });
    const after = makeModel({
      embeddings: {
        vector: { type: 'text', originalDbType: 'vector(768)' },
      },
    });
    const diff = compareSchemata(after, before);
    expect(diff.changes).toHaveLength(0);
  });

  it('falls back to base type when no originalDbType', () => {
    const before = makeModel({
      users: { name: { type: 'string' } },
    });
    const after = makeModel({
      users: { name: { type: 'text' } },
    });
    const diff = compareSchemata(after, before);
    expect(diff.changes).toHaveLength(1);
  });

  it('does not detect change when only schema has originalDbType', () => {
    // Schema defines dbType but DB was created without it — base types match
    const before = makeModel({
      calls: { confidence: { type: 'decimal' } },
    });
    const after = makeModel({
      calls: { confidence: { type: 'decimal', originalDbType: 'real' } },
    });
    const diff = compareSchemata(after, before);
    // No originalDbType on DB side → skip originalDbType comparison, fall back to base type
    // Both are 'decimal' → no change detected
    // Note: this is expected — the initial CREATE TABLE will use the correct type via DDL.
    // Diff only matters for existing DBs where introspection populates originalDbType.
    expect(diff.changes).toHaveLength(0);
  });
});
```

### DOWN SQL tests — `packages/adapter-pgsql/src/ddl/migration-sql.spec.ts`

```typescript
describe('originalDbType in DOWN SQL', () => {
  it('uses originalDbType in ALTER COLUMN TYPE rollback', () => {
    const diff = {
      changes: [{
        kind: 'alter_column_type',
        table: 'embeddings',
        column: 'vector',
        destructive: true,
        details: 'Change vector from vector(768) to vector(1024)',
        meta: {
          fromType: 'vector(768)',
          toType: 'vector(1024)',
          column: { name: 'vector', type: 'text', originalDbType: 'vector(1024)' },
        },
      }],
      hasDestructive: true,
    };
    const downSQL = generateDownSQL(diff);
    expect(downSQL).toContain('vector(768)');
  });
});
```

## Edge cases

| Scenario | Expected behavior |
|----------|-------------------|
| `dbType` on short-form column (`'text'`) | Not applicable — short form has no object properties. Use long form. |
| `dbType` on FK column (`ref(...)`) | Not applicable — FK type is derived from target PK. `dbType` is for regular columns only. |
| `dbType` with `autoIncrement: true` | `mapColumnType()` checks `originalDbType` before `autoIncrement`. `dbType` wins. |
| `dbType: undefined` (explicit) | Same as absent — no `originalDbType` set. |
| `dbType: ''` (empty string) | Truthy check fails → no `originalDbType` set. Consider adding validation. |
| Both sides have `originalDbType` but one is uppercased | Comparison uses `.toLowerCase()` — case-insensitive. |
| Schema has `originalDbType`, DB doesn't | Falls back to base type comparison (`.type !== .type`). |

## Effort estimate

| Task | Package | Effort |
|------|---------|--------|
| Touch points 1-3 (ColumnDef, normalize, buildTables) | `@dbsp/core` | 45 min |
| Touch point 4 (compareColumnDetails) | `@dbsp/adapter-pgsql` | 45 min |
| Schema DSL tests | `@dbsp/core` | 30 min |
| DDL generation tests | `@dbsp/adapter-pgsql` | 20 min |
| Schema-diff tests | `@dbsp/adapter-pgsql` | 30 min |
| DOWN SQL test | `@dbsp/adapter-pgsql` | 10 min |
| **Total** | | **~3h** |

## Acceptance criteria

- [ ] `schema({ t: { col: { type: 'text', dbType: 'vector(768)' } } })` produces `ColumnIR` with `originalDbType === 'vector(768)'`
- [ ] `generateDDL()` outputs `VECTOR(768)` for columns with `dbType: 'vector(768)'`
- [ ] `generateDDL()` outputs `REAL` for columns with `dbType: 'real'`
- [ ] `compareSchemata()` detects `vector(768)` → `vector(1024)` changes
- [ ] `compareSchemata()` detects `numeric(10,2)` → `numeric(12,4)` changes
- [ ] `compareSchemata()` ignores identical `originalDbType` values
- [ ] `compareSchemata()` falls back to base type comparison when `originalDbType` is absent
- [ ] `generateDownSQL()` uses `originalDbType` in ALTER COLUMN TYPE rollback
- [ ] All existing tests continue to pass (no breaking changes)
