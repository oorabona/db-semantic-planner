# @dbsp/mcp-server - Ideation Brief

> Generated: 2026-01-11
> Status: Ready for PRD

## Problem Statement

**Problem:** AI coding assistants lack semantic understanding of database schemas, leading to incorrect/incomplete query generation.

**Root cause:** No standardized bridge between semantic schema definitions (with relations, hints, conventions) and AI tool consumption via MCP.

**Target users:** Developers using AI assistants for database work.

**Current solutions:** Raw SQL dumps, manual context injection, ORM parsing — all lack semantic context and are error-prone.

## Proposed Solution

**Approach:** MCP Server exposing db-semantic-planner schema and query planning capabilities to AI tools.

**Key differentiator:** **Deterministic** Intent → SQL compilation (LLM does NL→Intent, MCP does Intent→SQL).

**Why this approach:**
- Leverages existing LOT-4 SchemaManifest format
- Reuses core planner without new DB adapter
- Standard MCP protocol = works with Claude Code, Cursor, etc.
- Deterministic: same Intent JSON always produces same SQL

## Key Features

### MVP Tools

1. **schema_list_tables** — List tables with columns, types, constraints
2. **schema_get_relations** — Show FKs and navigable relation paths
3. **query_plan** — Intent JSON → compiled SQL + plan report (deterministic)
   - Input: `intent` (Intent JSON v1), `options` (dialect, strict, tenantSchema)
   - Output: `{ sql, params, plan, meta }`
4. **intent_validate** — Validate Intent JSON with two-level validation:
   - Level 1: Structural (JSON Schema conformance)
   - Level 2: Semantic (tables/columns/relations exist in schema)
   - Output: `{ valid, errors: [{ code, message, path, suggestion? }] }`

### MVP Resources

1. **schema://manifest** — Full SchemaManifest JSON
2. **schema://intent-schema** — JSON Schema of Intent v1 format
3. **schema://cookbook** — 10 golden Intent examples (common patterns)

### Later (Nice to Have)

- **query_execute** — Run query (delegate to existing DB MCPs)
- **schema_suggest** — Query optimization suggestions

## Technical Considerations

**Constraints:**
- Reuse existing packages: core, schema, adapter-kysely
- MockAdapter for compile-only mode (no DB required)
- SchemaManifest JSON format (LOT-4)
- Node.js ESM, pnpm workspace

**Suggested stack:**
- `@modelcontextprotocol/sdk` (pin v1.x - stable)
- tsup for build
- Vitest for testing

**Architecture:**
```
packages/mcp-server/
├── src/
│   ├── index.ts              # MCP server entry point
│   ├── tools/
│   │   ├── schema-list.ts    # schema_list_tables
│   │   ├── schema-relations.ts # schema_get_relations
│   │   ├── query-plan.ts     # query_plan (Intent JSON → SQL)
│   │   └── intent-validate.ts # intent_validate (2-level)
│   ├── resources/
│   │   ├── schema-manifest.ts # schema://manifest
│   │   ├── intent-schema.ts   # schema://intent-schema
│   │   └── cookbook.ts        # schema://cookbook
│   ├── loader.ts             # Load schema with path security
│   └── intent-schema.json    # JSON Schema for Intent v1
├── package.json
└── tsconfig.json
```

## Risks

| Risk | Mitigation |
|------|------------|
| MCP SDK v2 breaking changes | Pin v1.x, test before upgrade |
| Path traversal in schema loader | Allowlist roots + resolve & validate paths |
| Complex intent format | Start with subset, iterate |
| Performance on large schemas | Lazy loading, caching |

## Security

**Schema Loader path security:**
- Allowlist of allowed root directories
- Reject paths that resolve outside roots (`../` traversal)
- Validate resolved path before loading

## Next Steps

1. ✅ TODO_MCP.md created for implementation tracking
2. Run `/prd` to generate full documentation
3. Implement MVP tools and resources
