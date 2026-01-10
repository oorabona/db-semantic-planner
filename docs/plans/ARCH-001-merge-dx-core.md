# ARCH-001: Merge dx + core Implementation Spec

---
doc-meta:
  status: canonical
  scope: core, adapter-kysely
  type: spec
  created: 2026-01-10
  completed: 2026-01-10
  adr: ADR-002
---

## Overview

Merge `packages/dx` into `packages/core` to create a true adapter-agnostic architecture.

**Goal**: Enable multi-adapter support (Kysely, Drizzle, Prisma) without code duplication.

## BDD Scenarios

### Feature: Adapter-agnostic ORM

```gherkin
Scenario: Create ORM with Kysely adapter
  Given a ModelIR schema
  And a Kysely database instance
  When I create an adapter with createKyselyAdapter(db)
  And I create an ORM with createOrm({ model, adapter })
  Then I can execute queries via orm.select('users').all()

Scenario: Create ORM without adapter (plan-only mode)
  Given a ModelIR schema
  When I create an ORM with createOrm({ model })
  Then I can call orm.select('users').plan()
  And I can call orm.select('users').dump()
  But calling orm.select('users').all() throws "Adapter required"

Scenario: Multi-tenant with adapter
  Given an ORM with Kysely adapter
  When I call orm.forTenant('tenant_123')
  Then queries use adapter.withSchema('tenant_123')
  And SQL includes schema prefix "tenant_123.users"

Scenario: Transaction with adapter
  Given an ORM with Kysely adapter
  When I call orm.transaction(async (tx) => { ... })
  Then it delegates to adapter.transaction()
  And auto-commits on success
  And auto-rollbacks on exception

Scenario: Missing capability error
  Given an adapter without streaming support
  When I call orm.select('users').stream()
  Then it throws "Operation 'stream' requires capability 'supportsStreaming'"

Scenario: Deprecated dx import
  Given the deprecated dx package
  When I import { createOrm } from '@db-semantic-planner/dx'
  Then it logs a deprecation warning
  And the import works (re-exported from core)
```

## Implementation Blocks

### Block 1: Create AdapterInterface in core

**Files:**
- `packages/core/src/adapter.ts` (new)
- `packages/core/src/index.ts` (export)

**Implementation:**

```typescript
// packages/core/src/adapter.ts

import type { PlanReport } from './planner.js';

/**
 * Adapter capabilities - what the underlying database/ORM supports
 */
export interface AdapterCapabilities {
  readonly supportsReturning: boolean;
  readonly supportsSchemas: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsRecursiveCTE: boolean;
  readonly supportsWindowFunctions: boolean;
  readonly supportsArrayType: boolean;
}

/**
 * Compiled query ready for execution
 */
export interface CompiledQuery<T = unknown> {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  /** Phantom type for result inference */
  readonly __resultType?: T;
}

/**
 * Stream options for paginated/chunked results
 */
export interface StreamOptions {
  readonly chunkSize?: number;
}

/**
 * Dump for observability
 */
export interface Dump {
  readonly plan: PlanReport;
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly meta?: DumpMeta;
}

export interface DumpMeta {
  readonly tenant?: string;
  readonly queryName?: string;
  readonly correlationId?: string;
}

/**
 * Adapter interface - implemented by each database adapter
 * 
 * @typeParam DB - Database schema type for type inference
 */
export interface Adapter<DB = unknown> {
  /** Adapter capabilities */
  readonly capabilities: AdapterCapabilities;

  /**
   * Compile a plan to executable SQL
   */
  compile<T>(plan: PlanReport): CompiledQuery<T>;

  /**
   * Execute a query and return all results
   */
  execute<T>(query: CompiledQuery<T>): Promise<T[]>;

  /**
   * Execute a query and return first result or null
   */
  executeOne<T>(query: CompiledQuery<T>): Promise<T | null>;

  /**
   * Execute a query and return first result or throw
   */
  executeOneOrThrow<T>(query: CompiledQuery<T>): Promise<T>;

  /**
   * Stream query results
   */
  stream<T>(query: CompiledQuery<T>, options?: StreamOptions): AsyncIterable<T>;

  /**
   * Execute within a transaction
   * Auto-commits on success, auto-rollbacks on exception
   */
  transaction<T>(fn: (adapter: Adapter<DB>) => Promise<T>): Promise<T>;

  /**
   * Create schema-scoped adapter for multi-tenant
   */
  withSchema(schemaName: string): Adapter<DB>;

  /**
   * Create dump for observability
   */
  createDump(plan: PlanReport, query: CompiledQuery): Dump;
}

/**
 * Error thrown when adapter is required but not provided
 */
export class AdapterRequiredError extends Error {
  constructor(operation: string) {
    super(
      `Operation '${operation}' requires an adapter. ` +
      `Pass an adapter when creating the ORM: createOrm({ model, adapter })`
    );
    this.name = 'AdapterRequiredError';
  }
}

/**
 * Error thrown when operation requires unsupported capability
 */
export class UnsupportedCapabilityError extends Error {
  constructor(operation: string, capability: keyof AdapterCapabilities) {
    super(
      `Operation '${operation}' requires capability '${capability}' ` +
      `which is not supported by the current adapter.`
    );
    this.name = 'UnsupportedCapabilityError';
  }
}
```

**Tests:**
- Unit test for AdapterRequiredError
- Unit test for UnsupportedCapabilityError

---

### Block 2: Move dx source files to core

**Files to move:**

| From | To |
|------|-----|
| `packages/dx/src/filters.ts` | `packages/core/src/dx/filters.ts` |
| `packages/dx/src/types.ts` | `packages/core/src/dx/types.ts` |
| `packages/dx/src/orm.ts` | `packages/core/src/dx/orm.ts` |
| `packages/dx/src/errors.ts` | `packages/core/src/dx/errors.ts` |
| `packages/dx/src/mutation-builders.ts` | `packages/core/src/dx/mutation-builders.ts` |
| `packages/dx/src/subquery-builder.ts` | `packages/core/src/dx/subquery-builder.ts` |
| `packages/dx/src/recursive-query-builder.ts` | `packages/core/src/dx/recursive-query-builder.ts` |
| `packages/dx/src/object-filter.ts` | `packages/core/src/dx/object-filter.ts` |
| `packages/dx/src/lightweight-model.ts` | `packages/core/src/dx/lightweight-model.ts` |

**Update imports:**
- Change `@db-semantic-planner/core` → relative imports
- Remove `@db-semantic-planner/adapter-kysely` imports (will be injected)

---

### Block 3: Move dx test files to core

**Files to move:**

| From | To |
|------|-----|
| `packages/dx/src/*.test.ts` | `packages/core/src/dx/*.test.ts` |

**Update test imports:**
- Change package imports to relative
- Tests requiring execution will need adapter injection

---

### Block 4: Refactor createOrm for adapter injection

**File:** `packages/core/src/dx/orm.ts`

**Before:**
```typescript
export function createOrm<DB>(options: OrmOptions): OrmInstance<DB> {
  const { model, db } = options;
  // Uses Kysely directly
}
```

**After:**
```typescript
export interface OrmOptions<DB = unknown> {
  model: ModelIR;
  adapter?: Adapter<DB>;
  strictMode?: boolean;
  relationHints?: RelationHints;
}

export function createOrm<DB = unknown>(options: OrmOptions<DB>): OrmInstance<DB> {
  const { model, adapter, strictMode = false, relationHints = {} } = options;
  
  return createOrmInstance<DB>(
    model,
    strictMode,
    relationHints,
    adapter,
    undefined, // schemaName - set via forTenant
  );
}
```

**QueryBuilder changes:**
- `plan()` - works without adapter
- `dump()` - works without adapter (uses adapter.createDump if available)
- `all()`, `first()`, `execute()` - require adapter, throw AdapterRequiredError
- `stream()` - require adapter + capability check

---

### Block 5: Implement KyselyAdapter in adapter-kysely

**File:** `packages/adapter-kysely/src/adapter.ts` (new)

```typescript
import type { Kysely } from 'kysely';
import type { 
  Adapter, 
  AdapterCapabilities, 
  CompiledQuery, 
  Dump,
  StreamOptions 
} from '@db-semantic-planner/core';
import type { PlanReport } from '@db-semantic-planner/core';
import { compile } from './compiler.js';
import { getCapabilities } from './dialect.js';
import { streamQuery } from './stream.js';
import { createDump } from './dump.js';

export function createKyselyAdapter<DB>(db: Kysely<DB>): Adapter<DB> {
  const capabilities = getCapabilities(db);
  
  return {
    capabilities,
    
    compile<T>(plan: PlanReport): CompiledQuery<T> {
      const compiled = compile(plan, db);
      return {
        sql: compiled.sql,
        parameters: compiled.parameters as readonly unknown[],
      };
    },
    
    async execute<T>(query: CompiledQuery<T>): Promise<T[]> {
      const result = await db.executeQuery<T>({
        sql: query.sql,
        parameters: [...query.parameters],
      });
      return result.rows;
    },
    
    async executeOne<T>(query: CompiledQuery<T>): Promise<T | null> {
      const rows = await this.execute<T>(query);
      return rows[0] ?? null;
    },
    
    async executeOneOrThrow<T>(query: CompiledQuery<T>): Promise<T> {
      const result = await this.executeOne<T>(query);
      if (result === null) {
        throw new NotFoundError('Query returned no results');
      }
      return result;
    },
    
    stream<T>(query: CompiledQuery<T>, options?: StreamOptions): AsyncIterable<T> {
      return streamQuery<T>(db, query, options);
    },
    
    async transaction<T>(fn: (adapter: Adapter<DB>) => Promise<T>): Promise<T> {
      return db.transaction().execute(async (trx) => {
        const txAdapter = createKyselyAdapter(trx as unknown as Kysely<DB>);
        return fn(txAdapter);
      });
    },
    
    withSchema(schemaName: string): Adapter<DB> {
      validateIdentifier(schemaName, 'schema');
      return createKyselyAdapter(db.withSchema(schemaName));
    },
    
    createDump(plan: PlanReport, query: CompiledQuery): Dump {
      return createDump(plan, query);
    },
  };
}
```

**Export from index.ts:**
```typescript
export { createKyselyAdapter } from './adapter.js';
export type { Adapter, AdapterCapabilities } from '@db-semantic-planner/core';
```

---

### Block 6: Update core exports

**File:** `packages/core/src/index.ts`

Add exports for:
- All dx modules
- AdapterInterface and related types
- Errors

---

### Block 7: Delete dx package

**Actions:**
1. Delete `packages/dx/` directory entirely
2. Remove from `pnpm-workspace.yaml`
3. Remove from root `package.json` references
4. Update any remaining imports in adapter-kysely

---

### Block 8: Update all tests and verify

**Tasks:**
1. Run all tests in core package
2. Run all tests in adapter-kysely package
3. Verify deprecated dx package re-exports work
4. Integration test: createOrm with createKyselyAdapter

---

## Test Requirements

| Block | Tests Required |
|-------|----------------|
| Block 1 | AdapterRequiredError, UnsupportedCapabilityError |
| Block 2-3 | Existing tests should pass after move |
| Block 4 | createOrm without adapter (plan-only mode) |
| Block 5 | createKyselyAdapter integration |
| Block 7 | dx package deleted, no remaining references |
| Block 8 | Full regression: all tests passing |

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Import path changes break users | Deprecation period with re-exports |
| Test failures after move | Run tests after each block |
| Circular dependencies | Careful import organization |
| Type inference breaks | Preserve generic signatures |

## Rollback Plan

If issues arise:
1. Revert commits
2. Keep dx package as primary
3. Document issues for future attempt
