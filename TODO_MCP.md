# TODO: @dbsp/mcp-server

> MCP Server for db-semantic-planner
> Brief: docs/briefs/mcp-server.md

## Status: 🟡 READY FOR IMPLEMENTATION

---

## MCP-001: Package Setup

- [ ] Create `packages/mcp-server` directory structure
- [ ] Initialize package.json with dependencies:
  - `@modelcontextprotocol/sdk` (pin v1.x - stable API)
  - `@db-semantic-planner/core`
  - `@db-semantic-planner/schema`
  - `@db-semantic-planner/adapter-kysely`
- [ ] Configure tsconfig.json (ESM, strict)
- [ ] Configure tsup.config.ts (ESM output)
- [ ] Add to pnpm-workspace.yaml

---

## MCP-002: Schema Loader

- [ ] Implement schema file loader (TypeScript/JavaScript imports)
- [ ] Support for `--schema` CLI argument
- [ ] Validate loaded schema structure
- [ ] Error handling for invalid paths/formats
- [ ] Path traversal mitigation:
  - Allowlist of valid root directories
  - Resolve path and verify stays within allowed roots
  - Reject paths containing `..` or symlinks outside roots

---

## MCP-003: Tool - schema_list_tables

- [ ] List all tables from SchemaManifest
- [ ] Include columns with types and constraints
- [ ] Include primary key info
- [ ] Support optional table name filter

---

## MCP-004: Tool - schema_get_relations

- [ ] List all relations from SchemaManifest
- [ ] Show source → target with cardinality
- [ ] Include navigable paths from each table
- [ ] Support optional table name filter

---

## MCP-005: Tool - query_plan

- [ ] Accept Intent JSON v1 structure (deterministic compilation)
- [ ] Options: `{ explain?: boolean, dialect?: string }`
- [ ] Validate intent against loaded schema
- [ ] Use MockAdapter to compile to SQL
- [ ] Return SQL + params + plan report
- [ ] Include warnings and decisions
- [ ] Note: LLM does NL→Intent, MCP does Intent→SQL deterministically

---

## MCP-006: Tool - intent_validate

- [ ] Accept Intent JSON structure
- [ ] Two-level validation:
  - **Structural (JSON Schema):** Field types, required fields, format
  - **Semantic (Schema lookup):** Table exists, columns exist, relation paths valid
- [ ] Return structured errors with suggestions
- [ ] Return success with normalized intent

---

## MCP-007: Resource - schema://manifest

- [ ] Expose full SchemaManifest as MCP resource
- [ ] Support schema://manifest URI
- [ ] Include version metadata
- [ ] Cache manifest on load

---

## MCP-007a: Resource - schema://intent-schema

- [ ] Expose Intent JSON Schema (v1)
- [ ] Support schema://intent-schema URI
- [ ] Include all field definitions and constraints
- [ ] Document supported operators and expressions

---

## MCP-007b: Resource - schema://cookbook

- [ ] Common query patterns with Intent examples
- [ ] Filtering, pagination, includes, aggregations
- [ ] Best practices and gotchas
- [ ] Anti-patterns to avoid

---

## MCP-008: Server Entry Point

- [ ] MCP server initialization
- [ ] Tool registration
- [ ] Resource registration
- [ ] CLI entry with `--schema` argument
- [ ] Add bin entry to package.json

---

## MCP-009: Testing

- [ ] Unit tests for each tool
- [ ] Integration test with sample schema
- [ ] MCP protocol compliance tests
- [ ] Error case coverage

---

## MCP-010: Documentation

- [ ] README.md with usage examples
- [ ] MCP configuration examples (Claude Code, Cursor)
- [ ] Tool/resource API documentation

---

## Future (V2)

- [ ] query_execute - Run queries against real DB
- [ ] schema_suggest - Optimization suggestions
- [ ] Multi-schema support
- [ ] Schema hot-reload on file changes
