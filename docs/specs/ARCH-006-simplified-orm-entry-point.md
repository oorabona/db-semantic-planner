# ARCH-006: Simplified ORM Entry Point

**Status:** Canonical
**Created:** 2026-01-26
**Scope:** core, adapter-pgsql
**Breaking:** Yes
**Effort:** L (~8h)
**Dependencies:** ARCH-005 (Unified Schema API)

## Summary

Simplify the `createOrm` API by:
1. Removing legacy overloads (TypedSchema, async introspection)
2. Making `createOrm()` always synchronous with a `Schema<T>` input
3. Extracting introspection to a dedicated `getSchemaFromDb()` function
4. Having the adapter expose its `namingConvention` as single source of truth

## Motivation

### Current Problems

1. **4 overloads** - confusing API, hard to document:
   ```typescript
   createOrm<DB>(options: OrmOptionsWithModel<DB>): OrmInstance<DB>
   createOrm<S>(options: OrmOptionsWithTypedSchema<S>): TypedOrmInstance<S>
   createOrm<T>(options: OrmOptionsWithUnifiedSchema<T>): OrmInstance<...>
   createOrm<DB>(options: OrmOptionsWithAdapter<DB>): Promise<OrmInstance<DB>>
   ```

2. **TypedSchema coexists with schema()** - redundant after ARCH-005

3. **Sync vs Async return type** - `Promise<OrmInstance>` for introspection-only case

4. **Separate naming config** - `introspectionOptions.relationNaming` can conflict with Kysely's CamelCasePlugin

5. **Two return types** - `OrmInstance<DB>` vs `TypedOrmInstance<S>`

### Goals

- Single `createOrm({ schema })` entry point (always sync)
- Separate `getSchemaFromDb(adapter, options)` for introspection
- Adapter as single source of truth for naming convention
- Remove TypedSchema and related code

## Design

### New API Surface

```typescript
// ═══════════════════════════════════════════════════════════════
// CORE: packages/core/src/dx/
// ═══════════════════════════════════════════════════════════════

// Schema creation (ARCH-005 - unchanged)
const mySchema = schema({
  users: {
    id: 'uuid',
    name: 'string',
    createdAt: 'datetime',
  },
  posts: {
    id: 'uuid',
    title: 'string',
    authorId: ref('users', { inverse: 'posts' }),
  },
});

// ORM creation - ALWAYS sync, ALWAYS requires schema
const orm = createOrm({ schema: mySchema });                    // compile-only
const orm = createOrm({ schema: mySchema, adapter });           // full ORM
const orm = createOrm({ schema: mySchema, adapter, strictMode: true });

// ═══════════════════════════════════════════════════════════════
// ADAPTER: packages/adapter-kysely/src/
// ═══════════════════════════════════════════════════════════════

// Adapter creation - exposes namingConvention
const adapter = createKyselyAdapter(db);                        // auto-detect
const adapter = createKyselyAdapter(db, {
  namingConvention: 'camelCase',  // explicit override
  schema: 'tenant_123',
});

// Introspection - returns Schema<T>, respects adapter.namingConvention
const schema = await getSchemaFromDb(adapter, {
  schema: 'public',               // DB schema to introspect
  tables: ['users', 'posts'],     // whitelist (optional)
  exclude: ['_migrations'],       // blacklist patterns (optional)
});

// Full flow: introspect → createOrm
const schema = await getSchemaFromDb(adapter);
const orm = createOrm({ schema, adapter });
```

### Type Definitions

```typescript
// ═══════════════════════════════════════════════════════════════
// packages/core/src/dx/orm.ts
// ═══════════════════════════════════════════════════════════════

export type NamingConvention = 'camelCase' | 'snake_case' | 'preserve';

export interface OrmOptions<T extends SchemaDefinition = SchemaDefinition> {
  /** Schema created with schema() + ref() */
  readonly schema: Schema<T>;

  /** Adapter for database execution (optional for compile-only) */
  readonly adapter?: Adapter<unknown>;

  /** Enable strict mode validation (default: false) */
  readonly strictMode?: boolean;

  // REMOVED: relationHints - use inverse: in schema definition instead
  // REMOVED: defaultIncludeStrategy - smart auto-selection is sufficient
}

/**
 * Creates an ORM instance from a schema.
 *
 * @example Compile-only (no adapter)
 * ```typescript
 * const orm = createOrm({ schema: mySchema });
 * const { sql, params } = orm.select('users').dump();
 * ```
 *
 * @example Full ORM with adapter
 * ```typescript
 * const orm = createOrm({ schema: mySchema, adapter });
 * const users = await orm.select('users').all();
 * ```
 */
export function createOrm<T extends SchemaDefinition>(
  options: OrmOptions<T>
): OrmInstance<SchemaToDb<T>>;

// ═══════════════════════════════════════════════════════════════
// packages/core/src/dx/types.ts - Adapter interface extension
// ═══════════════════════════════════════════════════════════════

export interface Adapter<DB = unknown> {
  // ... existing methods ...

  /**
   * Naming convention used by this adapter.
   * - 'camelCase': JS uses camelCase, DB uses snake_case (CamelCasePlugin)
   * - 'snake_case': Both JS and DB use snake_case
   * - 'preserve': No transformation
   */
  readonly namingConvention: NamingConvention;
}

// ═══════════════════════════════════════════════════════════════
// packages/adapter-kysely/src/introspection.ts
// ═══════════════════════════════════════════════════════════════

export interface IntrospectionOptions {
  /** Database schema to introspect (default: 'public') */
  readonly schema?: string;

  /** Tables to include (whitelist). If empty, includes all. */
  readonly tables?: readonly string[];

  /** Glob patterns to exclude (e.g., ['_*', 'pg_*']) */
  readonly exclude?: readonly string[];
}

/**
 * Introspects database and returns a Schema<T>.
 *
 * Naming convention is determined by the adapter (no separate option).
 *
 * @example
 * ```typescript
 * const adapter = createKyselyAdapter(db);
 * const schema = await getSchemaFromDb(adapter, {
 *   schema: 'public',
 *   exclude: ['_migrations', 'spatial_*'],
 * });
 * const orm = createOrm({ schema, adapter });
 * ```
 */
export function getSchemaFromDb<T extends SchemaDefinition = SchemaDefinition>(
  adapter: KyselyAdapter<unknown>,
  options?: IntrospectionOptions
): Promise<Schema<T>>;
```

### Adapter namingConvention

```typescript
// ═══════════════════════════════════════════════════════════════
// packages/adapter-kysely/src/kysely-adapter.ts
// ═══════════════════════════════════════════════════════════════

export interface KyselyAdapterOptions {
  /**
   * Naming convention for column mapping.
   * - 'camelCase': Assumes CamelCasePlugin is configured
   * - 'snake_case': No transformation
   * - 'preserve': No transformation (alias for snake_case)
   *
   * If not specified, attempts to detect CamelCasePlugin presence.
   * @default 'camelCase' (matches compile-only-adapter default)
   */
  readonly namingConvention?: NamingConvention;

  /** Database schema for multi-tenant (optional) */
  readonly schema?: string;
}

export function createKyselyAdapter<DB = unknown>(
  db: Kysely<DB>,
  options?: KyselyAdapterOptions
): KyselyAdapter<DB>;

// Implementation stores and exposes namingConvention
class KyselyAdapterImpl<DB> implements KyselyAdapter<DB> {
  readonly namingConvention: NamingConvention;

  constructor(db: Kysely<DB>, options?: KyselyAdapterOptions) {
    this.namingConvention = options?.namingConvention
      ?? this.detectNamingConvention(db)
      ?? 'camelCase';  // default matches compile-only-adapter
  }

  private detectNamingConvention(db: Kysely<DB>): NamingConvention | undefined {
    // Attempt to detect CamelCasePlugin via executor plugins
    // Return undefined if detection fails (use default)
  }
}
```

### getSchemaFromDb Implementation

```typescript
// ═══════════════════════════════════════════════════════════════
// packages/adapter-kysely/src/introspection.ts
// ═══════════════════════════════════════════════════════════════

export async function getSchemaFromDb<T extends SchemaDefinition>(
  adapter: KyselyAdapter<unknown>,
  options: IntrospectionOptions = {}
): Promise<Schema<T>> {
  const db = adapter.getKyselyInstance();
  const naming = adapter.namingConvention;  // Single source of truth

  // 1. Get table metadata via Kysely introspection API
  const tableMetadata = await db.introspection.getTables({
    withInternalKyselyTables: false,
  });

  // 2. Filter by schema/tables/exclude
  const filtered = filterTables(tableMetadata, options);

  // 3. Get foreign keys (raw SQL, dialect-specific)
  const foreignKeys = await getForeignKeys(db, options.schema ?? 'public');

  // 4. Build SchemaDefinition
  const definition = buildSchemaDefinition(filtered, foreignKeys, naming);

  // 5. Return Schema<T> (same as schema() would return)
  return schema(definition as T);
}

function buildSchemaDefinition(
  tables: TableMetadata[],
  foreignKeys: ForeignKeyInfo[],
  naming: NamingConvention
): SchemaDefinition {
  const definition: SchemaDefinition = {};

  for (const table of tables) {
    const tableName = transformName(table.name, naming);
    const tableDef: TableDef = {};

    // Columns
    for (const col of table.columns) {
      const colName = transformName(col.name, naming);
      const fk = foreignKeys.find(f =>
        f.table === table.name && f.column === col.name
      );

      if (fk) {
        // Foreign key → ref()
        tableDef[colName] = ref(transformName(fk.targetTable, naming), {
          column: colName,
          // Detect inverse name from existing relations or generate
        });
      } else {
        // Regular column → type
        tableDef[colName] = mapColumnType(col.dataType);
      }
    }

    definition[tableName] = tableDef;
  }

  return definition;
}

function transformName(name: string, naming: NamingConvention): string {
  switch (naming) {
    case 'camelCase':
      return snakeToCamel(name);  // DB snake_case → JS camelCase
    case 'snake_case':
    case 'preserve':
      return name;
  }
}
```

## Migration Guide

### Before (ARCH-005)

```typescript
// Pattern 1: TypedSchema (to be removed)
const schema = {
  tables: {
    users: {
      columns: { id: { type: 'uuid' } },
      relations: { posts: hasMany('posts') },
    },
  },
} satisfies TypedSchema;
const orm = createOrm({ schema, adapter });

// Pattern 2: Async introspection (to be removed)
const orm = await createOrm({ adapter });

// Pattern 3: Model directly (to be removed)
const orm = createOrm({ model: myModelIR, adapter });

// Pattern 4: Unified schema (ARCH-005 - to keep)
const mySchema = schema({ users: { id: 'uuid' } });
const orm = createOrm({ schema: mySchema, adapter });
```

### After (ARCH-006)

```typescript
// ONLY pattern: schema() + createOrm()
const mySchema = schema({
  users: { id: 'uuid', name: 'string' },
  posts: { id: 'uuid', authorId: ref('users') },
});
const orm = createOrm({ schema: mySchema, adapter });

// Introspection: separate function
const introSchema = await getSchemaFromDb(adapter, { schema: 'public' });
const orm = createOrm({ schema: introSchema, adapter });
```

## Removed APIs

| API | Replacement |
|-----|-------------|
| `createOrm({ model })` | `createOrm({ schema: schema(...) })` |
| `createOrm<S>({ schema: TypedSchema })` | `createOrm({ schema: schema(...) })` |
| `await createOrm({ adapter })` | `await getSchemaFromDb(adapter)` then `createOrm({ schema })` |
| `TypedSchema` type | `SchemaDefinition` via `schema()` |
| `TypedOrmInstance<S>` | `OrmInstance<DB>` |
| `hasOne()`, `hasMany()` helpers | `ref()` with options |
| `typedSchemaToModelIR()` | `schemaToModelIR()` (internal) |
| `IntrospectionOptions.relationNaming` | `adapter.namingConvention` |
| `OrmOptions.relationHints` | Use `inverse:` in `ref()` schema definition |
| `OrmOptions.defaultIncludeStrategy` | Smart auto-selection (removed, not replaced) |

## Implementation Plan

### Phase 1: Adapter Enhancement (2h)

1. Add `namingConvention` to `Adapter` interface in core
2. Implement in `KyselyAdapter`:
   - Store in constructor
   - Expose as readonly property
   - Add detection logic for CamelCasePlugin
3. Update `createKyselyAdapter()` signature

### Phase 2: getSchemaFromDb (3h)

1. Create `getSchemaFromDb()` function in adapter-kysely
2. Refactor existing `introspect()` to use it internally
3. Remove `relationNaming` option (use adapter.namingConvention)
4. Return `Schema<T>` instead of `IntrospectedModelIR`

### Phase 3: Simplify createOrm (2h)

1. Remove TypedSchema overload
2. Remove async introspection overload
3. Remove model-only overload
4. Keep only `OrmOptions<T>` with required `schema`
5. Remove `TypedOrmInstance` type

### Phase 4: Cleanup & Migration (1h)

1. Update all tests to use new API
2. Update examples
3. Remove dead code (TypedSchema, hasOne, hasMany, etc.)
4. Update documentation

## Test Plan

### Unit Tests

```typescript
describe('createOrm', () => {
  it('creates ORM with schema only (compile-only)', () => {
    const orm = createOrm({ schema: testSchema });
    expect(orm.select('users').dump().sql).toContain('SELECT');
  });

  it('creates ORM with schema and adapter', async () => {
    const orm = createOrm({ schema: testSchema, adapter });
    const users = await orm.select('users').all();
    expect(users).toEqual([]);
  });

  it('throws if no schema provided', () => {
    // @ts-expect-error - schema required
    expect(() => createOrm({ adapter })).toThrow();
  });
});

describe('getSchemaFromDb', () => {
  it('returns Schema<T> from database', async () => {
    const schema = await getSchemaFromDb(adapter);
    expect(schema.model).toBeDefined();
    expect(schema.tableNames).toContain('users');
  });

  it('respects adapter.namingConvention', async () => {
    const camelAdapter = createKyselyAdapter(db, { namingConvention: 'camelCase' });
    const schema = await getSchemaFromDb(camelAdapter);
    expect(schema.tableNames).toContain('userProfiles'); // not user_profiles
  });

  it('filters tables by whitelist', async () => {
    const schema = await getSchemaFromDb(adapter, { tables: ['users'] });
    expect(schema.tableNames).toEqual(['users']);
  });

  it('excludes tables by pattern', async () => {
    const schema = await getSchemaFromDb(adapter, { exclude: ['_*'] });
    expect(schema.tableNames).not.toContain('_migrations');
  });
});

describe('Adapter.namingConvention', () => {
  it('defaults to camelCase', () => {
    const adapter = createKyselyAdapter(db);
    expect(adapter.namingConvention).toBe('camelCase');
  });

  it('accepts explicit override', () => {
    const adapter = createKyselyAdapter(db, { namingConvention: 'snake_case' });
    expect(adapter.namingConvention).toBe('snake_case');
  });
});
```

### Integration Tests

- Introspect real PostgreSQL database
- Verify naming convention applied consistently
- Round-trip: introspect → createOrm → query → verify results

## Edge Cases (LLM Consensus Review)

*Validated by: LM Studio, Codex (GPT-5.2), Gemini - 2026-01-26*

### 1. Convention Mismatch

**Risk:** Schema defined with camelCase, adapter configured with snake_case (or vice versa).

**Solution:** Validate in `createOrm()`:

```typescript
export function createOrm<T extends SchemaDefinition>(
  options: OrmOptions<T>
): OrmInstance<SchemaToDb<T>> {
  const { schema, adapter } = options;

  // Validate naming convention consistency
  if (adapter && schema.namingConvention && adapter.namingConvention) {
    if (schema.namingConvention !== adapter.namingConvention) {
      throw new NamingConventionMismatchError(
        `Schema uses '${schema.namingConvention}' but adapter uses '${adapter.namingConvention}'. ` +
        `Either align them or use adapter.withNamingConvention() to override.`
      );
    }
  }
  // ...
}
```

**Schema Enhancement:** Add optional `namingConvention` to `Schema<T>`:

```typescript
export interface Schema<T extends SchemaDefinition> {
  readonly definition: T;
  readonly model: ModelIR;
  readonly tableNames: readonly string[];
  readonly namingConvention?: NamingConvention; // NEW: for validation
}
```

### 2. Schema Drift (Introspected Schema)

**Risk:** Schema introspected at build time, DB schema changes at runtime.

**Solution:** Add `introspectedAt` timestamp and optional staleness check:

```typescript
export interface IntrospectedSchema<T> extends Schema<T> {
  readonly introspectedAt: Date;
  readonly sourceDb: string; // connection identifier
}

// Optional: warn if schema is stale
createOrm({
  schema: introspectedSchema,
  adapter,
  warnIfStaleAfter: 24 * 60 * 60 * 1000 // 24h
});
```

### 3. Async Adapter Setup (Connect/Auth)

**Risk:** Adapter requires async initialization (connection pool, auth).

**Solution:** Adapter creation remains sync, connection is lazy:

```typescript
// Adapter creation is sync (no connection yet)
const adapter = createKyselyAdapter(db);

// Connection happens on first query
const orm = createOrm({ schema, adapter });
await orm.select('users').all(); // <-- connection established here
```

**For explicit connection control:**

```typescript
// Explicit connect for warming/health checks
await adapter.connect(); // optional
const orm = createOrm({ schema, adapter });
```

### 4. Legacy System Override

**Risk:** Legacy DB uses mixed naming conventions (some tables camelCase, some snake_case).

**Solution:** Per-table override in schema definition:

```typescript
const mySchema = schema({
  users: { id: 'uuid', firstName: 'string' }, // follows adapter convention
  LEGACY_TBL: {
    ID: 'number',
    _naming: 'preserve' // NEW: override for this table only
  },
});
```

### 5. Multi-Tenant Schema Interaction

**Risk:** `orm.withSchema('tenant_123')` combined with namingConvention.

**Solution:** Schema scoping is orthogonal to naming:

```typescript
const orm = createOrm({ schema, adapter }); // namingConvention from adapter
const tenantOrm = orm.withSchema('tenant_123'); // same namingConvention
// SQL: SELECT "first_name" FROM "tenant_123"."users"
```

**Clarify in docs:** `withSchema()` changes PostgreSQL schema prefix, not naming convention.

### 6. Testing/Mocking Without DB

**Risk:** Tests need ORM without real adapter connection.

**Solution:** Compile-only mode already supports this:

```typescript
// Test: no adapter, compile-only
const orm = createOrm({ schema: testSchema });
const { sql, params } = orm.select('users').where(eq('id', 1)).dump();
expect(sql).toContain('WHERE');

// Test: mock adapter
const mockAdapter = createMockAdapter({ namingConvention: 'camelCase' });
const orm = createOrm({ schema: testSchema, adapter: mockAdapter });
```

## Risks & Mitigations

| Risk | Mitigation | Priority |
|------|------------|----------|
| Breaking change for TypedSchema users | Provide codemod or migration guide | HIGH |
| CamelCasePlugin detection unreliable | Default to 'camelCase', allow explicit override | MEDIUM |
| Introspection returns incomplete schema | Add warnings for unmapped types (existing) | LOW |
| **Convention mismatch** (schema vs adapter) | Validate in createOrm(), throw early | HIGH |
| **Schema drift** after introspection | Add `introspectedAt` metadata, optional staleness warning | MEDIUM |
| **Legacy mixed conventions** | Per-table `_naming` override | LOW |

## Success Criteria

1. Single `createOrm()` signature (no overloads)
2. `getSchemaFromDb()` returns `Schema<T>` (not ModelIR)
3. `adapter.namingConvention` is single source of truth
4. All tests pass
5. Examples updated and working
6. No TypedSchema references in codebase

## References

- [ARCH-005: Unified Schema API](./ARCH-005-unified-schema-api.md)
- [Kysely CamelCasePlugin](https://kysely.dev/docs/recipes/camel-case)
- [Kysely Introspection API](https://kysely.dev/docs/recipes/introspection)
