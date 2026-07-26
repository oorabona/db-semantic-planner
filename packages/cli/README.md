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

### Peer requirements

`pg` and `tsx` are optional peers — install them only for the commands that need them.

**`pg` must be `>=8.21.0`.** From 2.2.0 the declared range is `^8.21.0`, narrowed from `^8.16.0`.
This is not a preference: `@dbsp/adapter-pgsql` reads a field that pg only started recording in
8.21, and without it `orm.inTransaction` reports `true` for an idle borrowed connection. The old
range promised support the code could not deliver on 8.16–8.20.

If you are on pg 8.16–8.20 you will now see an unmet-peer warning, and an error under
`strict-peer-dependencies`. Upgrading pg to 8.21 or later is the fix; staying below it means
`inTransaction` misreports, whether or not the peer range says so.

Keeping one `pg` in your dependency tree matters for the same reason. If your own range and the
one this package resolves cannot meet, npm and pnpm are both free to install two copies, and
adapter code then reads a client it was not built against.

## Quick Start

```bash
# Interactive REPL with NQL tab-completion
npx dbsp repl --schema ./dbsp.schema.ts --db postgres://user:pass@localhost/mydb

# Verify schema against a live database (drift detection)
npx dbsp verify --schema ./dbsp.schema.ts --db postgres://user:pass@localhost/mydb

# Push schema changes to the database
npx dbsp push --schema ./dbsp.schema.ts --db postgres://user:pass@localhost/mydb

# Generate DDL SQL for provisioning
npx dbsp generate ddl --schema ./dbsp.schema.ts -o ./generated
```

## Commands

| Command | Description |
|---------|-------------|
| `dbsp repl` | Interactive REPL with NQL syntax, tab-completion, and query history |
| `dbsp verify` | Compare schema against live database; exit code 1 on drift |
| `dbsp push` | Apply schema changes (DDL provisioning) with advisory lock |
| `dbsp migrate` | Generate and apply UP/DOWN migration files |
| `dbsp generate ddl` | Generate SQL CREATE TABLE statements for provisioning |
| `dbsp introspect` | Generate schema.ts from database introspection |

## Key features

- **REPL with completion** — Tab-complete table names, columns, NQL keywords, and relation paths
- **Query history** — Persistent history across sessions
- **Batch mode** — Use `repl --eval` for single queries or `repl --input` for batch files
- **DDL provisioning** — `push` computes schema diff and applies the minimum required DDL
- **Destructive-change safety** — Warns before dropping columns or tables; `--force` required
- **Drift detection** — `verify` compares live introspection against declared schema
- **Migration tracking** — `migrate` generates UP/DOWN migration files with advisory locks
- **JSON output** — `--json` flag on most commands for CI pipeline integration

## Documentation

- [Guides](https://oorabona.github.io/db-semantic-planner/guide/)
- [Schema versioning guide](https://oorabona.github.io/db-semantic-planner/guide/schema-versioning)
- [Batch values guide](https://oorabona.github.io/db-semantic-planner/guide/batch-values)

## License

MIT
