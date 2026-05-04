# @dbsp/mcp-server

[![npm version](https://img.shields.io/npm/v/@dbsp/mcp-server.svg)](https://www.npmjs.com/package/@dbsp/mcp-server)
[![license](https://img.shields.io/npm/l/@dbsp/mcp-server.svg)](LICENSE)

MCP (Model Context Protocol) server that exposes `@dbsp` schema and query planning capabilities to AI assistants such as Claude and Cursor.

_No MCP tools are registered yet — see Roadmap below._

## Installation

```bash
pnpm add @dbsp/mcp-server
```

## Quick Start

Add to your Claude Desktop or Cursor MCP configuration:

```json
{
  "mcpServers": {
    "dbsp": {
      "command": "node",
      "args": [
        "./node_modules/@dbsp/mcp-server/dist/index.js",
        "--schema",
        "./dbsp.schema.ts"
      ]
    }
  }
}
```

Or run directly:

```bash
npx dbsp-mcp --schema ./dbsp.schema.ts
```

## Roadmap

<details>
<summary>MCP tools planned for upcoming releases</summary>

- **`schema_info`** — return the resolved schema (tables + columns) as structured content. _Targeting v1.1._
- **`schema_list_tables`** — Surfaces table names, column types, relations, and constraints to the AI context.
- **`query_plan`** — Accepts NQL or IntentAST and returns the compiled SQL + plan decisions.
- **`intent_validate`** — Validates AI-generated NQL queries against the schema before execution.
- **`observability`** — Returns `dump()` output (plan + SQL + parameters) as structured MCP tool responses.
- **Read-only by default** — No write operations exposed; safe for use in AI-assisted development workflows.
- **Zero DB connection required** — Works in compile-only mode; no live database needed for planning.

Subscribe to releases on GitHub to be notified when these ship.

</details>

## Use cases

_Once the planned tools (see Roadmap) ship, this server will support:_

- Letting Claude or Cursor understand your database schema during coding sessions
- Validating AI-generated queries before running them
- Exposing query plan reasoning to the AI for better SQL generation suggestions

## Documentation

- [Guides](https://oorabona.github.io/db-semantic-planner/guide/)

## License

MIT
