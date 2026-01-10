# ARCH-002 v2: Codegen-First "One Ring" - Technical Specification

> **Status:** CANONICAL  
> **Brief:** [docs/briefs/ARCH-002-one-ring.md](../briefs/ARCH-002-one-ring.md)  
> **Scope:** core, schema, cli, kysely

---

## Overview

This specification details the implementation of ARCH-002 v2, transforming db-semantic-planner into a **codegen-first schema platform** where `dbsp.schema.ts` is the Source of Truth (SoT).

**Key Principle:** Build-time code generation, NOT runtime introspection.

---

## Block 1: Schema DSL (`defineSchema`)

### Goal

Provide a TypeScript DSL for defining the Source of Truth schema.

### File Location

**Package:** `packages/schema`  
**File:** `packages/schema/src/define.ts`

### Core Types

```typescript
// packages/schema/src/types.ts

export type ColumnType = 
  | 'uuid' 
  | 'string' 
  | 'text' 
  | 'number' 
  | 'integer' 
  | 'bigint'
  | 'decimal' 
  | 'boolean' 
  | 'timestamp' 
  | 'date' 
  | 'json' 
  | 'jsonb';

export interface ColumnDefinition {
  type: ColumnType;
  nullable?: boolean;        // Default: false
  primaryKey?: boolean;      // Default: false
  unique?: boolean;          // Default: false
  default?: string | number | boolean | 'now()';
  /** Explicit FK reference (takes priority over conventions) */
  references?: {
    table: string;
    column?: string;         // Default: 'id'
  };
}

export interface TableDefinition {
  [columnName: string]: ColumnDefinition;
}

// ============================================================
// RELATION DEFINITIONS - Discriminated Union (Adjustment #2)
// ============================================================

export type RelationKind = 'belongsTo' | 'hasMany' | 'manyToMany';

interface RelationBase {
  /** Target table name */
  target: string;
  /** Planner hints */
  hints?: {
    defaultStrategy?: 'join' | 'exists';
  };
}

/** Many-to-one: FK column is in SOURCE table */
export interface BelongsToRelation extends RelationBase {
  kind: 'belongsTo';
  /** FK column in this (source) table */
  foreignKey: string;
  /** Target column (default: 'id') */
  targetKey?: string;
}

/** One-to-many: FK column is in TARGET table */
export interface HasManyRelation extends RelationBase {
  kind: 'hasMany';
  /** FK column in target table pointing back to source */
  foreignKey: string;
  /** Source column (default: 'id') */
  sourceKey?: string;
}

/** Many-to-many: via junction table */
export interface ManyToManyRelation extends RelationBase {
  kind: 'manyToMany';
  /** Junction table name */
  through: string;
  /** FK in junction pointing to source */
  sourceFk: string;
  /** FK in junction pointing to target */
  targetFk: string;
}

export type RelationDefinition = BelongsToRelation | HasManyRelation | ManyToManyRelation;

// ============================================================

export interface HintDefinition {
  defaultStrategy?: 'join' | 'exists';
  cardinality?: 'one' | 'many';
}

export interface ConventionConfig {
  /** FK pattern. Default: '{singular}Id' */
  fkPattern?: string;
  /** Auto-pluralize table names. Default: true */
  pluralize?: boolean;
  /** Timestamp columns (auto-detected). Default: ['createdAt', 'updatedAt'] */
  timestamps?: string[];
  /** Custom singular→plural mapping */
  pluralMap?: Record<string, string>;
}

export interface SchemaDefinition {
  tables: Record<string, TableDefinition>;
  relations?: Record<string, RelationDefinition>;
  hints?: Record<string, HintDefinition>;
  conventions?: ConventionConfig;
}

export interface Schema<T extends SchemaDefinition = SchemaDefinition> {
  readonly tables: T['tables'];
  readonly relations: Map<string, RelationDefinition>;
  readonly hints: Map<string, HintDefinition>;
  readonly conventions: Required<ConventionConfig>;
  /** Raw definition for serialization */
  readonly _raw: T;
}
```

### Schema Definition Example (with discriminated relations)

```typescript
// dbsp.schema.ts
export const schema = defineSchema({
  tables: {
    users: {
      id: { type: 'uuid', primaryKey: true },
      name: { type: 'string', nullable: false },
    },
    posts: {
      id: { type: 'uuid', primaryKey: true },
      title: { type: 'string', nullable: false },
      authorId: { type: 'uuid', references: { table: 'users' } }, // Explicit FK
      editorId: { type: 'uuid', nullable: true }, // Convention-based
    },
    categories: {
      id: { type: 'uuid', primaryKey: true },
      name: { type: 'string', nullable: false },
    },
    post_categories: {
      postId: { type: 'uuid', references: { table: 'posts' } },
      categoryId: { type: 'uuid', references: { table: 'categories' } },
    },
  },
  relations: {
    // belongsTo: FK is in posts
    'posts.author': { kind: 'belongsTo', target: 'users', foreignKey: 'authorId' },
    'posts.editor': { kind: 'belongsTo', target: 'users', foreignKey: 'editorId' },
    // hasMany: FK is in posts (pointing back)
    'users.authoredPosts': { kind: 'hasMany', target: 'posts', foreignKey: 'authorId' },
    'users.editedPosts': { kind: 'hasMany', target: 'posts', foreignKey: 'editorId' },
    // manyToMany: via junction
    'posts.categories': { 
      kind: 'manyToMany', 
      target: 'categories', 
      through: 'post_categories',
      sourceFk: 'postId',
      targetFk: 'categoryId',
    },
    'categories.posts': { 
      kind: 'manyToMany', 
      target: 'posts', 
      through: 'post_categories',
      sourceFk: 'categoryId',
      targetFk: 'postId',
    },
  },
});
```

### Implementation

```typescript
// packages/schema/src/define.ts

import type { Schema, SchemaDefinition, ConventionConfig } from './types.js';

const DEFAULT_CONVENTIONS: Required<ConventionConfig> = {
  fkPattern: '{singular}Id',
  pluralize: true,
  timestamps: ['createdAt', 'updatedAt'],
  pluralMap: {
    person: 'people',
    child: 'children',
    category: 'categories',
  },
};

export function defineSchema<T extends SchemaDefinition>(definition: T): Schema<T> {
  const relations = new Map<string, RelationDefinition>();
  const hints = new Map<string, HintDefinition>();
  
  // Parse relations
  if (definition.relations) {
    for (const [path, rel] of Object.entries(definition.relations)) {
      relations.set(path, rel);
    }
  }
  
  // Parse hints
  if (definition.hints) {
    for (const [path, hint] of Object.entries(definition.hints)) {
      hints.set(path, hint);
    }
  }
  
  const conventions = {
    ...DEFAULT_CONVENTIONS,
    ...definition.conventions,
    pluralMap: {
      ...DEFAULT_CONVENTIONS.pluralMap,
      ...definition.conventions?.pluralMap,
    },
  };
  
  return {
    tables: definition.tables,
    relations,
    hints,
    conventions,
    _raw: definition,
  };
}
```

### BDD Scenarios

```gherkin
Feature: Schema DSL

  Scenario: Define simple schema
    Given a schema definition with tables "users" and "posts"
    When I call defineSchema(definition)
    Then I should get a Schema object
    And schema.tables should contain "users" and "posts"

  Scenario: Define relations explicitly
    Given a schema with relation 'posts.author' → 'users'
    When I call defineSchema(definition)
    Then schema.relations should have key "posts.author"
    And the relation target should be "users"

  Scenario: Merge conventions with defaults
    Given a schema with conventions { pluralMap: { ox: 'oxen' } }
    When I call defineSchema(definition)
    Then schema.conventions.pluralMap should include "ox" → "oxen"
    And schema.conventions.pluralMap should include default "person" → "people"

  Scenario: Define hints
    Given a schema with hints { 'posts.comments': { defaultStrategy: 'exists' } }
    When I call defineSchema(definition)
    Then schema.hints should have key "posts.comments"
    And the hint defaultStrategy should be "exists"
```

---

## Block 2: Convention Inference

### Goal

Auto-detect FK relationships and M:N junction tables from schema definition.

### FK Detection Priority (Adjustment #4)

1. **Explicit `references`** in ColumnDefinition → always wins
2. **Convention pattern** (`{singular}Id`) → fallback

### M:N Detection Rules

1. Table has **exactly 2 FK columns**
2. Both FKs reference **different existing tables**
3. **No business columns** (excluding: id, primaryKey, timestamps)

### M:N Path Naming (Adjustment #3)

Paths use **opposite table name** (pluralized), not junction table name:
- Junction: `post_categories` with `postId`, `categoryId`
- Generated: `posts.categories` (not `posts.post_categories`)
- Generated: `categories.posts` (not `categories.post_categories`)

### Implementation

**File:** `packages/schema/src/conventions.ts`

```typescript
import type { 
  Schema, TableDefinition, ColumnDefinition,
  BelongsToRelation, HasManyRelation, ManyToManyRelation, RelationDefinition 
} from './types.js';

export interface InferredRelation {
  path: string;
  relation: RelationDefinition;  // Discriminated union with kind
}

export function inferRelations(schema: Schema): InferredRelation[] {
  const { tables, conventions } = schema;
  const tableNames = new Set(Object.keys(tables));
  const relations: InferredRelation[] = [];
  
  for (const [tableName, table] of Object.entries(tables)) {
    const fkColumns = detectForeignKeys(tableName, table, conventions, tableNames);
    
    // Check for M:N junction table
    if (isJunctionTable(table, fkColumns, conventions)) {
      const [fk1, fk2] = fkColumns;
      
      // ADJUSTMENT #3: Use opposite table name (pluralized), not junction name
      // posts.categories (not posts.post_categories)
      relations.push({
        path: `${fk1.targetTable}.${fk2.targetTable}`,  // posts.categories
        relation: {
          kind: 'manyToMany',
          target: fk2.targetTable,
          through: tableName,
          sourceFk: fk1.column,
          targetFk: fk2.column,
        } satisfies ManyToManyRelation,
      });
      
      // Inverse: categories.posts
      relations.push({
        path: `${fk2.targetTable}.${fk1.targetTable}`,  // categories.posts
        relation: {
          kind: 'manyToMany',
          target: fk1.targetTable,
          through: tableName,
          sourceFk: fk2.column,
          targetFk: fk1.column,
        } satisfies ManyToManyRelation,
      });
    } else {
      // Standard 1:N relations
      for (const fk of fkColumns) {
        // belongsTo: posts.author → users
        relations.push({
          path: `${tableName}.${fk.inferredName}`,
          relation: {
            kind: 'belongsTo',
            target: fk.targetTable,
            foreignKey: fk.column,
          } satisfies BelongsToRelation,
        });
        
        // hasMany: users.posts → posts
        relations.push({
          path: `${fk.targetTable}.${tableName}`,
          relation: {
            kind: 'hasMany',
            target: tableName,
            foreignKey: fk.column,
          } satisfies HasManyRelation,
        });
      }
    }
  }
  
  return relations;
}

interface DetectedFK {
  column: string;
  targetTable: string;
  inferredName: string;  // Relation name (e.g., "author" from "authorId")
  explicit: boolean;     // True if from `references`, false if from convention
}

function detectForeignKeys(
  tableName: string,
  table: TableDefinition, 
  conventions: Required<ConventionConfig>,
  tableNames: Set<string>
): DetectedFK[] {
  const fks: DetectedFK[] = [];
  const pattern = conventions.fkPattern.replace('{singular}', '(.+)');
  const regex = new RegExp(`^${pattern}$`);
  
  for (const [colName, colDef] of Object.entries(table)) {
    // ADJUSTMENT #4: Prioritize explicit `references` over conventions
    if (colDef.references) {
      const targetTable = colDef.references.table;
      if (tableNames.has(targetTable)) {
        // Infer relation name from column (strip 'Id' suffix if present)
        const inferredName = colName.replace(/Id$/, '') || colName;
        fks.push({
          column: colName,
          targetTable,
          inferredName,
          explicit: true,
        });
      }
      continue;  // Skip convention check if explicit reference exists
    }
    
    // Fallback: convention-based detection
    const match = colName.match(regex);
    if (!match) continue;
    
    const singular = match[1];
    const targetTable = resolveTableName(singular, tableNames, conventions);
    
    if (targetTable) {
      fks.push({
        column: colName,
        targetTable,
        inferredName: singular,
        explicit: false,
      });
    }
  }
  
  return fks;
}

function isJunctionTable(
  table: TableDefinition,
  fkColumns: DetectedFK[],
  conventions: Required<ConventionConfig>
): boolean {
  if (fkColumns.length !== 2) return false;
  if (fkColumns[0].targetTable === fkColumns[1].targetTable) return false;
  
  // Check for business columns (non-FK, non-metadata)
  const ignoredColumns = new Set([
    'id',
    ...conventions.timestamps,
    ...fkColumns.map(fk => fk.column),
  ]);
  
  // Also ignore columns that are primary keys
  for (const [colName, colDef] of Object.entries(table)) {
    if (colDef.primaryKey) {
      ignoredColumns.add(colName);
    }
  }
  
  for (const colName of Object.keys(table)) {
    if (!ignoredColumns.has(colName)) {
      // Has business column → not a pure junction
      return false;
    }
  }
  
  return true;
}

function resolveTableName(
  singular: string,
  tableNames: Set<string>,
  conventions: Required<ConventionConfig>
): string | null {
  // Exact match
  if (tableNames.has(singular)) return singular;
  
  if (conventions.pluralize) {
    // Custom plural
    const custom = conventions.pluralMap[singular];
    if (custom && tableNames.has(custom)) return custom;
    
    // Simple +s / +es
    if (tableNames.has(singular + 's')) return singular + 's';
    if (tableNames.has(singular + 'es')) return singular + 'es';
  }
  
  return null;
}
```

### BDD Scenarios

```gherkin
Feature: Convention Inference

  Scenario: Explicit references take priority over conventions
    Given table "articles" with column "writer_id" having references: { table: 'users' }
    When I call inferRelations(schema)
    Then I should get relation "articles.writer" targeting "users"
    And the FK should be detected as explicit

  Scenario: Convention fallback when no explicit reference
    Given table "posts" with column "userId" (no references property)
    When I call inferRelations(schema)
    Then I should get relation "posts.user" targeting "users"
    And the FK should be detected as convention-based

  Scenario: M:N paths use opposite table name (not junction)
    Given schema with junction "post_categories" (postId, categoryId)
    When I call inferRelations(schema)
    Then I should get relation "posts.categories" (not "posts.post_categories")
    And I should get relation "categories.posts" (not "categories.post_categories")

  Scenario: Detect belongsTo from userId
    Given schema with tables "users" and "posts" where posts.userId exists
    When I call inferRelations(schema)
    Then I should get relation "posts.user" with kind "belongsTo"
    And I should get relation "users.posts" with kind "hasMany"

  Scenario: NOT detect M:N when junction has business columns
    Given schema with junction "order_items" having: orderId, productId, quantity
    When I call inferRelations(schema)
    Then "order_items" should have separate belongsTo relations to "orders" and "products"
    And NO manyToMany relation should be generated
```

---

## Block 3: CLI Scaffold

### Goal

Create `dbsp` CLI binary with commander.

### Package Structure

**Package:** `packages/cli`

```
packages/cli/
├── src/
│   ├── index.ts           # CLI entry point
│   ├── commands/
│   │   ├── generate.ts    # dbsp generate
│   │   ├── verify.ts      # dbsp verify
│   │   └── import.ts      # dbsp import (future)
│   └── utils/
│       ├── config.ts      # Load dbsp.schema.ts
│       └── output.ts      # Formatted output
├── package.json
└── tsconfig.json
```

### Implementation

```typescript
// packages/cli/src/index.ts
import { Command } from 'commander';
import { generateCommand } from './commands/generate.js';
import { verifyCommand } from './commands/verify.js';

const program = new Command();

program
  .name('dbsp')
  .description('db-semantic-planner CLI - Schema-first query planning')
  .version('0.1.0');

program.addCommand(generateCommand);
program.addCommand(verifyCommand);

program.parse();
```

```typescript
// packages/cli/src/commands/generate.ts
import { Command } from 'commander';
import { loadSchema } from '../utils/config.js';

export const generateCommand = new Command('generate')
  .description('Generate typed code for an adapter')
  .argument('<target>', 'Target: kysely | drizzle | manifest')
  .option('-s, --schema <path>', 'Schema file path', 'dbsp.schema.ts')
  .option('-o, --out <dir>', 'Output directory', './generated')
  .action(async (target, options) => {
    const schema = await loadSchema(options.schema);
    
    switch (target) {
      case 'kysely':
        await generateKysely(schema, options.out);
        break;
      case 'manifest':
        await generateManifest(schema, options.out);
        break;
      case 'drizzle':
        await generateDrizzle(schema, options.out);
        break;
      default:
        console.error(`Unknown target: ${target}`);
        process.exit(1);
    }
    
    console.log(`✅ Generated ${target} in ${options.out}`);
  });
```

### BDD Scenarios

```gherkin
Feature: CLI Scaffold

  Scenario: dbsp generate kysely
    Given a valid dbsp.schema.ts
    When I run "dbsp generate kysely --out ./generated/kysely"
    Then it should create ./generated/kysely/DB.ts
    And it should create ./generated/kysely/types.ts

  Scenario: dbsp generate manifest
    Given a valid dbsp.schema.ts
    When I run "dbsp generate manifest --out ./generated/dbsp"
    Then it should create ./generated/dbsp/schema.ts
    And it should create ./generated/dbsp/model.ts

  Scenario: Invalid target
    When I run "dbsp generate unknown"
    Then it should exit with code 1
    And stderr should contain "Unknown target"

  Scenario: Missing schema file
    When I run "dbsp generate kysely --schema nonexistent.ts"
    Then it should exit with code 1
    And stderr should contain "Schema file not found"
```

---

## Block 4: `dbsp generate manifest`

### Goal

Generate ModelIR-compatible manifest from SoT schema.

### Output Files

```
generated/dbsp/
├── schema.ts    # Schema with full types
└── model.ts     # ModelIR for runtime use (plain objects only)
```

### Serialization Rules (Adjustment #5)

**ModelIR in manifest MUST be plain JSON-serializable objects:**

| Type | In Runtime Schema | In Generated model.ts |
|------|-------------------|----------------------|
| `Map<K, V>` | ✅ OK | ❌ Convert to `Record<K, V>` |
| `Set<T>` | ✅ OK | ❌ Convert to `T[]` |
| `bigint` | ✅ OK | ❌ Convert to `string` |
| SQL defaults (`'now()'`) | ✅ OK (symbolic) | ❌ Keep as string literal |
| Functions | ❌ Never | ❌ Never |

**Why:** `JSON.stringify()` loses Map/Set/bigint. Generated files must be self-contained.

### Implementation

```typescript
// packages/cli/src/generators/manifest.ts
import type { Schema, RelationDefinition } from '@db-semantic-planner/schema';
import { inferRelations } from '@db-semantic-planner/schema';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

export async function generateManifest(
  schema: Schema,
  outDir: string
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  
  // Infer relations from conventions
  const inferredRelations = inferRelations(schema);
  
  // Merge explicit + inferred (explicit wins by path)
  const allRelations = mergeRelations(inferredRelations, schema.relations);
  
  // Generate model.ts (ModelIR - plain objects)
  const modelContent = generateModelIR(schema, allRelations);
  await writeFile(join(outDir, 'model.ts'), modelContent);
  
  // Generate schema.ts (typed re-export)
  const schemaContent = generateSchemaExport(schema);
  await writeFile(join(outDir, 'schema.ts'), schemaContent);
}

/**
 * Convert runtime Schema to JSON-serializable ModelIR.
 * 
 * IMPORTANT: Output must be plain objects (no Map, Set, bigint, functions).
 */
function generateModelIR(schema: Schema, relations: Record<string, RelationDefinition>): string {
  // Convert tables to plain object format
  const tables: Record<string, any> = {};
  for (const [tableName, tableDef] of Object.entries(schema.tables)) {
    const columns: Record<string, any> = {};
    for (const [colName, colDef] of Object.entries(tableDef)) {
      columns[colName] = {
        type: colDef.type,
        nullable: colDef.nullable ?? false,
        primaryKey: colDef.primaryKey ?? false,
        // NOTE: default stored as string (not function)
        ...(colDef.default !== undefined && { default: String(colDef.default) }),
        ...(colDef.references && { references: colDef.references }),
      };
    }
    tables[tableName] = { columns };
  }
  
  // Convert hints Map to plain object
  const hints: Record<string, any> = {};
  for (const [path, hint] of schema.hints) {
    hints[path] = hint;
  }
  
  const modelIR = {
    tables,
    relations,  // Already plain object from mergeRelations
    hints,
    conventions: schema.conventions,
  };
  
  return `// Generated by dbsp generate manifest
// Do not edit manually

import type { ModelIR } from '@db-semantic-planner/core/internal';

export const model: ModelIR = ${JSON.stringify(modelIR, null, 2)} as const;
`;
}

function generateSchemaExport(schema: Schema): string {
  return `// Generated by dbsp generate manifest
// Re-exports the schema definition for type inference

export { schema } from '../../dbsp.schema.js';
export type { Schema } from '@db-semantic-planner/schema';
`;
}

/**
 * Merge inferred relations with explicit relations.
 * Explicit relations win when paths match.
 */
function mergeRelations(
  inferred: { path: string; relation: RelationDefinition }[],
  explicit: Map<string, RelationDefinition>
): Record<string, RelationDefinition> {
  const result: Record<string, RelationDefinition> = {};
  
  // Add inferred first
  for (const { path, relation } of inferred) {
    // Skip if explicit relation exists for this path
    if (!explicit.has(path)) {
      result[path] = relation;
    }
  }
  
  // Add explicit (overrides inferred)
  for (const [path, relation] of explicit) {
    result[path] = relation;
  }
  
  return result;
}
```

### Generated Output Example

```typescript
// generated/dbsp/model.ts
import type { ModelIR } from '@db-semantic-planner/core/internal';

export const model: ModelIR = {
  "tables": {
    "users": {
      "columns": {
        "id": { "type": "uuid", "nullable": false, "primaryKey": true },
        "name": { "type": "string", "nullable": false, "primaryKey": false }
      }
    },
    "posts": {
      "columns": {
        "id": { "type": "uuid", "nullable": false, "primaryKey": true },
        "authorId": { "type": "uuid", "nullable": false, "primaryKey": false, "references": { "table": "users" } }
      }
    }
  },
  "relations": {
    "posts.author": { "kind": "belongsTo", "target": "users", "foreignKey": "authorId" },
    "users.posts": { "kind": "hasMany", "target": "posts", "foreignKey": "authorId" }
  },
  "hints": {},
  "conventions": {
    "fkPattern": "{singular}Id",
    "pluralize": true,
    "timestamps": ["createdAt", "updatedAt"],
    "pluralMap": { "person": "people", "child": "children", "category": "categories" }
  }
} as const;
```

### BDD Scenarios

```gherkin
Feature: Generate Manifest

  Scenario: Generate ModelIR with inferred relations
    Given schema with "users" and "posts" (posts.userId)
    When I run "dbsp generate manifest"
    Then model.ts should contain relation "posts.user"
    And model.ts should contain relation "users.posts"

  Scenario: Explicit relations override inferred
    Given schema with inferred "posts.user" and explicit "posts.author"
    When I run "dbsp generate manifest"
    Then model.ts should contain "posts.author"
    And model.ts should NOT contain "posts.user"

  Scenario: M:N relations in manifest
    Given schema with junction "post_categories"
    When I run "dbsp generate manifest"
    Then model.ts should contain "posts.categories" with kind "manyToMany"

  Scenario: Output is valid JSON (plain objects)
    Given any valid schema
    When I run "dbsp generate manifest"
    Then model.ts should parse without errors
    And should contain no Map, Set, or function references
```

---

## Block 5: `dbsp generate kysely`

### Goal

Generate Kysely-compatible DB interface and types with proper Kysely idioms.

### Output Files

```
generated/kysely/
├── DB.ts        # Database interface
└── types.ts     # Table types with Generated/ColumnType
```

### Kysely Type Idioms (Adjustment #6)

Use Kysely's type utilities for correct Insert/Select/Update typing:

| Column | Generated Type | Reason |
|--------|----------------|--------|
| `primaryKey: true` | `Generated<T>` | Auto-generated, optional on insert |
| `default: 'now()'` | `Generated<T>` | Has default, optional on insert |
| `default: <value>` | `Generated<T>` | Has default, optional on insert |
| `timestamp` | `ColumnType<Date, Date \| string, Date \| string>` | Accept string on write |

### Implementation

```typescript
// packages/cli/src/generators/kysely.ts
import type { Schema, ColumnDefinition } from '@db-semantic-planner/schema';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

export async function generateKysely(
  schema: Schema,
  outDir: string
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  
  // Generate types.ts
  const typesContent = generateKyselyTypes(schema);
  await writeFile(join(outDir, 'types.ts'), typesContent);
  
  // Generate DB.ts
  const dbContent = generateKyselyDB(schema);
  await writeFile(join(outDir, 'DB.ts'), dbContent);
}

function generateKyselyTypes(schema: Schema): string {
  const tables: string[] = [];
  let needsGenerated = false;
  let needsColumnType = false;
  
  for (const [tableName, tableDef] of Object.entries(schema.tables)) {
    const columns = Object.entries(tableDef)
      .map(([colName, colDef]) => {
        const { type, wrapper } = mapColumnToKyselyType(colDef);
        if (wrapper === 'Generated') needsGenerated = true;
        if (wrapper === 'ColumnType') needsColumnType = true;
        
        const nullable = colDef.nullable ? ' | null' : '';
        
        // Apply wrapper
        let finalType: string;
        if (wrapper === 'Generated') {
          finalType = `Generated<${type}${nullable}>`;
        } else if (wrapper === 'ColumnType') {
          // ColumnType<SelectType, InsertType, UpdateType>
          // For timestamps: accept Date or string on insert/update
          finalType = `ColumnType<${type}${nullable}, ${type} | string${nullable}, ${type} | string${nullable}>`;
        } else {
          finalType = `${type}${nullable}`;
        }
        
        return `  ${colName}: ${finalType};`;
      })
      .join('\n');
    
    tables.push(`export interface ${pascalCase(tableName)}Table {\n${columns}\n}`);
  }
  
  // Build imports
  const imports: string[] = [];
  if (needsGenerated) imports.push('Generated');
  if (needsColumnType) imports.push('ColumnType');
  
  const importLine = imports.length > 0
    ? `import type { ${imports.join(', ')} } from 'kysely';\n\n`
    : '';
  
  return `// Generated by dbsp generate kysely
// Do not edit manually

${importLine}${tables.join('\n\n')}
`;
}

function generateKyselyDB(schema: Schema): string {
  const tableNames = Object.keys(schema.tables);
  const imports = tableNames.map(n => `${pascalCase(n)}Table`).join(', ');
  const entries = tableNames
    .map(name => `  ${name}: ${pascalCase(name)}Table;`)
    .join('\n');
  
  return `// Generated by dbsp generate kysely
// Do not edit manually

import type { ${imports} } from './types.js';

export interface DB {
${entries}
}
`;
}

interface KyselyTypeMapping {
  type: string;
  wrapper?: 'Generated' | 'ColumnType';
}

function mapColumnToKyselyType(col: ColumnDefinition): KyselyTypeMapping {
  // Base type mapping
  const typeMap: Record<string, string> = {
    uuid: 'string',
    string: 'string',
    text: 'string',
    number: 'number',
    integer: 'number',
    bigint: 'bigint',
    decimal: 'string',  // Decimal as string for precision
    boolean: 'boolean',
    timestamp: 'Date',
    date: 'Date',
    json: 'unknown',
    jsonb: 'unknown',
  };
  
  const baseType = typeMap[col.type] ?? 'unknown';
  
  // Determine wrapper
  let wrapper: 'Generated' | 'ColumnType' | undefined;
  
  // Generated: for auto-generated values (primary key, defaults)
  if (col.primaryKey || col.default !== undefined) {
    wrapper = 'Generated';
  }
  // ColumnType: for timestamp/date to accept string on write
  else if (col.type === 'timestamp' || col.type === 'date') {
    wrapper = 'ColumnType';
  }
  
  return { type: baseType, wrapper };
}

function pascalCase(str: string): string {
  return str
    .split('_')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
```

### Generated Output Example

```typescript
// generated/kysely/types.ts
import type { Generated, ColumnType } from 'kysely';

export interface UsersTable {
  id: Generated<string>;                              // primaryKey → Generated
  name: string;
  email: string;
  createdAt: Generated<ColumnType<Date, Date | string, Date | string>>;  // default + timestamp
}

export interface PostsTable {
  id: Generated<string>;
  title: string;
  content: string | null;
  authorId: string;
  publishedAt: ColumnType<Date | null, Date | string | null, Date | string | null>;  // timestamp, nullable
}
```

### BDD Scenarios

```gherkin
Feature: Generate Kysely

  Scenario: Generate DB interface
    Given schema with tables "users" and "posts"
    When I run "dbsp generate kysely"
    Then DB.ts should export interface DB
    And DB should have properties "users" and "posts"

  Scenario: Primary key uses Generated
    Given table "users" with column id (uuid, primaryKey: true)
    When I run "dbsp generate kysely"
    Then UsersTable.id should be "Generated<string>"

  Scenario: Default value uses Generated
    Given table "users" with column createdAt (timestamp, default: 'now()')
    When I run "dbsp generate kysely"
    Then UsersTable.createdAt should include "Generated"

  Scenario: Timestamp uses ColumnType for string input
    Given table "posts" with column publishedAt (timestamp, nullable)
    When I run "dbsp generate kysely"
    Then PostsTable.publishedAt should be "ColumnType<Date | null, Date | string | null, Date | string | null>"

  Scenario: Imports are conditional
    Given schema with only simple string/number columns
    When I run "dbsp generate kysely"
    Then types.ts should NOT import Generated or ColumnType
```

---

## Block 6: Kysely Adapter Refactor

### Goal

Refactor existing adapter to use generated schema instead of runtime introspection.

### Changes

1. **Remove `introspectKysely`** from runtime path
2. **Accept pre-compiled schema** in `createOrm`
3. **SYNC API** (no I/O at startup → no need for async) - Adjustment #1

### API Decision: SYNC (Adjustment #1)

Since codegen-first means zero runtime introspection:
- No database calls at `createOrm()`
- No async I/O needed
- **Sync API = better DX** (no await required)

### New API

```typescript
// packages/kysely/src/index.ts
import type { Kysely } from 'kysely';
import type { Schema } from '@db-semantic-planner/schema';
import type { ModelIR } from '@db-semantic-planner/core/internal';

export interface CreateOrmOptions<DB> {
  /** Kysely database instance */
  db: Kysely<DB>;
  /** Pre-compiled schema from dbsp generate manifest */
  schema: Schema;
  /** Strict mode for ambiguity detection */
  strict?: boolean;
}

/**
 * Create ORM instance from pre-compiled schema.
 * 
 * SYNC: No database introspection, no I/O - just wiring.
 * 
 * @example
 * ```typescript
 * import { createOrm, eq } from 'db-semantic-planner/kysely';
 * import { schema } from './generated/dbsp/schema';
 * 
 * const orm = createOrm({ db, schema });  // No await needed!
 * const users = await orm.select('users').where(eq('active', true)).all();
 * ```
 */
export function createOrm<DB>(options: CreateOrmOptions<DB>): Orm<DB> {
  const { db, schema, strict = false } = options;
  
  // Build ModelIR from pre-compiled schema (sync, no I/O)
  const model = buildModelFromSchema(schema);
  
  // Create Kysely adapter
  const adapter = createKyselyAdapter(db);
  
  // Return ORM instance (sync)
  return createOrmInstance(model, adapter, { strict });
}

// Re-export filter helpers for convenience
export {
  eq, neq, gt, gte, lt, lte,
  like, isNull, isNotNull, inArray,
  and, or, not,
} from '@db-semantic-planner/core/internal';
```

### Migration from v1 API

```typescript
// v1 (BEFORE - runtime introspection, async)
const orm = await createOrm({ db, introspect: true });

// v2 (AFTER - codegen-first, SYNC)
import { schema } from './generated/dbsp/schema';
const orm = createOrm({ db, schema });  // No await!
```

### BDD Scenarios

```gherkin
Feature: Kysely Adapter Refactor

  Scenario: createOrm is synchronous
    Given a generated schema from "dbsp generate manifest"
    When I call createOrm({ db, schema })
    Then it should return Orm<DB> directly (not a Promise)
    And no database introspection should occur

  Scenario: createOrm with generated schema
    Given a generated schema from "dbsp generate manifest"
    When I call createOrm({ db, schema })
    Then it should return an Orm instance
    And no database introspection should occur

  Scenario: Full type inference
    Given schema with typed table "users" { id: uuid, name: string }
    When I query orm.select('users').columns(['id', 'name'])
    Then TypeScript should infer result as { id: string, name: string }[]

  Scenario: Relation navigation
    Given schema with "posts.author" → "users"
    When I query orm.select('posts').include('author')
    Then the query should include a join to "users"
```

---

## Block 7: `dbsp verify`

### Goal

Drift detection between SoT and real database.

### Type Compatibility Table (Adjustment #7)

PostgreSQL type mapping with error/warning severity:

| Schema Type | PostgreSQL Exact Match | Compatible (warning) | Incompatible (error) |
|-------------|------------------------|----------------------|----------------------|
| `uuid` | `uuid` | - | `text`, `varchar`, others |
| `string` | `character varying`, `varchar` | `text`, `char` | `integer`, `uuid` |
| `text` | `text` | `character varying` | `integer`, `uuid` |
| `integer` | `integer`, `int4` | `smallint`, `int2` | `bigint`, `text` |
| `number` | `numeric`, `decimal`, `real`, `double precision` | `integer` | `text`, `uuid` |
| `bigint` | `bigint`, `int8` | - | `integer` (precision loss), `text` |
| `boolean` | `boolean` | - | `text`, `integer` |
| `timestamp` | `timestamp without time zone` | `timestamp with time zone` | `date`, `text` |
| `date` | `date` | - | `timestamp`, `text` |
| `json` | `json` | `jsonb` | `text` |
| `jsonb` | `jsonb` | `json` | `text` |
| `decimal` | `numeric`, `decimal` | - | `integer`, `real` |

**Severity rules:**
- **Error**: Type fundamentally incompatible (data loss or runtime error)
- **Warning**: Type compatible but not exact (may have edge cases)

### Implementation

```typescript
// packages/cli/src/commands/verify.ts
import { Command } from 'commander';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Schema, ColumnType } from '@db-semantic-planner/schema';

export const verifyCommand = new Command('verify')
  .description('Verify schema matches database')
  .option('-s, --schema <path>', 'Schema file path', 'dbsp.schema.ts')
  .option('--db <url>', 'Database connection URL')
  .option('--strict', 'Treat warnings as errors', false)
  .action(async (options) => {
    const schema = await loadSchema(options.schema);
    const db = createDbConnection(options.db);
    
    const drift = await detectDrift(schema, db);
    
    for (const issue of drift) {
      const icon = issue.severity === 'error' ? '❌' : '⚠️';
      console.log(`${icon} ${issue.message}`);
    }
    
    const hasErrors = drift.some(d => d.severity === 'error');
    const hasWarnings = drift.some(d => d.severity === 'warning');
    
    if (hasErrors || (options.strict && hasWarnings)) {
      process.exit(1);
    } else if (drift.length === 0) {
      console.log('✅ Schema matches database');
    } else {
      console.log(`\n⚠️  ${drift.length} warnings (use --strict to fail on warnings)`);
    }
  });

interface DriftIssue {
  severity: 'error' | 'warning';
  message: string;
  table?: string;
  column?: string;
}

// Type compatibility configuration
interface TypeCompatibility {
  exact: string[];      // Exact matches (no issue)
  compatible: string[]; // Compatible but not exact (warning)
  // Everything else is incompatible (error)
}

const POSTGRES_TYPE_MAP: Record<ColumnType, TypeCompatibility> = {
  uuid: {
    exact: ['uuid'],
    compatible: [],
  },
  string: {
    exact: ['character varying', 'varchar'],
    compatible: ['text', 'character', 'char', 'bpchar'],
  },
  text: {
    exact: ['text'],
    compatible: ['character varying', 'varchar'],
  },
  integer: {
    exact: ['integer', 'int4', 'int'],
    compatible: ['smallint', 'int2'],
  },
  number: {
    exact: ['numeric', 'decimal', 'real', 'double precision', 'float4', 'float8'],
    compatible: ['integer', 'int4', 'smallint'],
  },
  bigint: {
    exact: ['bigint', 'int8'],
    compatible: [],  // integer → bigint is data loss risk
  },
  decimal: {
    exact: ['numeric', 'decimal'],
    compatible: [],
  },
  boolean: {
    exact: ['boolean', 'bool'],
    compatible: [],
  },
  timestamp: {
    exact: ['timestamp without time zone', 'timestamp'],
    compatible: ['timestamp with time zone', 'timestamptz'],
  },
  date: {
    exact: ['date'],
    compatible: [],
  },
  json: {
    exact: ['json'],
    compatible: ['jsonb'],
  },
  jsonb: {
    exact: ['jsonb'],
    compatible: ['json'],
  },
};

function checkTypeCompatibility(
  schemaType: ColumnType,
  dbType: string
): 'exact' | 'compatible' | 'incompatible' {
  const mapping = POSTGRES_TYPE_MAP[schemaType];
  if (!mapping) return 'incompatible';
  
  const normalizedDbType = dbType.toLowerCase();
  
  if (mapping.exact.includes(normalizedDbType)) return 'exact';
  if (mapping.compatible.includes(normalizedDbType)) return 'compatible';
  
  return 'incompatible';
}

async function detectDrift(schema: Schema, db: Kysely<any>): Promise<DriftIssue[]> {
  const issues: DriftIssue[] = [];
  const metadata = await db.introspection.getMetadata();
  const dbTables = new Map(metadata.tables.map(t => [t.name, t]));
  
  // Check tables in schema exist in DB
  for (const tableName of Object.keys(schema.tables)) {
    const dbTable = dbTables.get(tableName);
    if (!dbTable) {
      issues.push({
        severity: 'error',
        message: `Missing table: ${tableName} (in schema, not in DB)`,
        table: tableName,
      });
      continue;
    }
    
    // Check columns
    const schemaTable = schema.tables[tableName];
    const dbColumns = new Map(dbTable.columns.map(c => [c.name, c]));
    
    for (const [colName, colDef] of Object.entries(schemaTable)) {
      const dbCol = dbColumns.get(colName);
      if (!dbCol) {
        issues.push({
          severity: 'error',
          message: `Missing column: ${tableName}.${colName} (in schema, not in DB)`,
          table: tableName,
          column: colName,
        });
        continue;
      }
      
      // Type compatibility check
      const compatibility = checkTypeCompatibility(colDef.type, dbCol.dataType);
      
      if (compatibility === 'incompatible') {
        issues.push({
          severity: 'error',
          message: `Type mismatch: ${tableName}.${colName} (schema: ${colDef.type}, DB: ${dbCol.dataType})`,
          table: tableName,
          column: colName,
        });
      } else if (compatibility === 'compatible') {
        issues.push({
          severity: 'warning',
          message: `Type variance: ${tableName}.${colName} (schema: ${colDef.type}, DB: ${dbCol.dataType}) - compatible but not exact`,
          table: tableName,
          column: colName,
        });
      }
      // 'exact' → no issue
      
      // Nullability check
      if (colDef.nullable === false && dbCol.isNullable) {
        issues.push({
          severity: 'error',
          message: `Nullability mismatch: ${tableName}.${colName} (schema: NOT NULL, DB: nullable)`,
          table: tableName,
          column: colName,
        });
      } else if (colDef.nullable === true && !dbCol.isNullable) {
        issues.push({
          severity: 'warning',
          message: `Nullability mismatch: ${tableName}.${colName} (schema: nullable, DB: NOT NULL) - DB is stricter`,
          table: tableName,
          column: colName,
        });
      }
    }
    
    // Check for extra columns in DB
    for (const dbCol of dbTable.columns) {
      if (!(dbCol.name in schemaTable)) {
        issues.push({
          severity: 'warning',
          message: `Extra column: ${tableName}.${dbCol.name} (in DB, not in schema)`,
          table: tableName,
          column: dbCol.name,
        });
      }
    }
  }
  
  // Check for extra tables in DB (skip system tables)
  const systemTablePrefixes = ['pg_', '_prisma_', 'kysely_', '__'];
  for (const dbTable of metadata.tables) {
    const isSystemTable = systemTablePrefixes.some(p => dbTable.name.startsWith(p));
    if (!isSystemTable && !(dbTable.name in schema.tables)) {
      issues.push({
        severity: 'warning',
        message: `Extra table: ${dbTable.name} (in DB, not in schema)`,
        table: dbTable.name,
      });
    }
  }
  
  return issues;
}
```

### BDD Scenarios

```gherkin
Feature: Drift Detection

  Scenario: Schema matches database exactly
    Given schema and DB both have table "users" with columns id (uuid), name (varchar)
    When I run "dbsp verify"
    Then it should print "✅ Schema matches database"
    And exit code should be 0

  Scenario: Missing table in DB
    Given schema has table "posts" but DB does not
    When I run "dbsp verify"
    Then it should print "❌ Missing table: posts"
    And exit code should be 1

  Scenario: Extra column in DB (warning)
    Given schema has users.id, users.name but DB also has users.avatar
    When I run "dbsp verify"
    Then it should print "⚠️ Extra column: users.avatar"
    And exit code should be 0 (warnings don't fail)

  Scenario: Type mismatch - incompatible
    Given schema defines posts.id as "uuid" but DB has "text"
    When I run "dbsp verify"
    Then it should print "❌ Type mismatch: posts.id (schema: uuid, DB: text)"
    And exit code should be 1

  Scenario: Type variance - compatible but not exact (warning)
    Given schema defines users.created as "timestamp" but DB has "timestamptz"
    When I run "dbsp verify"
    Then it should print "⚠️ Type variance: users.created"
    And exit code should be 0

  Scenario: Strict mode treats warnings as errors
    Given schema has a type variance (timestamp vs timestamptz)
    When I run "dbsp verify --strict"
    Then exit code should be 1

  Scenario: Skip system tables
    Given DB has table "_prisma_migrations"
    And schema does not define it
    When I run "dbsp verify"
    Then it should NOT warn about "_prisma_migrations"
```

---

## Block 8: Update Tests

### Goal

Migrate all existing tests to use codegen-first API.

### Strategy

1. **Create test fixture schema** in `tests/fixtures/dbsp.schema.ts`
2. **Pre-generate** test manifests in `tests/fixtures/generated/`
3. **Update imports** in all test files
4. **Verify 100% test pass** with new API

### Test Fixture Schema

```typescript
// tests/fixtures/dbsp.schema.ts
import { defineSchema } from '@db-semantic-planner/schema';

export const testSchema = defineSchema({
  tables: {
    users: {
      id: { type: 'uuid', primaryKey: true },
      name: { type: 'string', nullable: false },
      email: { type: 'string', nullable: false },
    },
    posts: {
      id: { type: 'uuid', primaryKey: true },
      title: { type: 'string', nullable: false },
      authorId: { type: 'uuid', nullable: false },
    },
    comments: {
      id: { type: 'uuid', primaryKey: true },
      content: { type: 'text', nullable: false },
      postId: { type: 'uuid', nullable: false },
      userId: { type: 'uuid', nullable: false },
    },
  },
  relations: {
    'posts.author': { target: 'users', foreignKey: 'authorId' },
  },
});
```

### BDD Scenarios

```gherkin
Feature: Test Migration

  Scenario: All unit tests pass
    Given updated test files using codegen API
    When I run "pnpm test:unit"
    Then all tests should pass

  Scenario: All E2E tests pass
    Given updated E2E test files using codegen API
    When I run "pnpm test:e2e"
    Then all tests should pass

  Scenario: No runtime introspection in tests
    Given test file using createOrm({ db, schema })
    When the test runs
    Then no db.introspection calls should be made
```

---

## Implementation Plan

| Block | Description | Effort | Dependencies |
|-------|-------------|--------|--------------|
| 1 | Schema DSL | M | None |
| 2 | Convention Inference | S | Block 1 |
| 3 | CLI Scaffold | S | Block 1 |
| 4 | `dbsp generate manifest` | M | Block 1, 2, 3 |
| 5 | `dbsp generate kysely` | M | Block 1, 3 |
| 6 | Kysely Adapter Refactor | M | Block 4 |
| 7 | `dbsp verify` | M | Block 1, 3 |
| 8 | Update Tests | L | Block 4, 5, 6 |

**Total Estimate:** L (large - architectural change)

---

## Package Structure (Final)

```
packages/
├── core/                    # INTERNAL (private: true)
│   ├── src/
│   │   ├── model-ir.ts
│   │   ├── intent-ast.ts
│   │   ├── planner.ts
│   │   └── dx/
│   └── package.json         # "private": true
│
├── schema/                  # Schema DSL (public)
│   ├── src/
│   │   ├── define.ts
│   │   ├── types.ts
│   │   └── conventions.ts
│   └── package.json
│
├── cli/                     # CLI (public)
│   ├── src/
│   │   ├── index.ts
│   │   └── commands/
│   ├── bin/
│   │   └── dbsp.js
│   └── package.json
│
├── kysely/                  # Kysely adapter (public)
│   ├── src/
│   │   ├── index.ts
│   │   ├── adapter.ts
│   │   └── compiler.ts
│   └── package.json
│
└── adapter-kysely/          # DEPRECATED (keep for backward compat)
    └── package.json         # Re-exports from kysely/
```

---

## Success Criteria

1. **Zero runtime introspection** - no DB calls at createOrm()
2. **Full TypeScript types** - from schema definition to query results
3. **CLI generates valid code** - for Kysely and manifest targets
4. **Drift detection works** - catches schema/DB mismatches
5. **All existing tests pass** - 1217+ tests green with new API
6. **Adoption path exists** - `dbsp import` planned for future

---

## References

- [ARCH-002 Brief](../briefs/ARCH-002-one-ring.md)
- [ARCH-001: Dialect-Agnostic Architecture](./ARCH-001-dialect-agnostic-recursive.md)
- Drizzle Schema: https://orm.drizzle.team/docs/sql-schema-declaration
- Prisma Introspection: https://www.prisma.io/docs/concepts/components/introspection
