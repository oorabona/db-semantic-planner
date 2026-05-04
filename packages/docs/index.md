---
layout: home
hero:
  name: db-semantic-planner
  text: The intent-first query planner
  tagline: Declare what you want. The planner decides how. Then shows you why.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/oorabona/db-semantic-planner
  image:
    src: /logo.svg
    alt: dbsp
features:
  - icon:
      src: /icons/brain.svg
      width: 24
      height: 24
    title: Semantic Planning
    details: The planner chooses between EXISTS, JOIN, and lateral subqueries based on relation cardinality. You describe what, it decides how.
  - icon:
      src: /icons/search.svg
      width: 24
      height: 24
    title: Full Observability
    details: Every query exposes its plan, compiled SQL, and bound parameters via dump(). Debug before you execute.
  - icon:
      src: /icons/shield.svg
      width: 24
      height: 24
    title: Multi-tenant Native
    details: Schema-per-tenant isolation with orm.withSchema(). Every query is automatically scoped — no manual prefixing.
  - icon:
      src: /icons/rocket.svg
      width: 24
      height: 24
    title: Zero Overhead
    details: Direct pg Pool — no ORM layer, no codegen, no runtime dependencies. Tree-shakeable ESM.
  - icon:
      src: /icons/refresh.svg
      width: 24
      height: 24
    title: Recursive Queries
    details: "Hierarchies via include({ recursive: true }) with automatic CTE generation. Trees and graphs without raw SQL."
  - icon:
      src: /icons/zap.svg
      width: 24
      height: 24
    title: PostgreSQL Extensions
    details: Built-in helpers for pgvector (cosine distance, L2, inner product) and ParadeDB (BM25 full-text search).
---

<div class="install-bar">
  <code class="install-cmd">pnpm add @dbsp/core @dbsp/adapter-pgsql</code>
</div>

<div class="landing-sections">

<section class="landing-section see-it">

## See it in action

<TerminalDemo />

</section>

<section class="landing-section pipeline">

## How it works

<div class="pipeline-steps">
  <div class="pipeline-step">
    <div class="step-number">1</div>
    <div class="step-content">
      <h3>Declare intent</h3>
      <p>Write what you need in TypeScript or NQL — tables, filters, relations, aggregations.</p>
      <code class="step-code">orm.select('posts').where(eq('published', true)).include('author')</code>
    </div>
  </div>
  <div class="pipeline-arrow">&rarr;</div>
  <div class="pipeline-step">
    <div class="step-number">2</div>
    <div class="step-content">
      <h3>Planner decides</h3>
      <p>The semantic planner analyzes cardinality, chooses JOIN strategy, extracts CTEs, optimizes.</p>
      <code class="step-code">include-strategy: lateral-join (to-one relation)</code>
    </div>
  </div>
  <div class="pipeline-arrow">&rarr;</div>
  <div class="pipeline-step">
    <div class="step-number">3</div>
    <div class="step-content">
      <h3>Inspect everything</h3>
      <p>Every decision is visible via dump() — SQL, parameters, plan reasoning. Debug before you execute.</p>
      <code class="step-code">SELECT ... FROM "posts" LEFT JOIN LATERAL (...) WHERE $1</code>
    </div>
  </div>
</div>

</section>

<section class="landing-section why-section">

## Why db-semantic-planner?

<div class="why-row">
  <div class="why-text">
    <h3>vs Prisma</h3>
    <p>No codegen step. Full SQL observability via dump(). The planner shows you <strong>why</strong> it chose a strategy, not just what SQL it generated. Native multi-tenant with withSchema().</p>
  </div>
  <div class="why-code">

```typescript
// See every decision the planner makes
const dump = orm.select('posts')
  .where(eq('published', true))
  .include('author')
  .dump();

dump.plan.decisions
// → [{ type: 'include-strategy',
//      choice: 'lateral-join',
//      reason: 'to-one relation' }]
```

  </div>
</div>

<div class="why-row reverse">
  <div class="why-text">
    <h3>vs Drizzle</h3>
    <p>Automatic include strategy selection — no manual JOINs for relations. The planner picks lateral, subquery, or join based on cardinality. Built-in pgvector and ParadeDB helpers.</p>
  </div>
  <div class="why-code">

```typescript
// Relations just work — planner decides strategy
const users = await orm
  .select('users')
  .include('posts.comments.author')
  .dump();

// Nested 3-level include — zero manual JOINs
// Result: users[].posts[].comments[].author
```

  </div>
</div>

<div class="why-row">
  <div class="why-text">
    <h3>vs Kysely</h3>
    <p>First-class relation handling with .include(). Schema-level type inference without manual interface definitions. Multi-tenant isolation built-in, not bolted on.</p>
  </div>
  <div class="why-code">

```typescript
// Multi-tenant in one line
const tenantOrm = orm.withSchema('acme_corp');

const users = await tenantOrm
  .select('users')
  .where(eq('active', true))
  .dump();
// → SELECT * FROM "acme_corp"."users" WHERE ...
```

  </div>
</div>

<div style="text-align: center; margin-top: 1.5rem;">
  <a href="/comparison" style="color: var(--vp-c-brand-1); font-size: 0.9rem;">See full comparison with 16 tools →</a>
</div>

</section>

<section class="landing-section pg-section">

## Adapter-agnostic core. PostgreSQL-native today.

<p class="pg-subtitle">The core planner, schema DSL, query builders, and NQL work independently of any database. Write once, swap adapters.</p>

<div class="db-grid">
  <div class="db-card db-active">
    <div class="db-name">PostgreSQL</div>
    <div class="db-status">v1.0 — Stable</div>
    <div class="pg-features">
      <span class="pg-badge">pgvector</span>
      <span class="pg-badge">ParadeDB</span>
      <span class="pg-badge">RLS</span>
      <span class="pg-badge">LATERAL</span>
      <span class="pg-badge">CTEs</span>
      <span class="pg-badge">Window Fn</span>
      <span class="pg-badge">DISTINCT ON</span>
      <span class="pg-badge">Multi-tenant</span>
      <span class="pg-badge">Range Types</span>
    </div>
  </div>
  <div class="db-card db-planned">
    <div class="db-name">SQLite</div>
    <div class="db-status">Planned</div>
  </div>
  <div class="db-card db-planned">
    <div class="db-name">DuckDB</div>
    <div class="db-status">Planned</div>
  </div>
  <div class="db-card db-planned">
    <div class="db-name">MySQL</div>
    <div class="db-status">Planned</div>
  </div>
</div>

<div style="text-align: center; margin-top: 1.5rem;">
  <a href="/roadmap" style="color: var(--vp-c-brand-1); font-size: 0.9rem;">See the roadmap →</a>
</div>

</section>

<section class="landing-section cta-section">

## Ready to build?

<div class="stats-row">
  <div class="stat"><span class="stat-value">7,700+</span><span class="stat-label">tests</span></div>
  <div class="stat"><span class="stat-value">7</span><span class="stat-label">packages</span></div>
  <div class="stat"><span class="stat-value">v1.0</span><span class="stat-label">stable</span></div>
  <div class="stat"><span class="stat-value">MIT</span><span class="stat-label">license</span></div>
</div>

<p class="whats-new"><strong>v1.0.1 highlights:</strong> Range operators (<code>rangeOverlaps</code>, <code>rangeContains</code>, <code>rangeContainedBy</code>), <code>dump({ queryName, correlationId })</code> for end-to-end request tracking, fixed relation-mode <code>.join()</code> on compile-only adapters.</p>

<div class="cta-buttons">
  <a href="/guide/getting-started" class="cta-primary">Get Started</a>
  <a href="/playground" class="cta-secondary">Try the Playground</a>
  <a href="https://github.com/oorabona/db-semantic-planner" class="cta-secondary">View on GitHub</a>
</div>

</section>

</div>
