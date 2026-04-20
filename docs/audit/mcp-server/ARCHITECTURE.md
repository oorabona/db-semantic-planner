# mcp-server — Architecture snapshot 2026-04-20

## Module map

```
packages/mcp-server/
├── src/
│   ├── index.ts           CLI entry + parseArgs + main bootstrap (184 LoC)
│   ├── schema-loader.ts   validatePath + loadSchema + validateSchemaStructure (241 LoC)
│   ├── server.ts          createMcpServer + startMcpServer (93 LoC)
│   ├── resources/         (empty — .gitkeep only)
│   └── tools/             (empty — .gitkeep only)
└── package.json           bin=dist/index.js, exports["."]=dist/index.js
```

## Execution flow

```mermaid
flowchart TD
  A[CLI invocation] --> B[parseArgs process.argv]
  B -->|throws on missing value| X1[UNCAUGHT: raw stack to stderr]
  B --> C{args.help?}
  C -->|yes| D[printHelp + exit 0]
  C -->|no| E{schemaPath empty?}
  E -->|yes| F[print usage + exit 1]
  E -->|no| G[try block]
  G --> H[loadSchema]
  H --> H1[validatePath]
  H1 -->|schemaPath contains '..' && !existsSync| X2[SchemaLoadError PATH_TRAVERSAL]
  H1 -->|file exists| H2[realpathSync + allowedRoots check]
  H1 -->|file absent| H3[return resolvedPath unchecked ← TOCTOU window]
  H --> I[pathToFileURL + dynamic import]
  I -->|user file executes| J[validateSchemaStructure duck-check]
  J --> K[return {schema, resolvedPath}]
  K --> L[startMcpServer]
  L --> M[createMcpServer — registers zero tools]
  M --> N[server.connect StdioTransport]
  G -->|SchemaLoadError| Z1[error code + message to stderr]
  G -->|other Error| Z2[raw message to stderr]
```

## Trust boundaries

| Boundary | Input | Trust | Current validation |
|---|---|---|---|
| CLI args → parseArgs | `process.argv` | Untrusted | No unknown-flag rejection; missing values throw ungracefully |
| schemaPath → validatePath | string from CLI | Untrusted | `..` check is gated on `!existsSync`; `allowedRoots` is opt-in |
| resolvedPath → dynamic import | path string | Should be trusted post-validation | TOCTOU: realpath only if pre-existing; no re-check before import |
| User schema module export → validateSchemaStructure | any | Untrusted | Duck-check on `tables`/`relations` only; arrays pass |
| `SchemaLoadError.message` → stderr | error text | Sanitized sink | Raw `error.message` from import failures forwarded — leaks absolute paths |

## Consumer map

- **Library consumers** (hypothetical): `import { loadSchema, createMcpServer } from '@dbsp/mcp-server'` — breaks because `exports["."]` points to CLI binary with shebang, not a library entry
- **CLI consumers**: `dbsp-mcp --schema ./schema.ts` — works (via bin entry)
- **MCP clients** (Claude Desktop, Cursor): connect via stdio, invoke tools — **every tool call returns "unknown tool"** because no tools are registered (all `MCP-003…MCP-007b` are TODO comments)
- **Internal**: no cross-package importers indexed

## Error-handling classification

| Code | Where | Current state |
|---|---|---|
| `PATH_TRAVERSAL` | schema-loader.ts:90 | Fires only on non-existent `..` paths — bypass on existing paths |
| `PATH_TRAVERSAL` (roots) | schema-loader.ts:120 | Fires only when `allowedRoots` explicitly provided |
| `NOT_FOUND` | schema-loader.ts:157 | Clean |
| `INVALID_SCHEMA` | schema-loader.ts:172, 220, 227, 232 | Duck-check only |
| `LOAD_FAILED` | schema-loader.ts:197, 207 | Raw error message forwarded — info leak |
| parseArgs `Error` (plain) | index.ts:49, 56 | Not caught by main's try/catch → uncaught exception |

## Scaffold gap

MCP tool/resource registrations are TODO stubs. `createMcpServer` builds a `serverContext` holding the schema reference, but nothing reads it. Logs at `server.ts:65-70` advertise table/relation counts as if tools were wired. Net effect: a publishable package at `1.0.0` that cannot service any MCP tool request.
