# mcp-server — Doc-code coherence snapshot 2026-04-20

## Inventory

| Doc | Size | Purpose |
|---|---|---|
| `packages/mcp-server/README.md` | 59 lines | User-facing: install + Quick Start + features + use cases |
| `packages/mcp-server/package.json` | 68 lines | Package metadata: bin, exports, peerDeps |
| `packages/mcp-server/src/index.ts::printHelp()` | ~25 lines | Canonical CLI usage (accurate) |

No `CLAUDE.md`, no ADRs, no guides dedicated to this package.

## Drift table

| # | Doc claim | Code reality | Severity |
|---|---|---|---|
| D1 | README L20-26: `"env": { "DBSP_SCHEMA": "./dbsp.schema.ts" }` | `index.ts::parseArgs` reads only `--schema` / `-s` / `=` variants. `process.env.DBSP_SCHEMA` is never referenced. | **S** |
| D2 | README L35: `DBSP_SCHEMA=./dbsp.schema.ts npx dbsp-mcp` | Same: env var ignored, command fails with "--schema argument is required" | **S** |
| D3 | README L40: "Schema exposure — Surfaces table names …" | `createMcpServer` registers zero tools; no schema tool exists | **M** |
| D4 | README L41: "Query planning — Accepts NQL or IntentAST …" | No query_plan tool exists; TODO stub only | **M** |
| D5 | README L42: "Intent validation — Validates AI-generated NQL queries …" | No intent_validate tool exists; TODO stub only | **M** |
| D6 | README L43: "Observability — Returns dump() output …" | Not wired; no tool calls any dump() | **M** |
| D7 | README L45: "Zero DB connection required — Works in compile-only mode" | Technically true (no pool), but "works" overstates reality since no tools exist | **L** |
| D8 | package.json L3: `"version": "1.0.0"` | server.ts L46 destructures default `version = '0.0.1'` — MCP clients see 0.0.1 | **M** |
| D9 | package.json L34: `exports["."].import → dist/index.js` | `dist/index.js` is the CLI binary with shebang; import fails to export library types | **M** |
| D10 | package.json L33 + src layout: no `src/api.ts` | All public types (`SchemaLoaderOptions`, `McpServerOptions`, `SchemaLoadError`) are `export`ed from impl files but not re-exported through an entry point | **L** |

## Missing docs

| Gap | Impact |
|---|---|
| No CLI reference doc (depends on `--help`) | Users can't discover `--allowed-root` flag without running the binary |
| No security model doc | `allowedRoots`' opt-in nature is invisible — users don't know they need it |
| No mention of the scaffold state anywhere | README reads as a shipping product; package version reinforces that |
| No guides/integration example that actually works | Claude Desktop / Cursor users have no verified path to a working setup |

## Coherence score

**3 / 10.** Two of ten README lines are factually broken at copy-paste; four more overstate implemented features. The CLI self-help in `printHelp()` is accurate and diverges from the README — a clear split-brain between authored docs and code-owned docs.

## Recommendations (for Phase 3)

- Rewrite README Quick Start with the `--schema` CLI form (not env var)
- Replace "Key features" with a "Planned features" / "Status: pre-release scaffold" banner
- Add a one-line link to `src/index.ts::printHelp()` output or reproduce its content
- Optionally, add `docs/guides/how-to-integrate-mcp-server.md` once at least one tool ships
