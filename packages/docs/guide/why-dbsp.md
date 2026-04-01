---
title: Why db-semantic-planner?
---

# Why db-semantic-planner?

## The problem

Every major ORM or query builder forces you to make a fundamental trade-off. ORMs like Prisma and TypeORM abstract away SQL to the point where you cannot understand what query will run — until something goes wrong in production. Query builders like Kysely and Drizzle give you back SQL control, but leave you responsible for choosing the right join strategy, preventing N+1 problems, and debugging parameterized query construction. In both cases, the tool's internal decisions are opaque: you see a result, not the reasoning that produced it.

Multi-tenant applications add another layer of complexity. Schema-per-tenant isolation requires manual schema prefixing in every query, across every abstraction layer. Most tools treat this as an afterthought.

## How dbsp is different

db-semantic-planner is built around an intent-first paradigm. You declare what data you need — `orm.select('users').include('posts').where(eq('active', true))` — and the planner decides how to fetch it. The planner selects the optimal include strategy (`json_agg`, lateral join, correlated subquery, or CTE) based on the query shape, relation cardinality, and dialect capabilities. You do not choose the strategy; the planner does, and it explains why.

Every decision is observable. `.dump()` returns the full plan with reasoning, the compiled SQL, and the bound parameters — before execution. You can inspect what the planner chose and why, log it, or test it without a database connection. This makes debugging deterministic: same inputs always produce the same plan.

Multi-tenant isolation is a first-class primitive. `orm.withSchema('tenant_42')` returns a new ORM instance where every query, mutation, and DDL operation is automatically scoped to that PostgreSQL schema. No manual prefixing, no middleware boilerplate.

## Quick comparison

| Feature | dbsp | Prisma | Drizzle | Kysely |
|---------|:----:|:------:|:-------:|:------:|
| Intent-first query planning | Yes | No | No | No |
| Observable decisions (dump) | Full plan + SQL + params | SQL only (preview) | SQL only | SQL only |
| Automatic include strategy | Yes (json_agg / lateral / subquery / CTE) | Yes (opaque) | Manual | Manual |
| N+1 prevention | Automatic | Yes | Yes | Manual |
| Multi-tenant (withSchema) | Built-in | Manual | Manual | Manual |
| Recursive CTEs | Builder API | No | Manual | Yes |
| Full TypeScript inference | Yes | Yes | Yes | Yes |
| No codegen required | Yes | No | No | Yes |
| pgvector / ParadeDB support | Built-in helpers | Plugin | Plugin | Manual |
| Row-level security (DDL) | Yes | No | No | No |

For the full feature matrix across 16 tools, see the [comparison page](/comparison).
