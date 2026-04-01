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
