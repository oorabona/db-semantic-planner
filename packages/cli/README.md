# @dbsp/cli

[![npm version](https://img.shields.io/npm/v/@dbsp/cli.svg)](https://www.npmjs.com/package/@dbsp/cli)
[![license](https://img.shields.io/npm/l/@dbsp/cli.svg)](LICENSE)

CLI tools for `@dbsp` — interactive REPL, schema verification, DDL provisioning, and batch execution.

## Installation

```bash
# As a dev dependency (recommended)
pnpm add -D @dbsp/cli

# Or globally
npm install -g @dbsp/cli
```

## Quick Start

```bash
# Interactive REPL with NQL tab-completion
npx dbsp repl --schema ./dbsp.schema.ts --db postgres://user:pass@localhost/mydb

# Verify schema against a live database (drift detection)
npx dbsp verify --schema ./dbsp.schema.ts --db postgres://user:pass@localhost/mydb

# Push schema changes to the database
npx dbsp push --schema ./dbsp.schema.ts --db postgres://user:pass@localhost/mydb

# Generate JSON manifest for tooling / MCP integration
npx dbsp generate manifest --schema ./dbsp.schema.ts --output ./generated
```

## Commands

| Command | Description |
|---------|-------------|
| `dbsp repl` | Interactive REPL with NQL syntax, tab-completion, and query history |
| `dbsp verify` | Compare schema against live database; exit code 1 on drift |
| `dbsp push` | Apply schema changes (DDL provisioning) with advisory lock |
| `dbsp migrate` | Generate and apply UP/DOWN migration files |
| `dbsp generate manifest` | Export schema as JSON for external tooling |
| `dbsp batch` | Execute a file of NQL or SQL statements and report results |

## Key features

- **REPL with completion** — Tab-complete table names, columns, NQL keywords, and relation paths
- **Query history** — Persistent history across sessions
- **DDL provisioning** — `push` computes schema diff and applies the minimum required DDL
- **Destructive-change safety** — Warns before dropping columns or tables; `--force` required
- **Drift detection** — `verify` compares live introspection against declared schema
- **Batch execution** — Run assertion files for integration testing (`--dry-run` supported)
- **JSON output** — `--json` flag on most commands for CI pipeline integration

## Documentation

- [Full documentation index](../../docs/DOCUMENTATION_INDEX.md)
- [Schema versioning guide](../../docs/guides/how-to-use-schema-versioning.md)
- [Batch values guide](../../docs/guides/how-to-use-batch-values.md)

## License

MIT
