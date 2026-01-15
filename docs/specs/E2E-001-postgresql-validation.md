---
doc-meta:
  status: canonical
  scope: testing
  type: specification
  created: 2026-01-07
  updated: 2026-01-07
---

# Specification: E2E-001 Real-world PostgreSQL Validation

## 1. User Stories

### US1: Full Vertical Slice Validation
**AS A** library maintainer
**I WANT** E2E tests running against real PostgreSQL
**SO THAT** I can validate the entire stack works correctly before release

**ACCEPTANCE:** Tests execute against Testcontainers PostgreSQL and verify real results

### US2: Multi-tenant Isolation
**AS A** SaaS developer using this library
**I WANT** to verify tenant isolation works correctly
**SO THAT** I can trust the library for production multi-tenant apps

**ACCEPTANCE:** Same query on different tenants returns different results

### US3: Observability Validation
**AS A** DevOps engineer
**I WANT** to verify dump() and explain() work on real PostgreSQL
**SO THAT** I can trust the observability features in production

**ACCEPTANCE:** `dump()` returns complete Dump, `explain()` returns real query plans

---

## 2. Business Rules

### Infrastructure
- **BR1:** Tests MUST use Testcontainers for PostgreSQL (no external dependencies)
- **BR2:** Tests MUST skip gracefully if Docker is unavailable
- **BR3:** Single container shared across all test files (performance)
- **BR4:** Container cleanup MUST happen in globalTeardown

### Multi-tenant
- **BR5:** Two tenant schemas: `acme` and `globex`
- **BR6:** Same DDL applied to both schemas
- **BR7:** Different seed data to validate isolation
- **BR8:** Invalid schema names MUST throw `InvalidIdentifierError`

### API Contract
- **BR9:** `dump()` MUST return `{ plan, sql, params, meta }`
- **BR10:** `execute()` MUST be alias for `findMany()` (semantic clarity)
- **BR11:** SQL output MUST be deterministic (stable aliasing t0, t1...)
- **BR12:** All queries MUST use explicit `orderBy` for deterministic results

---

## 3. Technical Impact

| Layer | Changes | Validation |
|-------|---------|------------|
| `packages/dx` | Add `dump()`, `execute()` to QueryBuilder | Unit tests + E2E |
| `tests/e2e/` | New directory with Testcontainers setup | E2E pass |
| `package.json` | Add testcontainers, pg devDependencies | Build succeeds |
| Root config | Add `test:e2e` script | Script works |

---

## 4. Acceptance Criteria (BDD Scenarios)

### Feature: DX-004 QueryBuilder.dump() and execute()

```gherkin
Scenario: dump() returns complete Dump object
  Given an ORM instance with db configured
  And a query for "products" with where eq('active', true)
  When dump() is called
  Then result contains plan with rootTable "products"
  And result contains sql starting with "SELECT"
  And result contains params array with [true]
  And result contains meta with compiledAt timestamp

Scenario: execute() is alias for findMany()
  Given an ORM instance with db configured
  And a query for "users"
  When execute() is called
  Then result is same as calling findMany()

Scenario: dump() includes tenant in meta for forTenant()
  Given an ORM instance with db configured
  And forTenant('acme') is called
  And a query for "products"
  When dump() is called
  Then result.meta.tenant equals "acme"
  And result.sql contains '"acme"."products"'
```

### Feature: Test Infrastructure

```gherkin
Scenario: PostgreSQL container starts successfully
  Given Docker is available
  When globalSetup runs
  Then PostgreSQL container is running
  And DATABASE_URL environment variable is set
  And connection can be established

Scenario: Tests skip when Docker unavailable
  Given Docker is NOT available
  When E2E tests attempt to run
  Then tests are skipped with clear message
  And no errors are thrown

Scenario: Container cleanup on teardown
  Given PostgreSQL container is running
  When globalTeardown runs
  Then container is stopped and removed
```

### Feature: Q1 - Products with Approved FR Main Image (EXISTS)

```gherkin
Scenario: Q1 query uses EXISTS strategy
  Given PIM/DAM schema seeded in "acme" tenant
  And product p1 has approved FR main image
  And product p2 has only EN image
  And product p3 has rejected FR image
  When query for products with exists('images', { where: and(eq('locale', 'FR'), eq('is_main', true), eq('status', 'approved')) })
  Then dump.plan contains decision with type "filter-strategy" and choice "exists"
  And dump.sql contains "WHERE EXISTS"
  And execute() returns only [p1]

Scenario: Q1 query returns different results per tenant
  Given PIM/DAM schema seeded in both tenants
  And "acme" has 1 product with approved FR main image
  And "globex" has 2 products with approved FR main image
  When same Q1 query executed on "acme"
  Then result has 1 product
  When same Q1 query executed on "globex"
  Then result has 2 products
```

### Feature: Q2 - Multi-locale Images (CTE Extraction)

> **Note:** This scenario tests CTE extraction without requiring aggregations.
> Products with approved images in BOTH FR and EN locales trigger automatic CTE extraction
> because the `images` relation is accessed twice (threshold ≥ 2).

```gherkin
Scenario: Q2 query triggers CTE extraction for multi-access relation
  Given PIM/DAM schema seeded in "acme" tenant
  And product p1 has approved FR main image AND approved EN main image
  And product p2 has approved FR main image only
  And product p3 has approved EN main image only
  When query for products with exists('images', FR approved main) AND exists('images', EN approved main)
  Then dump.plan.ctes has at least 1 CTE named "cte_images"
  And dump.plan contains decision with type "cte-extraction"
  And dump.sql contains "WITH cte_images AS"
  And dump.sql contains two EXISTS clauses referencing cte_images
  And execute() returns only [p1]

Scenario: Q2 results are deterministic with orderBy
  Given PIM/DAM schema seeded
  When Q2 query with orderBy('id', 'asc') is executed twice
  Then both results are identical

Scenario: Q2 CTE is reused in both EXISTS subqueries
  Given PIM/DAM schema seeded
  When Q2 query is executed
  Then dump.plan.ctes[0].referencedBy has length 2
```

### Feature: Q4 - Multi-tenant Schema Isolation

```gherkin
Scenario: Queries are scoped to tenant schema
  Given schemas "acme" and "globex" exist
  And "acme".users has 3 records
  And "globex".users has 5 records
  When orm.forTenant('acme').query('users').execute()
  Then result has 3 users
  When orm.forTenant('globex').query('users').execute()
  Then result has 5 users

Scenario: Invalid schema name throws error
  Given ORM instance configured
  When forTenant('bad;drop schema') is called
  Then InvalidIdentifierError is thrown

Scenario: SQL includes schema qualification
  Given ORM instance with forTenant('acme')
  When dump() is called on any query
  Then dump.sql contains '"acme".'
```

### Feature: Q5 - Blog Scenario (Basic Validation)

```gherkin
Scenario: Simple blog query works end-to-end
  Given blog schema seeded
  And posts table has 5 posts
  And 3 posts are published
  When query for posts with where eq('published', true) orderBy('created_at', 'desc')
  Then execute() returns 3 posts
  And posts are ordered by created_at descending

Scenario: Include author relation works
  Given blog schema seeded
  And posts have authors
  When query for posts include('author')
  Then dump.plan contains include decision for "author"
```

### Feature: EXPLAIN Integration

```gherkin
Scenario: explain() returns real PostgreSQL plan
  Given real PostgreSQL connection
  And a compiled query
  When explain() is called
  Then result.plan is non-empty string
  And result.plan contains "Seq Scan" or "Index Scan"

Scenario: explain({ analyze: true }) returns timing
  Given real PostgreSQL connection
  And a compiled query
  When explain({ analyze: true }) is called
  Then result.executionTime is a positive number

Scenario: explain({ format: 'json' }) returns JSON plan
  Given real PostgreSQL connection
  And a compiled query
  When explain({ format: 'json' }) is called
  Then result.jsonPlan is parseable JSON array
```

### Feature: Benchmarks

```gherkin
Scenario: Query compilation is fast
  Given model with 10 tables
  When 1000 queries are compiled
  Then average time per query is under 1ms

Scenario: dump() overhead is minimal
  Given compiled query
  When dump() is called 1000 times
  Then average time per dump is under 0.5ms
```

---

## 5. Implementation Plan

### Block 1: DX-004 - Add dump()/execute() to QueryBuilder

**Package:** `packages/dx`

**Files:**
- `src/types.ts` - Add `dump()` and `execute()` to QueryBuilder interface
- `src/orm.ts` - Implement `dump()` and `execute()` methods

**Implementation:**
```typescript
// QueryBuilder interface additions
dump(): Dump;
execute(): Promise<unknown[]>;

// Implementation
dump(): Dump {
  const db = this.getConfiguredDb();
  const planReport = this.plan();
  const compiled = compile(planReport, this.model, db, this.schemaName);
  return createDumpFromPlan(planReport, compiled, {
    tenant: this.schemaName,
    compiledAt: new Date(),
  });
}

execute(): Promise<unknown[]> {
  return this.findMany();
}
```

**Tests:** Add to `orm-execution.test.ts`

**Acceptance criteria covered:** dump() scenarios, execute() scenario

---

### Block 2: Test Infrastructure (Testcontainers)

**Location:** `tests/e2e/`

**Files:**
- `vitest.config.e2e.ts` - E2E-specific vitest config
- `globalSetup.ts` - Start PostgreSQL container
- `globalTeardown.ts` - Stop container
- `testkit/db.ts` - Kysely instance factory

**Dependencies to add:**
```json
{
  "devDependencies": {
    "@testcontainers/postgresql": "^10.18.0",
    "pg": "^8.13.1"
  }
}
```

**Root package.json script:**
```json
{
  "scripts": {
    "test:e2e": "vitest run --config tests/e2e/vitest.config.e2e.ts"
  }
}
```

**Acceptance criteria covered:** Infrastructure scenarios

---

### Block 3: DDL + Seed

**Location:** `tests/e2e/testkit/`

**Files:**
- `pimdam.ddl.ts` - PIM/DAM schema DDL
- `pimdam.seed.ts` - Seed data for acme/globex
- `pimdam.model.ts` - ModelIR definition
- `blog.ddl.ts` - Blog schema DDL
- `blog.seed.ts` - Blog seed data
- `blog.model.ts` - Blog ModelIR

**PIM/DAM Schema:**
```sql
-- Applied to both acme and globex schemas
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories(id)
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  active BOOLEAN DEFAULT true,
  deleted_at TIMESTAMP
);

CREATE TABLE assets (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  size_bytes INTEGER,
  storage_key TEXT NOT NULL,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE product_images (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  locale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  is_main BOOLEAN DEFAULT false,
  position INTEGER DEFAULT 0,
  deleted_at TIMESTAMP
);

CREATE INDEX idx_product_images_product_id ON product_images(product_id);
CREATE INDEX idx_product_images_lookup ON product_images(product_id, locale, is_main, status);
```

**Blog Schema:**
```sql
CREATE TABLE authors (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT,
  author_id INTEGER NOT NULL REFERENCES authors(id),
  published BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  author_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Acceptance criteria covered:** Schema setup for all scenarios

---

### Block 4: E2E Test Suite

**Location:** `tests/e2e/`

**Files:**
- `pimdam.q1.exists.test.ts` - Q1 EXISTS tests
- `pimdam.q2.cte-multilocale.test.ts` - Q2 CTE extraction tests
- `pimdam.q4.multitenant.test.ts` - Q4 isolation tests
- `blog.basic.test.ts` - Q5 blog tests
- `explain.integration.test.ts` - EXPLAIN tests

**Test structure:**
```typescript
// pimdam.q1.exists.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createOrm, eq, and, exists } from '@dbsp/dx';
import { getTestDb } from './testkit/db';
import { pimdamModel } from './testkit/pimdam.model';

describe('Q1: Products with approved FR main image', () => {
  let db: Kysely<any>;
  let orm: OrmInstance;

  beforeAll(async () => {
    db = await getTestDb();
    orm = createOrm({ model: pimdamModel, db });
  });

  describe('Given acme tenant', () => {
    it('should use EXISTS strategy in plan', () => {
      const dump = orm.forTenant('acme')
        .query('products')
        .where(exists('images', {
          where: and(
            eq('locale', 'FR'),
            eq('is_main', true),
            eq('status', 'approved')
          )
        }))
        .dump();

      expect(dump.plan.decisions).toContainEqual(
        expect.objectContaining({
          type: 'filter-strategy',
          choice: 'exists',
        })
      );
      expect(dump.sql).toContain('WHERE EXISTS');
    });

    it('should return only products with approved FR main image', async () => {
      const products = await orm.forTenant('acme')
        .query('products')
        .where(exists('images', {
          where: and(
            eq('locale', 'FR'),
            eq('is_main', true),
            eq('status', 'approved')
          )
        }))
        .orderBy('id', 'asc')
        .execute();

      expect(products).toHaveLength(1);
      expect(products[0]).toMatchObject({ sku: 'PROD-001' });
    });
  });
});
```

```typescript
// pimdam.q2.cte-multilocale.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { createOrm, eq, and, exists } from '@dbsp/dx';
import { getTestDb } from './testkit/db';
import { pimdamModel } from './testkit/pimdam.model';

describe('Q2: Products with approved images in BOTH FR and EN', () => {
  let db: Kysely<any>;
  let orm: OrmInstance;

  beforeAll(async () => {
    db = await getTestDb();
    orm = createOrm({ model: pimdamModel, db });
  });

  describe('Given acme tenant', () => {
    const buildQ2Query = (tenant: string) =>
      orm.forTenant(tenant)
        .query('products')
        .where(and(
          exists('images', {
            where: and(eq('locale', 'FR'), eq('is_main', true), eq('status', 'approved'))
          }),
          exists('images', {
            where: and(eq('locale', 'EN'), eq('is_main', true), eq('status', 'approved'))
          })
        ))
        .orderBy('id', 'asc');

    it('should trigger CTE extraction (images accessed twice)', () => {
      const dump = buildQ2Query('acme').dump();

      // CTE extraction triggered
      expect(dump.plan.ctes).toHaveLength(1);
      expect(dump.plan.ctes[0].name).toBe('cte_images');
      expect(dump.plan.ctes[0].referencedBy).toHaveLength(2);

      // SQL uses WITH clause
      expect(dump.sql).toMatch(/WITH\s+cte_images\s+AS/i);
      expect(dump.sql).toMatch(/EXISTS.*cte_images.*EXISTS.*cte_images/s);
    });

    it('should return only products with BOTH FR and EN approved main images', async () => {
      const products = await buildQ2Query('acme').execute();

      // Only p1 has both FR and EN approved main images
      expect(products).toHaveLength(1);
      expect(products[0]).toMatchObject({ sku: 'PROD-001' });
    });
  });
});
```

**Acceptance criteria covered:** Q1, Q2, Q4, Q5 scenarios

---

### Block 5: Benchmarks

**Location:** `tests/e2e/benchmarks/`

**Files:**
- `query-perf.bench.ts` - Performance benchmarks

**Implementation:**
```typescript
import { bench, describe } from 'vitest';
import { createOrm, eq } from '@dbsp/dx';
import { pimdamModel } from '../testkit/pimdam.model';

describe('Query Performance', () => {
  const orm = createOrm({ model: pimdamModel });

  bench('compile simple query', () => {
    orm.query('products').where(eq('active', true)).plan();
  });

  bench('dump simple query', () => {
    orm.query('products').where(eq('active', true)).dump();
  });

  bench('compile query with EXISTS', () => {
    orm.query('products')
      .where(exists('images', { where: eq('status', 'approved') }))
      .plan();
  });
});
```

**Acceptance criteria covered:** Benchmark scenarios

---

## 6. Test Strategy

### Test Matrix

| Scenario | Unit | E2E | Benchmark |
|----------|------|-----|-----------|
| dump() returns Dump | Yes | Yes | - |
| execute() alias | Yes | Yes | - |
| Q1 EXISTS strategy | - | Yes | Yes |
| Q2 CTE extraction | - | Yes | - |
| Q4 multi-tenant | - | Yes | - |
| Q5 blog basic | - | Yes | - |
| EXPLAIN integration | - | Yes | - |
| Compilation speed | - | - | Yes |

### Test Data Strategy

**Acme tenant:**
- 4 products:
  - p1: approved FR main ✓, approved EN main ✓ (Q2 match)
  - p2: approved FR main ✓, EN missing (Q1 match only)
  - p3: EN approved ✓, FR missing (neither Q1 nor Q2)
  - p4: rejected FR (neither Q1 nor Q2)
- 6 assets
- 2 categories

**Globex tenant:**
- 5 products (2 with approved FR, 1 with both FR+EN)
- 8 assets
- 3 categories

**Blog:**
- 2 authors
- 5 posts (3 published)
- 10 comments

---

## 7. File Structure

```
tests/e2e/
├── README.md
├── vitest.config.e2e.ts
├── globalSetup.ts
├── globalTeardown.ts
├── testkit/
│   ├── db.ts
│   ├── pimdam.ddl.ts
│   ├── pimdam.seed.ts
│   ├── pimdam.model.ts
│   ├── blog.ddl.ts
│   ├── blog.seed.ts
│   └── blog.model.ts
├── pimdam.q1.exists.test.ts
├── pimdam.q2.cte-multilocale.test.ts
├── pimdam.q4.multitenant.test.ts
├── blog.basic.test.ts
├── explain.integration.test.ts
└── benchmarks/
    └── query-perf.bench.ts
```

---

## Definition of Done

- [ ] DX-004: dump() and execute() added to QueryBuilder
- [ ] Testcontainers infrastructure working
- [ ] PIM/DAM and Blog schemas created
- [ ] All E2E tests pass (Q1, Q2, Q4, Q5, EXPLAIN)
- [ ] Benchmarks run and show acceptable performance
- [ ] README.md with setup instructions
- [ ] All tests pass (unit + E2E)
- [ ] Lint/typecheck pass
- [ ] Documentation updated
