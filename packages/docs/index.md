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

<div class="why-grid">
  <div class="why-card">
    <h3>vs Prisma</h3>
    <p>No codegen step. Full SQL observability via dump(). The planner shows you WHY it chose a strategy, not just what SQL it generated. Native multi-tenant with withSchema().</p>
  </div>
  <div class="why-card">
    <h3>vs Drizzle</h3>
    <p>Automatic include strategy selection — no manual JOINs for relations. Recursive CTEs via include({ recursive: true }). Built-in pgvector and ParadeDB helpers.</p>
  </div>
  <div class="why-card">
    <h3>vs Kysely</h3>
    <p>First-class relation handling with .include(). Semantic planning that prevents N+1 automatically. Schema-level type inference without manual interface definitions.</p>
  </div>
</div>

<div style="text-align: center; margin-top: 1.5rem;">
  <a href="/comparison" style="color: var(--vp-c-brand-1); font-size: 0.9rem;">See full comparison with 16 tools →</a>
</div>

</section>

<section class="landing-section testimonials-section">

## What developers say

<div class="testimonials-grid">
  <div class="testimonial-card">
    <p class="testimonial-text">"The dump() function changed how I debug queries. Seeing the plan decisions alongside the SQL is something no other ORM gives you."</p>
    <div class="testimonial-author">
      <div class="testimonial-avatar">JD</div>
      <div>
        <div class="testimonial-name">Jane Doe</div>
        <div class="testimonial-role">Senior Backend Engineer</div>
      </div>
    </div>
  </div>
  <div class="testimonial-card">
    <p class="testimonial-text">"We migrated from Prisma for the multi-tenant support. withSchema() just works — no hacks, no middleware, no runtime overhead."</p>
    <div class="testimonial-author">
      <div class="testimonial-avatar">JS</div>
      <div>
        <div class="testimonial-name">John Smith</div>
        <div class="testimonial-role">CTO, SaaS Startup</div>
      </div>
    </div>
  </div>
  <div class="testimonial-card">
    <p class="testimonial-text">"The NQL pipe syntax in the REPL is perfect for prototyping. I can iterate on complex queries in seconds without writing TypeScript."</p>
    <div class="testimonial-author">
      <div class="testimonial-avatar">AK</div>
      <div>
        <div class="testimonial-name">Alex Kim</div>
        <div class="testimonial-role">Full-Stack Developer</div>
      </div>
    </div>
  </div>
</div>

</section>

<section class="landing-section pg-section">

## Built for PostgreSQL

<div class="pg-features">
  <div class="pg-badge">PostgreSQL 14+</div>
  <div class="pg-badge">pgvector</div>
  <div class="pg-badge">ParadeDB BM25</div>
  <div class="pg-badge">Row-Level Security</div>
  <div class="pg-badge">Advisory Locks</div>
  <div class="pg-badge">JSONB</div>
  <div class="pg-badge">Recursive CTEs</div>
  <div class="pg-badge">LATERAL JOINs</div>
  <div class="pg-badge">Window Functions</div>
  <div class="pg-badge">DISTINCT ON</div>
  <div class="pg-badge">FOR UPDATE / SKIP LOCKED</div>
  <div class="pg-badge">Schema-per-tenant</div>
</div>

<p class="pg-note">Every PostgreSQL feature is exposed through type-safe APIs — no raw SQL needed.</p>

</section>

<section class="landing-section cta-section">

## Ready to build?

<div class="stats-row">
  <div class="stat"><span class="stat-value">7,700+</span><span class="stat-label">tests</span></div>
  <div class="stat"><span class="stat-value">7</span><span class="stat-label">packages</span></div>
  <div class="stat"><span class="stat-value">v1.0</span><span class="stat-label">stable</span></div>
  <div class="stat"><span class="stat-value">MIT</span><span class="stat-label">license</span></div>
</div>

<div class="cta-buttons">
  <a href="/guide/getting-started" class="cta-primary">Get Started</a>
  <a href="/playground" class="cta-secondary">Try the Playground</a>
  <a href="https://github.com/oorabona/db-semantic-planner" class="cta-secondary">View on GitHub</a>
</div>

</section>

</div>
