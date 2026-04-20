# @dbsp/mcp-server

[![npm version](https://img.shields.io/npm/v/@dbsp/mcp-server.svg)](https://www.npmjs.com/package/@dbsp/mcp-server)
[![license](https://img.shields.io/npm/l/@dbsp/mcp-server.svg)](LICENSE)

> **Status: pre-release scaffold.** MCP tools (`schema_list_tables`, `query_plan`, `intent_validate`) are not yet implemented — see the "Planned features" section below. The server currently connects and loads schemas but exposes no tools.

MCP (Model Context Protocol) server that exposes `@dbsp` schema and query planning capabilities to AI assistants such as Claude and Cursor.

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

## Planned features

(not yet implemented)

- **Schema exposure** — Surfaces table names, column types, relations, and constraints to the AI context (not yet implemented)
- **Query planning** — Accepts NQL or IntentAST and returns the compiled SQL + plan decisions (not yet implemented)
- **Intent validation** — Validates AI-generated NQL queries against the schema before execution (not yet implemented)
- **Observability** — Returns `dump()` output (plan + SQL + parameters) as structured MCP tool responses (not yet implemented)
- **Read-only by default** — No write operations exposed; safe for use in AI-assisted development workflows
- **Zero DB connection required** — Works in compile-only mode; no live database needed for planning

## Use cases

- Let Claude or Cursor understand your database schema during coding sessions
- Validate AI-generated queries before running them
- Expose query plan reasoning to the AI for better SQL generation suggestions

## Documentation

- [Guides](../../docs/guides/)

## License

MIT
