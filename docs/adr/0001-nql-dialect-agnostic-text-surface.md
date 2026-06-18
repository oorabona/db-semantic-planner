# ADR 0001: NQL Dialect-Agnostic Text Surface

Status: canonical

## Context

NQL text is parsed and compiled into semantic query intents before any SQL adapter
emits database-specific text. Some NQL constructs currently map to PostgreSQL
SQL syntax, such as JSON operators, native range operators, `= ANY(:param)`, and
row-level lock clauses.

## Decision

The NQL compiler remains dialect-free. It must not branch on SQL dialects, rewrite
constructs into dialect-specific SQL, or silently drop unsupported constructs.
Dialect-specific text emission belongs to the adapter layer and is guarded by
`DialectCapabilities`.

Capability checks use backward-compatible support semantics: if capabilities are
undefined, the adapter preserves historical behavior and treats the construct as
supported. If a capability is explicitly `false`, the adapter fails loud before
emitting SQL.

## Portability Matrix

| NQL construct | Capability gate | PostgreSQL | MySQL 8+ | SQLite 3.38+ |
| --- | --- | --- | --- | --- |
| JSON operators: `->`, `->>`, `@>`, `<@`, `?` | `supportsJsonOperators` | Supported | Not portable as emitted; use JSON functions in a MySQL adapter | Partial JSON extract support, but not PostgreSQL containment/key operators |
| Range operators: `contains`, `containedBy`, `overlaps` | `supportsRangeTypes` | Supported with native range types | Not supported natively | Not supported natively |
| Array membership: `= ANY(:param)` | `supportsArrayType` | Supported with array parameters | Not portable as emitted | Not supported |
| Row-level lock strengths: `for update`, `for share`, `for no key update`, `for key share` | `supportsRowLevelLocks` | Supported | Coarse flag is PostgreSQL-only today; MySQL/MSSQL need per-strength modeling | Not supported |
| Lock wait policies: `skip locked`, `nowait` | `supportsLockWaitPolicies` | Supported | Coarse flag is PostgreSQL-only today; MySQL/MSSQL need per-strength modeling | Not supported |

## Consequences

Adapters may translate a semantic intent into their own SQL surface when they can
preserve semantics. If they cannot, they must set the relevant capability to
`false` and throw a clear unsupported-construct error at emission time.

`POSTGRESQL_CAPABILITIES` declares all PostgreSQL-backed NQL text constructs as
supported, so PostgreSQL behavior remains non-breaking.
