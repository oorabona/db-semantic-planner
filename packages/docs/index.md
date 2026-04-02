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
  - icon: "\U0001F9E0"
    title: Semantic Planning
    details: The planner chooses between EXISTS, JOIN, and lateral subqueries based on relation cardinality. You describe what, it decides how.
  - icon: "\U0001F50D"
    title: Full Observability
    details: Every query exposes its plan, compiled SQL, and bound parameters via dump(). Debug before you execute.
  - icon: "\U0001F512"
    title: Multi-tenant Native
    details: Schema-per-tenant isolation with orm.withSchema(). Every query is automatically scoped — no manual prefixing.
  - icon: "\U0001F680"
    title: Zero Overhead
    details: Direct pg Pool — no ORM layer, no codegen, no runtime dependencies. Tree-shakeable ESM.
  - icon: "\U0001F504"
    title: Recursive Queries
    details: "Hierarchies via include({ recursive: true }) with automatic CTE generation. Trees and graphs without raw SQL."
  - icon: "\u26A1"
    title: PostgreSQL Extensions
    details: Built-in helpers for pgvector (cosine distance, L2, inner product) and ParadeDB (BM25 full-text search).
---

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

<section class="landing-section cta-section">

## Ready to build?

<div class="cta-buttons">
  <a href="/guide/getting-started" class="cta-primary">Get Started</a>
  <a href="/playground" class="cta-secondary">Try the Playground</a>
  <a href="/demo" class="cta-secondary">Watch the Demo</a>
</div>

</section>

</div>
