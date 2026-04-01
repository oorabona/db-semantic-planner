# @dbsp/mcp-server

[![npm version](https://img.shields.io/npm/v/@dbsp/mcp-server.svg)](https://www.npmjs.com/package/@dbsp/mcp-server)
[![license](https://img.shields.io/npm/l/@dbsp/mcp-server.svg)](LICENSE)

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
      "args": ["./node_modules/@dbsp/mcp-server/dist/index.js"],
      "env": {
        "DBSP_SCHEMA": "./dbsp.schema.ts"
      }
    }
  }
}
```

Or run directly:

```bash
DBSP_SCHEMA=./dbsp.schema.ts npx dbsp-mcp
```

## Key features

- **Schema exposure** — Surfaces table names, column types, relations, and constraints to the AI context
- **Query planning** — Accepts NQL or IntentAST and returns the compiled SQL + plan decisions
- **Intent validation** — Validates AI-generated NQL queries against the schema before execution
- **Observability** — Returns `dump()` output (plan + SQL + parameters) as structured MCP tool responses
- **Read-only by default** — No write operations exposed; safe for use in AI-assisted development workflows
- **Zero DB connection required** — Works in compile-only mode; no live database needed for planning

## Use cases

- Let Claude or Cursor understand your database schema during coding sessions
- Validate AI-generated queries before running them
- Expose query plan reasoning to the AI for better SQL generation suggestions

## Documentation

- [Full documentation index](../../docs/DOCUMENTATION_INDEX.md)

## License

MIT
