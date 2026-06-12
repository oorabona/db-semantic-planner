# @dbsp/nql

[![npm version](https://img.shields.io/npm/v/@dbsp/nql.svg)](https://www.npmjs.com/package/@dbsp/nql)
[![license](https://img.shields.io/npm/l/@dbsp/nql.svg)](LICENSE)

NQL (Natural Query Language) — a human- and LLM-friendly pipe-based query language that compiles to `IntentAST` for `@dbsp/core`.

## Installation

```bash
pnpm add @dbsp/nql
```

## Quick Start

```typescript
// doctest: skip — exec-only operation; compile from @dbsp/nql is not in doctest preamble and orm.from(intent).all() requires a real PostgreSQL connection
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';
import { compile } from '@dbsp/nql';

// Compile an NQL query to a public intent bundle
const compiled = compile(
  "users | where active = true | select name, email | order name asc | limit 20",
  db.model
);

if (!compiled.success || !compiled.ast?.query) {
  throw new Error(compiled.errors.map((e) => e.message).join(', '));
}

// Pass the whole bundle to the adapter; bound params are explicit public IR nodes
const adapter = createPgsqlCompileOnlyAdapter();
const query = adapter.compile(compiled.ast, { model: db.model });
```

## Syntax overview

```nql
-- Basic selection with filter
users | where status = 'active'

-- Computed columns and ordering
orders | select id, total, tax | order total desc | limit 10

-- Relations (auto-resolved from schema refs)
posts | include author | where published = true

-- CTEs (WITH clause)
with recent AS (orders | where createdAt > '2024-01-01')
recent | select id, total

-- Aggregation
orders | group customerId | select customerId, sum(total) as revenue
```

## Key features

- **Pipe syntax** — Readable left-to-right data flow (`table | filter | select | order`)
- **SQL-style literals** — Single-quoted strings (`'value'`), not double-quoted
- **Named parameters** — Bind runtime values with `:name` in expression positions
- **CTE support** — `WITH name AS (subquery)` for named subqueries
- **Schema-aware** — Validates column names and relation paths against `ModelIR` at parse time
- **LLM-friendly** — Concise syntax designed for AI-generated queries
- **Chevrotain-based** — Robust lexer + parser with structured error recovery
- **Composable** — Output `IntentAST` is the same type used by the TypeScript fluent builders

## Named parameters

Use `:name` placeholders for runtime values and pass a `params` map to the compiler:

```typescript
// doctest: skip — illustrative direct compiler params example
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';
import { compile } from '@dbsp/nql';

const compiled = compile(
  'users | where id = :id and active = :active | limit :limit',
  db.model,
  undefined,
  { params: { id: 42, active: true, limit: 10 } },
);

if (!compiled.success || !compiled.ast?.query) {
  throw new Error(compiled.errors.map((e) => e.message).join(', '));
}

const adapter = createPgsqlCompileOnlyAdapter();
const query = adapter.compile(compiled.ast, { model: db.model });
```

Missing params fail compilation. `null` binds SQL `NULL`; `undefined`, `NaN`, and `Infinity` are rejected. The `@dbsp/core` `orm.nql` template tag builds on the same mechanism for `${value}` interpolation. See [Named Parameters and Template Binding](https://oorabona.github.io/db-semantic-planner/nql/#named-parameters-and-template-binding) for the full contract.

## Documentation

- [Guides](https://oorabona.github.io/db-semantic-planner/guide/)
- [Full-text search guide](https://oorabona.github.io/db-semantic-planner/guide/full-text-search)

## License

MIT
