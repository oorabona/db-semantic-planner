# Security Analysis

**Date:** 2026-01-31
**Overall Rating:** :green_circle: STRONG (A-)

---

## Quick Security Check

| Check | Status | Notes |
|-------|--------|-------|
| No hardcoded secrets | :green_circle: | No .env, no API keys in source |
| Input validation | :green_circle: | Identifier validation + param binding |
| SQL injection prevention | :green_circle: | AST-based SQL gen + parameterized queries |
| Schema/tenant isolation | :green_circle: | validateIdentifier() on schema names |
| Secure dependencies | :green_circle: | All current versions (pg 8.16.3, etc.) |
| Error handling safe | :green_circle: | CLI redacts DB URLs, adapter re-throws |
| No eval/Function | :green_circle: | Zero dynamic code execution |
| No ReDoS risk | :green_circle: | All NQL regex patterns are linear-time |

---

## OWASP Top 10 Mapping

| OWASP Category | Applicability | Status | Details |
|----------------|---------------|--------|---------|
| A01: Broken Access Control | :yellow_circle: Partial | :green_circle: Mitigated | Schema scoping validates identifiers; no row-level security |
| A02: Cryptographic Failures | :white_circle: N/A | - | No encryption/hashing responsibilities |
| A03: Injection | :red_circle: Critical | :green_circle: SAFE | AST-based SQL generation, parameterized queries, identifier quoting |
| A04: Insecure Design | :yellow_circle: Partial | :green_circle: Good | Ports & Adapters architecture, immutable query building |
| A05: Security Misconfiguration | :yellow_circle: Partial | :green_circle: Good | Compile-only mode, no default credentials |
| A06: Vulnerable Components | :yellow_circle: Partial | :green_circle: Clean | `pnpm audit` clean, minimal dependencies |
| A07: Auth Failures | :white_circle: N/A | - | No auth layer |
| A08: Data Integrity | :yellow_circle: Partial | :green_circle: Good | Parameterized queries prevent tampering |
| A09: Logging/Monitoring | :yellow_circle: Partial | :yellow_circle: Limited | `dump()` for observability, but no audit trail for raw SQL escape hatch |
| A10: SSRF | :white_circle: N/A | - | No outbound HTTP requests |

---

## SQL Injection Prevention Architecture

```
User Input                    Security Layer                         PostgreSQL
─────────────────────────────────────────────────────────────────────────────────

NQL string ──► Lexer ──► Parser ──► AST ──► Planner ──► Compiler ──► $N params
                                                            │
                                                     AST-based generation
                                                     (never string concat)
                                                            │
Schema name ──► validateIdentifier() ──► double-quoted ─────┘
                  │
                  ├─ Regex: /^[a-zA-Z_][a-zA-Z0-9_$]*$/
                  ├─ Max length: 63 chars
                  └─ Throws InvalidIdentifierError on failure

Filter values ──► Parameter binding ($1, $2, ...) ─────────► pg.Pool.query()
                  (never interpolated into SQL string)
```

### Three Defense Layers

1. **Parameter Binding** (`param-ref.ts`): All user values use `$N` positional parameters. ParamRef validated (1-65535 range).
2. **Identifier Validation** (`validate.ts`): All table/column/schema names validated against `/^[a-zA-Z_][a-zA-Z0-9_$]*$/`, max 63 chars, control character rejection.
3. **AST-based SQL Generation** (`compiler.ts` → `ast-helpers.ts` → `deparse.ts`): SQL never constructed via string templates. Uses `pgsql-deparser` library for consistent quoting.

---

## Multi-Tenant Isolation

### withSchema() Security Model

```typescript
// Normal usage
const tenantOrm = orm.withSchema('tenant_abc');
// SQL: SELECT * FROM "tenant_abc"."users"

// Attack attempt — blocked at validation layer
orm.withSchema('tenant"; DROP TABLE users--');
// → throws InvalidIdentifierError (regex rejects semicolons, quotes, spaces)
```

### Security Controls

| Control | Location | Description |
|---------|----------|-------------|
| Identifier validation | `validate.ts:156-213` | Regex `/^[a-zA-Z_][a-zA-Z0-9_$]*$/`, max 63 chars |
| Immutable scoping | `orm.ts:348-356` | Clone pattern prevents mutation of parent ORM |
| SQL quoting | `deparse.ts` | Double-quoted identifiers via pgsql-deparser |
| Injection test | `pgsql-adapter.test.ts:342` | Verifies `tenant"; DROP TABLE` throws |

---

## Sensitive Data Handling

| Concern | Status | Mechanism |
|---------|--------|-----------|
| Parameter redaction in logs | :green_circle: | `dump()` returns params separately; logging can redact |
| SQL in error messages | :yellow_circle: | Compiled SQL may appear in stack traces |
| Schema names in errors | :green_circle: | Validation errors don't leak valid schema names |
| Connection strings | :green_circle: | pg Pool accepts config object, not exposed in queries |

---

## Findings

| ID | Severity | Issue | Location |
|----|----------|-------|----------|
| SEC-001 | MEDIUM | Raw SQL escape hatch without audit trail | `adapter-pgsql/src/handlers/expression/raw.ts:26-41` |
| SEC-002 | LOW | Cursor names use `Math.random()` (not crypto) | `adapter-pgsql/src/pgsql-adapter.ts:1721` |
| SEC-003 | LOW | Silent error suppression in tx rollback | `adapter-pgsql/src/pgsql-adapter.ts:1700-1704` |
| SEC-004 | INFO | `parameters as any[]` for pg compatibility | `adapter-pgsql/src/pgsql-adapter.ts:1612` |

### SEC-001: Raw SQL Escape Hatch

- **By design**: Documented last-resort feature for unsupported PostgreSQL syntax
- **Mitigations**: Requires explicit `type: 'raw'` in Decision API, logs warning in dev mode
- **Risk**: No centralized audit trail when raw SQL is used in production
- **Recommendation**: Add centralized audit log, consider `DBSP_DISABLE_RAW_SQL=true` flag for production

### SEC-002: Math.random() for Cursor Names

- **Risk**: Predictable cursor names in concurrent streaming scenarios. Not exploitable for injection (names are quoted), but could cause name collisions.
- **Recommendation**: Replace with `crypto.randomUUID()` for uniqueness guarantee.

---

## Dependency Analysis

| Package | Direct Deps | Notable | Risk |
|---------|-------------|---------|------|
| `@dbsp/core` | `valibot`, `@dbsp/nql`, `@dbsp/types` | valibot for schema validation | LOW |
| `@dbsp/adapter-pgsql` | `pg`, `pgsql-deparser`, `@dbsp/core`, `@dbsp/types` | pg = PostgreSQL driver | LOW |
| `@dbsp/nql` | `chevrotain`, `@dbsp/types` | Chevrotain = parser generator | LOW |
| `@dbsp/types` | none | Zero dependencies | NONE |
| `@dbsp/cli` | `ink`, `commander`, `@dbsp/core`, `@dbsp/nql`, `@dbsp/adapter-pgsql` | ink = React for CLI | LOW |
| `@dbsp/mcp-server` | `@modelcontextprotocol/sdk`, `@dbsp/core` | MCP SDK | LOW |

**Supply chain notes:**
- All dependencies are well-known, actively maintained packages
- `pnpm audit` reports 0 vulnerabilities as of 2026-01-31
- Minimal dependency tree for a database toolkit

---

## Recommendations

1. **Add centralized audit logging** for raw SQL usage (currently `console.warn` only)
2. **Replace `Math.random()`** with `crypto.randomUUID()` for cursor names
3. **Log rollback errors at debug level** instead of silent suppression
4. Run `pnpm audit` in CI/CD pipeline
5. Consider fuzz testing NQL parser with random inputs

---

## References

- Project security policy: `SECURITY.md` (root)
- Identifier validation: `packages/adapter-pgsql/src/validate.ts`
- Multi-tenant tests: `tests/e2e/pimdam.q4.multitenant.test.ts`
- Previous audit: 2026-01-20 (18 items resolved since)
