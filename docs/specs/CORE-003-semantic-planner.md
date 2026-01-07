---
doc-meta:
  status: draft
  scope: core
  type: specification
  created: 2026-01-07
  updated: 2026-01-07
---

# CORE-003: Semantic Planner Specification

## Overview

The Semantic Planner is the decision engine that transforms a `QueryIntent` into a `PlanReport`. It analyzes the query structure against the `ModelIR` schema and makes strategic decisions about:

1. **Filter Strategy**: EXISTS vs JOIN for relation-based filters
2. **Join Type**: LEFT vs INNER based on cardinality and optionality
3. **CTE Extraction**: Detecting repeated subqueries for optimization
4. **Ambiguity Detection**: Identifying when relation paths are unclear

**Package:** `packages/core`
**Consumes:** `QueryIntent`, `ModelIR`
**Produces:** `PlanReport`
**Enables:** Q1 (EXISTS filter), Q2 (CTE ratio), Q3 (ambiguity detection)

---

## Public API Signatures

### Core Types

```typescript
// packages/core/src/planner.ts

/**
 * Decision types made by the planner
 */
export type DecisionType =
  | 'filter-strategy'   // EXISTS vs JOIN for filtering
  | 'join-type'         // LEFT vs INNER
  | 'include-strategy'  // JOIN vs separate query for includes
  | 'cte-extraction'    // Extract repeated subquery to CTE
  | 'ambiguity';        // Multiple relations detected

/**
 * A single planning decision with full reasoning
 */
export interface PlanDecision {
  /** Unique identifier for the decision */
  readonly id: string;

  /** Type of decision */
  readonly type: DecisionType;

  /** Context: what triggered this decision */
  readonly context: {
    /** Source table in the decision */
    readonly sourceTable: string;
    /** Target table or relation name */
    readonly target?: string;
    /** Relation name if applicable */
    readonly relation?: string;
    /** Intent path (e.g., "where.exists.posts") */
    readonly intentPath?: string;
  };

  /** The choice made */
  readonly choice: string;

  /** Human-readable reasoning */
  readonly reasoning: string;

  /** Other options that were available */
  readonly alternatives: readonly string[];
}

/**
 * Warning codes for planning issues
 */
export type PlanWarningCode =
  | 'AMBIGUOUS_RELATION'        // Multiple relations to same target
  | 'POTENTIAL_ROW_EXPLOSION'   // JOIN on to-many without EXISTS
  | 'CIRCULAR_INCLUDE'          // Include cycle detected
  | 'MISSING_INDEX_HINT'        // Suggested index for performance
  | 'DEEP_NESTING';             // Deeply nested includes

/**
 * A warning about the query plan
 */
export interface PlanWarning {
  /** Warning code for programmatic handling */
  readonly code: PlanWarningCode;

  /** Human-readable message */
  readonly message: string;

  /** Suggested action to resolve */
  readonly suggestion?: string;

  /** Related decision ID if applicable */
  readonly relatedDecision?: string;
}

/**
 * CTE definition for extracted subqueries
 */
export interface CTEDefinition {
  /** CTE name (used in WITH clause) */
  readonly name: string;

  /** Purpose of this CTE */
  readonly purpose: string;

  /** Which query parts reference this CTE */
  readonly referencedBy: readonly string[];

  /** The intent fragment this CTE represents */
  readonly sourceIntent: string;
}

/**
 * Complete plan report
 */
export interface PlanReport {
  /** Root table for the query */
  readonly rootTable: string;

  /** All decisions made during planning */
  readonly decisions: readonly PlanDecision[];

  /** Warnings about the plan */
  readonly warnings: readonly PlanWarning[];

  /** CTEs to be extracted */
  readonly ctes: readonly CTEDefinition[];

  /** Original intent (for reference) */
  readonly intent: QueryIntent;

  /** Planning metadata */
  readonly metadata: {
    /** Planning duration in ms */
    readonly planningTimeMs: number;
    /** Number of relations traversed */
    readonly relationsAnalyzed: number;
    /** Whether the plan is ambiguous */
    readonly isAmbiguous: boolean;
    /** Ambiguous relation options (if isAmbiguous) */
    readonly ambiguousOptions?: readonly string[];
  };
}

/**
 * Planning options for customization
 */
export interface PlanOptions {
  /**
   * Force a specific filter strategy (overrides auto-detection)
   */
  forceFilterStrategy?: 'exists' | 'join';

  /**
   * Force a specific join type (overrides auto-detection)
   */
  forceJoinType?: 'left' | 'inner';

  /**
   * Enable CTE extraction for repeated subqueries
   * @default true
   */
  enableCTEs?: boolean;

  /**
   * Threshold for CTE extraction (min references)
   * @default 2
   */
  cteThreshold?: number;

  /**
   * Maximum include depth before warning
   * @default 5
   */
  maxIncludeDepth?: number;

  /**
   * Disambiguation hints for ambiguous relations
   * Map of "sourceTable.targetTable" -> relation name
   */
  disambiguate?: Record<string, string>;
}
```

### Planner Function

```typescript
/**
 * Create a query plan from an intent and model
 *
 * @param intent - The query intent to plan
 * @param model - The model IR for schema information
 * @param options - Optional planning configuration
 * @returns A complete plan report
 * @throws {AmbiguousPlanError} If relations are ambiguous and no disambiguation provided
 */
export function plan(
  intent: QueryIntent,
  model: ModelIR,
  options?: PlanOptions
): PlanReport;

/**
 * Error thrown when plan cannot be created due to ambiguity
 */
export class AmbiguousPlanError extends Error {
  constructor(
    /** Source table */
    readonly sourceTable: string,
    /** Target table */
    readonly targetTable: string,
    /** Available relation options */
    readonly options: readonly string[]
  );
}
```

---

## Deterministic Rules

### Filter Strategy Selection

When `filterStrategy` is `'auto'` in RelationIR or not specified:

| Cardinality | Filter Type | Default Strategy | Reasoning |
|-------------|-------------|------------------|-----------|
| `'one'` | exists/notExists | `join` | No row multiplication risk |
| `'many'` | exists/notExists | `exists` | Avoids row explosion |
| `'one'` | relationFilter | `join` | Efficient for single row |
| `'many'` | relationFilter (some) | `exists` | EXISTS is most efficient |
| `'many'` | relationFilter (every) | `not exists NOT` | Double negation pattern |
| `'many'` | relationFilter (none) | `not exists` | Direct NOT EXISTS |

**Decision Output Example:**
```typescript
{
  id: 'filter-001',
  type: 'filter-strategy',
  context: {
    sourceTable: 'products',
    relation: 'images',
    intentPath: 'where.exists'
  },
  choice: 'exists',
  reasoning: 'Relation products.images has cardinality "many" - using EXISTS to avoid row explosion',
  alternatives: ['join']
}
```

### Join Type Selection

When `joinDefault` is `'auto'`:

| Optionality | Has Filter on Relation | Join Type | Reasoning |
|-------------|------------------------|-----------|-----------|
| `'required'` | Any | `INNER` | Required relation must exist |
| `'optional'` | No | `LEFT` | Optional relation may not exist |
| `'optional'` | Yes | `INNER` | Filter implies existence |

**Decision Output Example:**
```typescript
{
  id: 'join-001',
  type: 'join-type',
  context: {
    sourceTable: 'products',
    target: 'categories',
    relation: 'category'
  },
  choice: 'left',
  reasoning: 'Relation products.category is optional with no filter - using LEFT JOIN to preserve products without category',
  alternatives: ['inner']
}
```

### Include Strategy Selection

When `includeStrategy` is `'auto'`:

| Cardinality | Default Strategy | Reasoning |
|-------------|------------------|-----------|
| `'one'` | `join` | Single row, efficient to join |
| `'many'` | `separate` | Avoid row multiplication |

### CTE Extraction Rules

1. **Trigger**: Same relation path accessed multiple times
2. **Threshold**: At least `cteThreshold` references (default: 2)
3. **Naming**: `cte_<table>_<relation>` or user-provided alias

**Example triggering CTE:**
```typescript
// Intent: Products with active count AND inactive count from same relation
{
  from: 'categories',
  include: [
    { relation: 'products', where: { field: 'active', operator: 'eq', value: true } },
    { relation: 'products', where: { field: 'active', operator: 'eq', value: false } },
  ]
}

// CTE extracted:
{
  name: 'cte_products',
  purpose: 'Products accessed 2 times with different filters',
  referencedBy: ['include[0]', 'include[1]'],
  sourceIntent: 'categories.products'
}
```

### Ambiguity Detection Rules

1. **Trigger**: Source table has multiple relations to same target table
2. **Resolution**: Check `via` in IncludeIntent or `disambiguate` in options
3. **Error**: Throw `AmbiguousPlanError` if unresolved

**Example:**
```typescript
// Schema: users.createdPosts, users.editedPosts both target posts
const model = defineSchema({...})
  .relations({
    users: {
      createdPosts: hasMany('posts', { foreignKey: 'createdById' }),
      editedPosts: hasMany('posts', { foreignKey: 'editedById' }),
    }
  })
  .build();

// Ambiguous intent (no via specified)
const intent: QueryIntent = {
  type: 'select',
  from: 'users',
  include: [{ relation: 'posts' }]  // Which relation?
};

// Throws AmbiguousPlanError with options: ['createdPosts', 'editedPosts']
```

---

## Minimal Examples

### Basic Planning

```typescript
import { plan } from '@db-semantic-planner/core';

const intent: QueryIntent = {
  type: 'select',
  from: 'products',
  where: {
    kind: 'exists',
    relation: 'images',
    where: { kind: 'comparison', field: 'approved', operator: 'eq', value: true }
  }
};

const report = plan(intent, schema);

console.log(report.rootTable);
// 'products'

console.log(report.decisions[0]);
// {
//   id: 'filter-001',
//   type: 'filter-strategy',
//   context: { sourceTable: 'products', relation: 'images', intentPath: 'where.exists' },
//   choice: 'exists',
//   reasoning: 'Relation products.images has cardinality "many" - using EXISTS...',
//   alternatives: ['join']
// }
```

### Planning with Includes

```typescript
const intent: QueryIntent = {
  type: 'select',
  from: 'products',
  include: [
    { relation: 'category' },
    { relation: 'images', where: { kind: 'comparison', field: 'locale', operator: 'eq', value: 'en' } }
  ]
};

const report = plan(intent, schema);

// Decisions will include:
// 1. include-strategy for 'category' -> 'join' (cardinality: one)
// 2. include-strategy for 'images' -> 'separate' (cardinality: many)
// 3. join-type for 'category' -> 'left' (optional, no filter)
```

### Handling Ambiguity

```typescript
// Option 1: Use 'via' in intent
const intent: QueryIntent = {
  type: 'select',
  from: 'users',
  include: [{ relation: 'posts', via: 'createdPosts' }]
};

// Option 2: Use disambiguate in options
const report = plan(intent, schema, {
  disambiguate: { 'users.posts': 'createdPosts' }
});

// Option 3: Catch and handle error
try {
  const report = plan(ambiguousIntent, schema);
} catch (e) {
  if (e instanceof AmbiguousPlanError) {
    console.log(`Ambiguous: ${e.options.join(' or ')}`);
    // Let user choose, then retry with via or disambiguate
  }
}
```

### CTE Extraction

```typescript
const intent: QueryIntent = {
  type: 'select',
  from: 'categories',
  select: { type: 'fields', fields: ['name'] },
  include: [
    { relation: 'products', where: { kind: 'comparison', field: 'active', operator: 'eq', value: true } },
    { relation: 'products', where: { kind: 'comparison', field: 'active', operator: 'eq', value: false } }
  ]
};

const report = plan(intent, schema, { enableCTEs: true, cteThreshold: 2 });

console.log(report.ctes[0]);
// {
//   name: 'cte_products',
//   purpose: 'Products relation accessed 2 times',
//   referencedBy: ['include[0]', 'include[1]'],
//   sourceIntent: 'categories.products'
// }
```

---

## Acceptance Tests Mapping

| Golden Test | Planner Component | Validation |
|-------------|-------------------|------------|
| Q1 | `filter-strategy` decision | `choice: 'exists'` for hasMany with filter |
| Q2 | CTE extraction | `ctes.length >= 1` for ratio query |
| Q3 | Ambiguity detection | `AmbiguousPlanError` thrown or warning |

### Q1: EXISTS Filter Strategy

```typescript
describe('Q1: EXISTS filter for to-many relations', () => {
  it('should choose EXISTS strategy for hasMany filter', () => {
    const intent: QueryIntent = {
      type: 'select',
      from: 'products',
      where: {
        kind: 'exists',
        relation: 'images',
        where: {
          kind: 'and',
          conditions: [
            { kind: 'comparison', field: 'locale', operator: 'eq', value: 'en' },
            { kind: 'comparison', field: 'type', operator: 'eq', value: 'thumbnail' },
            { kind: 'comparison', field: 'approved', operator: 'eq', value: true }
          ]
        }
      }
    };

    const report = plan(intent, q1Schema);

    const filterDecision = report.decisions.find(d => d.type === 'filter-strategy');
    expect(filterDecision?.choice).toBe('exists');
    expect(report.warnings.some(w => w.code === 'POTENTIAL_ROW_EXPLOSION')).toBe(false);
  });
});
```

### Q2: CTE Extraction for Ratios

```typescript
describe('Q2: CTE extraction for ratio calculations', () => {
  it('should extract CTE when same relation accessed multiple times', () => {
    const intent: QueryIntent = {
      type: 'select',
      from: 'categories',
      select: { type: 'fields', fields: ['name'] },
      // Simulate: active_count, total_count from products
      include: [
        { relation: 'products', where: { kind: 'comparison', field: 'active', operator: 'eq', value: true } },
        { relation: 'products' }  // All products for total
      ]
    };

    const report = plan(intent, q2Schema, { enableCTEs: true });

    expect(report.ctes.length).toBeGreaterThanOrEqual(1);
    expect(report.ctes[0].name).toContain('products');
    expect(report.ctes[0].referencedBy.length).toBe(2);
  });
});
```

### Q3: Ambiguity Detection

```typescript
describe('Q3: Ambiguity detection', () => {
  it('should throw AmbiguousPlanError when multiple relations exist', () => {
    const intent: QueryIntent = {
      type: 'select',
      from: 'users',
      include: [{ relation: 'posts' }]  // Ambiguous: createdPosts or editedPosts?
    };

    expect(() => plan(intent, q3Schema)).toThrow(AmbiguousPlanError);
  });

  it('should return options in error', () => {
    try {
      plan(ambiguousIntent, q3Schema);
    } catch (e) {
      expect(e).toBeInstanceOf(AmbiguousPlanError);
      expect((e as AmbiguousPlanError).options).toEqual(['createdPosts', 'editedPosts']);
    }
  });

  it('should resolve with via hint', () => {
    const intent: QueryIntent = {
      type: 'select',
      from: 'users',
      include: [{ relation: 'posts', via: 'createdPosts' }]
    };

    const report = plan(intent, q3Schema);
    expect(report.metadata.isAmbiguous).toBe(false);
  });
});
```

---

## Implementation Notes

### Algorithm Complexity

- **Filter Strategy**: O(1) per relation - direct lookup in RelationIR
- **Join Type**: O(1) per join - based on optionality + filter presence
- **CTE Detection**: O(n) where n = number of include/where clauses
- **Ambiguity Check**: O(r) where r = relations from source table

### Intent Traversal

The planner walks the intent tree depth-first:

```
QueryIntent
├── where (if exists)
│   └── traverse all conditions, detect relation-based filters
├── include (if exists)
│   └── for each: analyze relation, recurse into nested includes
└── metadata collection
```

### Decision ID Generation

Pattern: `{type}-{3-digit-counter}`

Examples:
- `filter-001`, `filter-002`
- `join-001`
- `cte-001`

### State Management

The planner is **stateless** - each call to `plan()` creates fresh state. No caching between calls.

---

## File Structure

```
packages/core/src/
├── planner.ts         # plan() function, PlanReport, PlanDecision types
├── planner-impl.ts    # Internal planner implementation
├── planner.test.ts    # Unit tests for planner
└── index.ts           # Export plan, types, AmbiguousPlanError
```

---

## Related Specs

- CORE-001-model-ir.md (provides ModelIR for schema info)
- CORE-002-intent-ast.md (provides QueryIntent input)
- ADAPTER-001-kysely-dump-compile-execute.md (consumes PlanReport)
