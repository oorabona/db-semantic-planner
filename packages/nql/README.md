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
import { compile } from '@dbsp/nql';

// Compile an NQL query to IntentAST
const intent = compile(
  "users | where active = true | select name, email | order name asc | limit 20",
  schema
);

// Pass the intent to the ORM
const users = await orm.from(intent).all();
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
- **CTE support** — `WITH name AS (subquery)` for named subqueries
- **Schema-aware** — Validates column names and relation paths against `ModelIR` at parse time
- **LLM-friendly** — Concise syntax designed for AI-generated queries
- **Chevrotain-based** — Robust lexer + parser with structured error recovery
- **Composable** — Output `IntentAST` is the same type used by the TypeScript fluent builders

## Documentation

- [Full documentation index](../../docs/DOCUMENTATION_INDEX.md)
- [Full-text search guide](../../docs/guides/how-to-use-full-text-search.md)

## License

MIT
