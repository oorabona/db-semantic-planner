# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please report it responsibly.

### How to Report

1. **Do NOT** open a public GitHub issue for security vulnerabilities
2. Report vulnerabilities privately by emailing **oorabona@users.noreply.github.com** or using GitHub's [Private vulnerability reporting](https://github.com/oorabona/db-semantic-planner/security/advisories/new).
3. Include as much detail as possible:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### What to Expect

- **Acknowledgment:** Within 48 hours of your report
- **Initial Assessment:** Within 7 days
- **Resolution Timeline:** Depends on severity
  - Critical: 24-48 hours
  - High: 7 days
  - Medium: 30 days
  - Low: Next release cycle

### Disclosure Policy

- We follow coordinated disclosure practices
- We will credit reporters (unless anonymity is requested)
- Public disclosure occurs after a fix is available

## Security Best Practices

When using db-semantic-planner in your applications:

### Input Validation

- All user inputs are parameterized (never interpolated into SQL)
- Schema and table names are validated against identifier patterns
- The library rejects invalid identifiers at compile time

### Multi-Tenant Isolation

- Use `withSchema()` for tenant isolation
- Schema names must match the pattern: `^[a-zA-Z_][a-zA-Z0-9_]*$`
- Never pass user input directly as schema names without validation

### Logging

- Parameter values can be redacted in logs using `redactParams: true`
- Correlation IDs help trace queries without exposing sensitive data
- Never log raw SQL with interpolated user data

### Dependencies

- `pg` is the only runtime dependency for the PostgreSQL adapter
- We regularly audit dependencies for vulnerabilities
- Run `pnpm audit` to check for known issues

## Security Features

| Feature | Description |
|---------|-------------|
| Parameterized queries | All values are bound, never concatenated |
| Identifier validation | Schema/table/column names validated |
| Type safety | TypeScript prevents many injection vectors |
| No raw SQL by default | Raw SQL requires explicit `raw()` escape hatch |

## Scope

This security policy applies to:

- `@dbsp/core`
- `@dbsp/adapter-pgsql`
- `@dbsp/cli`
- `@dbsp/mcp-server`

Third-party integrations and user application code are outside our scope.
