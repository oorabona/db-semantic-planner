# TODO: @dbsp/mcp-server

> MCP Server for db-semantic-planner
> Brief: docs/briefs/mcp-server.md

## Status: 🟢 IN PROGRESS

---

## MCP-001: Package Setup ✅ (2026-01-11)

- [x] Create `packages/mcp-server` directory structure
- [x] Initialize package.json with dependencies:
  - `@modelcontextprotocol/sdk` (pin v1.x - stable API)
  - `@dbsp/core`
  - `@dbsp/schema`
  - `@dbsp/adapter-kysely`
- [x] Configure tsconfig.json (ESM, strict)
- [x] Configure tsup.config.ts (ESM output)
- [x] Add to pnpm-workspace.yaml (via catalog)

---

## MCP-002: Schema Loader ✅ (2026-01-11)

- [x] Implement schema file loader (TypeScript/JavaScript imports)
- [x] Support for `--schema` CLI argument
- [x] Validate loaded schema structure
- [x] Error handling for invalid paths/formats
- [x] Path traversal mitigation:
  - Allowlist of valid root directories (`--allowed-root` option)
  - Resolve path and verify stays within allowed roots
  - Reject paths containing `..` or symlinks outside roots
  - Uses `realpathSync` to resolve symlinks

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

## MCP-008: Server Entry Point (Partial - Foundation Ready)

- [x] MCP server initialization (McpServer from SDK)
- [ ] Tool registration (placeholder TODOs added)
- [ ] Resource registration (placeholder TODOs added)
- [x] CLI entry with `--schema` argument
- [x] Add bin entry to package.json (`dbsp-mcp`)

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
