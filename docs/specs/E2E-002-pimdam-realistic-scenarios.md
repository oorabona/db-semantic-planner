---
doc-meta:
  status: draft
  scope: e2e
  type: specification
  created: 2026-01-08
  updated: 2026-01-08
---

# Specification: E2E-002 PIM/DAM Realistic Scenarios

## 1. User Stories

### US-1: API Validation for PIM/DAM Use Cases
```
AS A developer evaluating db-semantic-planner
I WANT to see realistic PIM/DAM queries implemented
SO THAT I can validate the API handles real enterprise scenarios
```
ACCEPTANCE: 10 distinct PIM/DAM use cases implemented as E2E tests

### US-2: Expression Support (COALESCE/CASE)
```
AS A developer building locale-fallback features
I WANT to use COALESCE expressions in my queries
SO THAT I can implement "FR with EN fallback" patterns declaratively
```
ACCEPTANCE: coalesce() helper available, compiles to COALESCE SQL

### US-3: Simple Learning Curve
```
AS A developer or AI agent
I WANT query patterns to be intuitive and well-documented
SO THAT I can implement complex queries without deep framework knowledge
```
ACCEPTANCE: Each E2E test demonstrates a clear pattern with comments

---

## 2. Business Rules

### BR-1: Expression System
- COALESCE expressions MUST support N fields with fallback chain
- Expressions MUST be usable in SELECT and WHERE clauses
- Expression aliases MUST be required for clarity
- Expressions MUST NOT break existing filter semantics

### BR-2: Schema Extensions
- Required attributes MUST be stored in family/channel/locale structure
- Bundle components MUST support recursive BOM patterns
- Variant images MUST use junction table with locale support
- Multi-tenant isolation MUST use PostgreSQL schema separation

### BR-3: Query Patterns
- EXISTS strategy MUST be default for to-many filtering
- CTE strategy MUST be used for completeness ratio calculations
- Materialized path MUST be supported for category tree queries
- via/role disambiguation MUST work with junction tables

---

## 3. Technical Impact

### Layer: packages/core
| Change | Description |
|--------|-------------|
| SelectExpressionIntent | New intent type for COALESCE/CASE |
| ExpressionIntent | Union type for expression kinds |

### Layer: packages/adapter-kysely
| Change | Description |
|--------|-------------|
| compileExpression() | Compile expressions to Kysely SQL |
| CTE extraction | Handle expression in CTE subqueries |

### Layer: packages/dx
| Change | Description |
|--------|-------------|
| coalesce() helper | Create COALESCE expression intent |
| caseWhen() helper | Create CASE WHEN expression intent (future) |
| QueryBuilder updates | Support expressions in select/where |

### Layer: tests/e2e
| Change | Description |
|--------|-------------|
| Schema extensions | Add families, channels, locales, bundle_components, variant_images |
| 10 test files | One per PIM/DAM scenario |

---

## 4. Acceptance Criteria (BDD Scenarios)

### Q1: Completeness Akeneo-like (family + channel + locale)

```gherkin
Scenario: Q1-01 Calculate attribute completeness ratio per product
  Given a "phones" family requiring attributes [name, description, specs]
  And channel "ecommerce" with locale "fr_FR"
  And product "iphone-15" with name (FR), description (FR), no specs
  When I query products with completeness calculation
  Then product "iphone-15" should show completeness 66% (2/3 attributes)

Scenario: Q1-02 Filter products by completeness threshold
  Given products with varying completeness levels
  When I filter products where completeness >= 80%
  Then only products with 80%+ filled required attributes are returned

Scenario: Q1-03 Multi-channel completeness
  Given product "iphone-15" complete for "web" but incomplete for "print"
  When I query completeness by channel
  Then web channel shows 100%, print channel shows 50%
```

### Q2: Working Context with Locale Fallback (COALESCE)

```gherkin
Scenario: Q2-01 Product name with FR->EN fallback
  Given product "widget" with name_en "Widget" and name_fr NULL
  When I query with coalesce(name_fr, name_en) as display_name
  Then display_name should be "Widget" (English fallback)

Scenario: Q2-02 Product name with FR primary
  Given product "gadget" with name_en "Gadget" and name_fr "Bidule"
  When I query with coalesce(name_fr, name_en) as display_name
  Then display_name should be "Bidule" (French primary)

Scenario: Q2-03 Multi-level fallback chain
  Given product with name_fr NULL, name_en NULL, name_default "Default Name"
  When I query with coalesce(name_fr, name_en, name_default) as display_name
  Then display_name should be "Default Name"

Scenario: Q2-04 Filter by coalesced value
  Given products with various locale combinations
  When I filter where coalesce(name_fr, name_en) LIKE '%phone%'
  Then products matching in either FR or EN name are returned
```

### Q3: Variants with Image per Variant (Shopify-like)

```gherkin
Scenario: Q3-01 Load product with variants and their images
  Given product "t-shirt" with variants [S, M, L]
  And each variant has locale-specific images (fr_FR, en_US)
  When I query product with include(variants, include(images))
  Then each variant has its images nested correctly

Scenario: Q3-02 Filter variants by stock availability
  Given product with variants, some in stock, some out
  When I query product with include(variants, where: stock > 0)
  Then only in-stock variants are included

Scenario: Q3-03 Variant image with locale fallback
  Given variant "t-shirt-M" with image_fr NULL, image_en "shirt-m-en.jpg"
  When I query with coalesce for variant images
  Then variant shows English image as fallback
```

### Q4: Assets Expiring + Used by Published Products

```gherkin
Scenario: Q4-01 Find expiring assets used by active products
  Given asset "hero.jpg" expiring in 30 days
  And asset linked to active published product
  When I query assets where expires_at < now()+30d AND exists(products, active=true)
  Then "hero.jpg" is in results

Scenario: Q4-02 Exclude assets used only by draft products
  Given asset "draft-img.jpg" used only by draft products
  And asset "live-img.jpg" used by at least one published product
  When I query expiring assets with active product filter
  Then only "live-img.jpg" is returned

Scenario: Q4-03 Join with product details
  Given expiring assets
  When I query with include(productImages, include(product))
  Then results show which products use each expiring asset
```

### Q5: Unused Assets (NOT EXISTS)

```gherkin
Scenario: Q5-01 Find assets not linked to any product
  Given asset "orphan.jpg" with no product_images records
  And asset "used.jpg" linked to products
  When I query assets where notExists(productImages)
  Then only "orphan.jpg" is returned

Scenario: Q5-02 Find assets not used by active products
  Given asset used only by deleted products
  When I query assets where notExists(productImages, where: product.deleted_at IS NULL)
  Then asset is considered "unused" (for cleanup purposes)

Scenario: Q5-03 Count unused assets by kind
  Given various unused assets of different kinds (image, video, document)
  When I query with count(), groupBy(kind), where notExists(productImages)
  Then I get count per asset kind for cleanup planning
```

### Q6: Category Tree / Subtree (Materialized Path)

```gherkin
Scenario: Q6-01 Find all products in category subtree
  Given category "Electronics" (path: /1/) with child "Phones" (path: /1/2/)
  And products in both categories
  When I query products where category.path LIKE '/1/%'
  Then products from Electronics and all descendants are returned

Scenario: Q6-02 Get category breadcrumb
  Given category "Smartphones" with path /1/2/3/
  When I query categories where path is prefix of '/1/2/3/'
  Then I get [Electronics, Phones, Smartphones] for breadcrumb

Scenario: Q6-03 Count products per category with descendants
  Given hierarchical categories with products at various levels
  When I query category product counts including descendants
  Then each category shows total products in subtree
```

### Q7: BOM / Bundles

```gherkin
Scenario: Q7-01 Calculate bundle total price from components
  Given bundle "starter-kit" with components:
    - Product A (qty: 2, price: 1000)
    - Product B (qty: 1, price: 500)
  When I query bundle with computed total
  Then total_price = 2*1000 + 1*500 = 2500

Scenario: Q7-02 Check bundle component availability
  Given bundle with multiple components
  And some components out of stock
  When I query bundle with exists(components, where: stock = 0)
  Then bundles with out-of-stock components are flagged

Scenario: Q7-03 Recursive BOM (multi-level)
  Given bundle containing another bundle as component
  When I query with recursive component expansion
  Then all leaf products are listed with total quantities
```

### Q8: Ambiguous Relations (via/role)

```gherkin
Scenario: Q8-01 Product with author and reviewer (same User table)
  Given product with author_id=1 and reviewer_id=2
  And User table contains both users
  When I query product.include('author', via: 'author')
  Then author (user 1) is loaded, not reviewer

Scenario: Q8-02 Multiple relations to same junction table
  Given product_assets junction with role column (main, gallery, thumbnail)
  When I query product.include('assets', via: 'mainImage')
  Then only assets with role='main' are included

Scenario: Q8-03 Strict mode throws on ambiguity without via
  Given orm in strict mode
  And product with multiple user relations
  When I query product.include('users') without via
  Then AmbiguousRelationError is thrown with helpful message
```

### Q9: Multi-tenant Concurrency

```gherkin
Scenario: Q9-01 Tenant isolation via PostgreSQL schemas
  Given tenants "acme" and "globex" with separate schemas
  And both have products table with different data
  When I query orm.forTenant('acme').query('products').findMany()
  Then only ACME products are returned (schema: acme.products)

Scenario: Q9-02 Concurrent tenant queries
  Given 3 concurrent queries from different tenants
  When all execute simultaneously
  Then each returns only its tenant's data (no cross-contamination)

Scenario: Q9-03 Tenant schema name validation
  Given attempt to use invalid schema name "'; DROP TABLE--"
  When I call orm.forTenant(maliciousName)
  Then InvalidIdentifierError is thrown (SQL injection prevented)
```

### Q10: Capabilities Gating

```gherkin
Scenario: Q10-01 PostgreSQL supports all features
  Given PostgreSQL dialect
  When I query using COALESCE, CTE, EXISTS
  Then query executes successfully

Scenario: Q10-02 SQLite graceful degradation
  Given SQLite dialect
  When I query using COALESCE (supported)
  Then query executes (SQLite supports COALESCE)

Scenario: Q10-03 Unsupported feature throws helpful error
  Given dialect without LATERAL support
  When I attempt query requiring LATERAL
  Then UnsupportedCapabilityError is thrown with alternative suggestion
```

---

## 5. Implementation Plan

### Block 1: Core Expression Types (S)

**Packages:** packages/core

**Files to modify:**
- `src/intent-ast.ts` - Add expression intent types

**New types:**
```typescript
export type ExpressionKind = 'coalesce' | 'case' | 'raw';

export interface CoalesceExpressionIntent {
  readonly kind: 'coalesce';
  readonly fields: readonly string[];
  readonly as: string;
}

export interface SelectExpressionIntent {
  readonly type: 'expression';
  readonly expression: ExpressionIntent;
}

export type ExpressionIntent = CoalesceExpressionIntent; // extensible later
```

**Tests:** Unit tests for type guards

**Acceptance criteria:** Q2 types ready

**Dependencies:** None

---

### Block 2: Adapter Expression Compiler (M)

**Packages:** packages/adapter-kysely

**Files to modify:**
- `src/compiler.ts` - Add compileExpression()

**Implementation:**
```typescript
function compileExpression(expr: ExpressionIntent): RawBuilder<unknown> {
  switch (expr.kind) {
    case 'coalesce':
      return sql`COALESCE(${sql.join(
        expr.fields.map(f => sql.ref(f)),
        sql`, `
      )})`;
  }
}
```

**Tests:** Compiler tests for expression SQL generation

**Acceptance criteria:** Q2 SQL compiles correctly

**Dependencies:** Block 1

---

### Block 3: DX Expression Helpers (S)

**Packages:** packages/dx

**Files to modify:**
- `src/filters.ts` - Add coalesce() helper
- `src/types.ts` - Update QueryBuilder interface

**New exports:**
```typescript
export function coalesce(fields: string[], as: string): CoalesceExpressionIntent {
  return { kind: 'coalesce', fields, as };
}
```

**Tests:** Unit tests for helper

**Acceptance criteria:** Q2 helper available

**Dependencies:** Block 1

---

### Block 4: Schema Extensions for PIM/DAM (M)

**Packages:** tests/e2e

**Files to create:**
- `testkit/pimdam-extended.model.ts` - Extended schema

**New tables:**
- `families` - Product families with required attributes
- `channels` - Sales channels
- `locales` - Supported locales
- `family_attributes` - Required attributes per family/channel/locale
- `product_attributes` - Actual product attribute values
- `bundle_components` - BOM junction table
- `variant_images` - Variant-specific images with locale

**Dependencies:** None (parallel with Block 1-3)

---

### Block 5: Q1 Completeness Tests (M)

**Packages:** tests/e2e

**Files to create:**
- `pimdam.q1.completeness.test.ts`

**Scenarios covered:** Q1-01, Q1-02, Q1-03

**Strategy:** CTE for ratio calculation

**Dependencies:** Block 4

---

### Block 6: Q2 Locale Fallback Tests (M)

**Packages:** tests/e2e

**Files to create:**
- Tests already partially exist in `pimdam.q2.cte-multilocale.test.ts`
- Extend with COALESCE scenarios

**Scenarios covered:** Q2-01, Q2-02, Q2-03, Q2-04

**Dependencies:** Blocks 1, 2, 3, 4

---

### Block 7: Q3-Q5 Asset/Variant Tests (M)

**Packages:** tests/e2e

**Files to create/modify:**
- `pimdam.q3.variants.test.ts`
- `pimdam.q4.expiring-assets.test.ts` (expand existing)
- `pimdam.q5.unused-assets.test.ts`

**Scenarios covered:** Q3-*, Q4-*, Q5-*

**Dependencies:** Block 4

---

### Block 8: Q6 Category Tree Tests (S)

**Packages:** tests/e2e

**Files to create:**
- `pimdam.q6.category-tree.test.ts`

**Scenarios covered:** Q6-01, Q6-02, Q6-03

**Strategy:** Materialized path with LIKE queries

**Dependencies:** Block 4

---

### Block 9: Q7 BOM/Bundle Tests (M)

**Packages:** tests/e2e

**Files to create:**
- `pimdam.q7.bundles.test.ts`

**Scenarios covered:** Q7-01, Q7-02, Q7-03

**Strategy:** SUM aggregates with GROUP BY

**Dependencies:** Block 4

---

### Block 10: Q8 Ambiguity Tests (S)

**Packages:** tests/e2e

**Files to create:**
- `pimdam.q8.ambiguity.test.ts`

**Scenarios covered:** Q8-01, Q8-02, Q8-03

**Strategy:** via/role disambiguation

**Dependencies:** Block 4

---

### Block 11: Q9 Multi-tenant Tests (Exists)

**Packages:** tests/e2e

**Files:** Already implemented in `pimdam.q4.multitenant.test.ts`

**Scenarios covered:** Q9-01, Q9-02, Q9-03

**Dependencies:** None (verify existing coverage)

---

### Block 12: Q10 Capabilities Tests (Exists)

**Packages:** tests/e2e

**Files:** Already partially covered by dialect tests

**Scenarios covered:** Q10-01, Q10-02, Q10-03

**Dependencies:** None (verify and extend if needed)

---

## 6. Test Strategy

### Test Matrix

| Scenario | Unit | Integration | E2E |
|----------|------|-------------|-----|
| Q1 Completeness | - | - | Yes |
| Q2 Locale Fallback | Yes (helpers) | Yes (compiler) | Yes |
| Q3 Variants | - | - | Yes |
| Q4 Expiring Assets | - | - | Yes |
| Q5 Unused Assets | - | - | Yes |
| Q6 Category Tree | - | - | Yes |
| Q7 BOM/Bundles | - | - | Yes |
| Q8 Ambiguity | Yes (dx) | - | Yes |
| Q9 Multi-tenant | - | - | Yes (exists) |
| Q10 Capabilities | Yes (dialect) | - | Yes |

### Test Data Strategy

**Fixtures:**
- Extended PIM/DAM seed data
- Multi-tenant schema setup
- Locale-specific attribute values

**Test isolation:**
- Each test file uses transaction rollback
- Tenant tests use separate schemas

---

## 7. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| COALESCE in WHERE breaks planner | HIGH | Unit test WHERE expression compilation |
| CTE extraction with expressions | MEDIUM | Test CTE + expression combination |
| Schema migration for tests | LOW | Use test-only extended schema |

---

## Definition of Done

- [ ] All 12 blocks implemented
- [ ] All 31 BDD scenarios have passing tests
- [ ] Unit tests for expression helpers (coalesce)
- [ ] Integration tests for expression compilation
- [ ] All existing tests still pass
- [ ] Lint/typecheck pass
- [ ] Documentation updated (filters.ts JSDoc)
