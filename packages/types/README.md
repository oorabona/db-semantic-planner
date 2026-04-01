# @dbsp/types

[![npm version](https://img.shields.io/npm/v/@dbsp/types.svg)](https://www.npmjs.com/package/@dbsp/types)
[![license](https://img.shields.io/npm/l/@dbsp/types.svg)](LICENSE)

Shared TypeScript contract types for the `@dbsp` ecosystem — `ModelIR`, `IntentAST`, `PlanReport`, and the `Adapter` interface.

## Installation

```bash
pnpm add @dbsp/types
```

## Usage

```typescript
import type { ModelIR, IntentAST, PlanReport, Adapter } from '@dbsp/types';

// Type-check your adapter implementation
const myAdapter: Adapter = { ... };

// Annotate plan report handlers
function inspect(report: PlanReport): void {
  for (const decision of report.decisions) {
    console.log(decision.kind, decision.reason);
  }
}
```

## Key types

- **`ModelIR`** — Schema representation: tables, columns, relations, constraints, RLS policies
- **`IntentAST`** — Declarative query intent: selections, filters, includes, ordering
- **`PlanReport`** — Planner output: decisions, warnings, simplified plan used by adapters
- **`Adapter`** — Port interface every adapter must implement (`compile`, `execute`, `withSchema`)
- **`DialectCapabilities`** — Feature flags negotiated between core and an adapter

## Notes

`@dbsp/types` is a zero-dependency package with no runtime code — it is types-only. All `@dbsp/*` packages share this contract, which breaks the circular dependency between `core` and `adapter-pgsql`.

## Documentation

See the [architecture overview](../../ARCHITECTURE.md) and [guides](../../docs/guides/) for details.

## License

MIT
