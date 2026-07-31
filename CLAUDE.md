# db-semantic-planner

## Project Context

### Vision

Semantic query planning for databases - an intent-first approach that transforms declarative query intents into optimized SQL with full observability.

### Key Principles

- **Intent-first:** Declare WHAT to fetch, planner decides HOW
- **Type-safe:** Full TypeScript inference from schema to results
- **Observable:** Every decision is inspectable via dump()
- **Deterministic:** Same inputs always produce same SQL/plan
- **Secure:** Identifier validation, parameter binding, no raw SQL exposure
- **Native Adapter APIs:** ALWAYS use adapter primitives (parameterized queries, AST-based compilation), NEVER raw SQL templates except for explicit user escape hatches (see Adapter Rules below)

## Architecture: Ports & Adapters (ARCH-001)

```
┌─────────────────────────────────────────────────────────────────┐
│                        packages/core                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  ModelIR    │  │  IntentAST  │  │  Semantic Planner       │  │
│  │  (Schema)   │→→│  (Query)    │→→│  (Plan + PlanReport)    │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  DX Layer (core/src/dx/)                                │    │
│  │  • Adapter interface  • createOrm()  • Query builders   │    │
│  │  • Filter helpers     • Strict mode  • Schema scoping   │    │
│  └─────────────────────────────────────────────────────────┘    │
│  DB-AGNOSTIC: MUST NOT import adapter code                      │
└──────────────────────────────┬──────────────────────────────────┘
                               │ implements Adapter
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    packages/adapter-pgsql                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Compiler   │  │ PgsqlAdapter│  │  PostgreSQL-native       │  │
│  │  (SQL gen)  │  │  (Engine)   │  │  (pg Pool)              │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│                                                                 │
│  PostgreSQL-native • No ORM dependency • Direct pg Pool         │
└─────────────────────────────────────────────────────────────────┘
```

### API Pattern

```typescript
import { createOrm, eq } from '@dbsp/core';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';

// Create ORM with adapter injection
const orm = createOrm({
  schema: db,
  adapter: createPgsqlAdapter(pgPool)
});

// Query with the concise table-name API
const users = await orm.select('users').where(eq('active', true)).all();

// Use the TableRef API when column refs should carry column-level types
const { users: usersTable } = orm.tables;
const usersFromRef = await orm
  .from(usersTable)
  .where(eq(usersTable.active, true))
  .all();
```

### Dependency Rules (STRICT)

| Package | May Import | Must NOT Import |
|---------|------------|-----------------|
| `packages/types` | — | everything else |
| `packages/nql` | `types` | `core`, `adapter-pgsql` |
| `packages/core` | `types`, `nql` | `adapter-pgsql` |
| `packages/adapter-pgsql` | `types`, `core` | — |

The rule that matters is the last column: **core must not reach for an adapter.** Core is not
dependency-free — `core/src/dx/nql.ts` imports `@dbsp/nql`, and both it and `nql` import `@dbsp/types`
— and reading the first column as "nothing" is what makes the build order above look arbitrary.

### Enforcing Architecture (Recommended)

**Option 1: TSConfig Project References**

```jsonc
// packages/core/tsconfig.json
{
  "compilerOptions": {
    "composite": true,
    "paths": {}  // No paths to adapter
  }
}

// packages/adapter-pgsql/tsconfig.json
{
  "references": [{ "path": "../core" }],
  "compilerOptions": {
    "paths": {
      "@dbsp/core": ["../core/src"]
    }
  }
}
```

**Option 2: Dependency Cruiser**

```javascript
// .dependency-cruiser.cjs
module.exports = {
  forbidden: [
    {
      name: 'core-no-adapter',
      from: { path: 'packages/core' },
      to: { path: 'packages/adapter-' }
    }
  ]
};
```

**CI Integration:** Add architecture check to CI pipeline to prevent violations.

## Scopes

| Scope | Package | Description | Status |
|-------|---------|-------------|--------|
| `core` | `packages/core` | Schema, Query AST, Planner, DX layer, Adapter interface | Complete |
| `adapter` | `packages/adapter-pgsql` | SQL compiler, PgsqlAdapter, PostgreSQL-native | Complete |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript (strict mode) |
| Runtime | Node.js (ESM preferred) |
| Primary DB | PostgreSQL |
| Adapter | pg (PostgreSQL native) |
| Testing | Vitest |
| Build | tsup (ESM + CJS) |

## Dependency Versions (BLOCKING)

**Every third-party dependency is declared once, in the `catalog:` of `pnpm-workspace.yaml`, and every `package.json` references it as `"catalog:"`.** This holds for all four blocks — `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` — and for every package, including `peerDependencies` whose range is published to consumers. A literal version range in a package manifest is a defect, not a preference.

**Workspace packages use the workspace protocol, and its two forms are not interchangeable.** On publish, pnpm replaces `workspace:*` with the exact version and `workspace:^` with a caret range, so the form chosen *is* the published dependency contract. An exact version can be shared with a consumer's own copy only when that consumer's range accepts exactly it; a caret range meets a wider set. Neither form forbids or guarantees a single copy — the form decides how often one is reachable, and a consumer who cannot reach one gets the "two copies in one process" shape of #387, a level up.

The repository is currently mixed and not by design: `@dbsp/cli` publishes exact pins on all four of its dbsp dependencies, while `@dbsp/core` and `@dbsp/nql` publish caret ranges, and `@dbsp/adapter-pgsql` does both in the same manifest (`@dbsp/core` exact, `@dbsp/types` caret). Do not "normalize" this in passing — changing either direction alters a published contract and is a semver decision, tracked in #396.

**Keep the catalog current.** `pnpm outdated -r` is expected to be empty; bump the catalog rather than letting a package pin an older range to avoid an upgrade.

| Forbidden | Required |
|-----------|----------|
| `"pg": "^8.16.0"` in a package | `"pg": "catalog:"` |
| A wider peer range than the catalog "to be permissive" | One range, in the catalog — if consumers need a wider one, widen the catalog |
| The same dependency declared in two manifests with the same literal range | One catalog entry, two `"catalog:"` references |

**Why this is BLOCKING and not hygiene.** pnpm resolves a package that pins its own range separately from the catalog's, so the two can land on different versions and both load in one process, with code written against one running against the other. #387: `@dbsp/cli` declared `pg` as a peer at `^8.16.0` while the catalog was `^8.22.0`; the CLI resolved pg 8.20 and the adapter pg 8.22, so adapter code read `_txStatus` — a field pg records from 8.21 — off a client that never had it. `inTransaction` then answered `true` for an idle session on a borrowed or pinned client, and it went unnoticed because nothing compared manifests against the catalog.

**A compatibility floor is a claim about upstream, so read upstream.** The catalog entry for `pg` was written as `^8.22.0` on the belief that 8.22 introduced `_txStatus`; the published tarballs say 8.21 does, identically. That one wrong minor, once published as `@dbsp/cli`'s peer range, would have excluded every working 8.21 consumer and forced them into a second copy — the defect the entry exists to prevent, caused by the fix. Check the artefact consumers install, not a changelog or a memory.

**How it is enforced**, by two guards over different surfaces. `pnpm install --frozen-lockfile` reconciles manifests and lockfile, and CI runs it immediately before the guards; the guards do not duplicate that reconciliation. `scripts/check-catalog.mjs` (`pnpm check:catalog`) reads `pnpm-workspace.yaml` as the authority for every catalog entry, including unused ones. It reads every workspace manifest block by block, requiring every present dependency block to be a map and every declaration to use the exact form its identity requires: `catalog:` for third-party packages, `workspace:*` or `workspace:^` for workspace packages.

Reading manifests block by block is load-bearing. The lockfile and `pnpm list` both collapse a name declared in multiple dependency blocks, so neither can see a peer range shadowed by a dev dependency of the same name. A published peer drifting from the catalog is #387's shape, so the source declarations remain the complete check for it.

The resolution rule comes from `pnpm list -r --depth 0 --json`: each direct dependency name has one version across the workspace, and a workspace name resolves to the checked-out project bearing that name. This guard parses no version token at all. That is intentional: the list reports plain direct versions and a workspace target path, so peer contexts, nested peer contexts, and patch suffixes never become a grammar the guard must model. The lockfile importer set and pnpm's discovered project set must still agree in both directions, making a non-shared lockfile visible without reproducing pnpm's workspace-glob rules.

There are honest bounds. An `overrides` entry or patch that moves every project off the catalog in unison is not detected; a divergence affecting only some projects still appears as two versions. `publish.yml` snapshots the lockfile and importer manifests after `check-catalog` but before builds; that snapshot, not the mutable post-pack worktree, is the authority for `scripts/check-packed.mjs`. The packed guard verifies the dependency contract and package identity, not a whole-manifest prediction: every dependency block is a map with the source key set; catalog and workspace markers have their exact published substitutions; no unresolved protocol remains; the packed name/version bind to its project; and source and packed candidates have exactly `publishConfig: {"access":"public"}`. It also refuses bundled dependencies, a shrinkwrap, and ambiguous normalised manifest entries. A lifecycle hook that rewrites an unrelated field such as `bin` or `exports` is outside that bound.

**Both guards check for a wrong answer, not for a hostile one, and the difference decides what belongs in them.** The artefact check exists because this repository has already published a wrong manifest: 1.0.0 went out with `workspace:` markers still in it. That is the class it catches — a substitution that did not happen, a dependency that appeared or vanished, or the package identity that changed. It is not a defence against a compromised build step or a hostile committer, and it cannot be one: the guards are versioned in the repository they check, and the job that builds also verifies and publishes in one workspace. So a proposed rule earns its place by answering *what accident does this catch?* — refusing a symlink in a tarball our own CI produced answers nothing, while refusing `bundleDependencies` catches a real npm feature added without understanding it. Isolating the publish step from the build is a real improvement and a separate change; overclaiming it here would be worse than the gap.

**The accepted declaration forms are a closed set, and every widening is a way back to two versions.** `catalog:legacy` can name a second range for a package the default catalog already names, so named catalogs are refused outright rather than at each reference. `workspace:~` publishes a different contract from `*` and `^`. Needing either is a deliberate decision that starts by editing the guard.

That distinction was learned the hard way: four consecutive review rounds found a different pnpm spelling the guard read wrongly, and each patch admitted the next one. The code now follows the lesson: add rules about resolutions, do not add another parser.

**And it refuses inputs it cannot reason about, rather than certifying around them.** A pnpmfile is refused on the `pnpmfileChecksum` pnpm records, which is written whatever the hook file is called or wherever `pnpmfile:` points it; absence is detection rather than proof, since a hook can appear after this install or only while packing. `bundleDependencies` and `bundledDependencies` are refused in any manifest, both spellings, because a bundled copy ships inside the tarball where no range comparison can see it. A project whose effective manifest is `package.json5` or `package.yaml` stops the check, since it cannot parse pnpm's effective semantics; either file beside a `package.json` is inert and accepted.

Transitive duplication is out of scope and must stay so: 99 of this workspace's 1021 transitive packages legitimately resolve to more than one version, and 131 instances carry a peer context. That is the normal shape of a pnpm store, not a defect.

`catalogMode: strict` complements these by making `pnpm add` refuse a version outside the catalog — that path only; an install that regenerates the lockfile is accepted. Do not add another mechanism: if something slips through, it slips through one of these, and the fix belongs in the one whose surface it slipped through.

**When adding a dependency**: add it to the catalog first, then reference `"catalog:"`. When a dependency has exactly one consumer today, it still goes in the catalog — the second consumer is what creates the divergence, and by then nobody remembers to look.

## Adapter Rules (CRITICAL)

**NEVER use raw SQL templates in adapter implementations.** Always use the adapter's native expression builders.

### PostgreSQL Adapter (`packages/adapter-pgsql`)

The adapter compiles `PlanReport` into parameterized SQL strings using an internal AST-to-SQL compiler. No ORM dependency — queries execute directly against a `pg.Pool`.

| Principle | Detail |
|-----------|--------|
| Parameterized queries | All user values use `$N` positional parameters |
| Identifier quoting | All table/column/schema names double-quoted |
| No raw SQL in compiler | The compiler builds SQL strings from the plan AST |

### Compile-Only Mode

For CLI/tooling that needs SQL compilation without a database connection:

```typescript
import { createOrm, eq } from '@dbsp/core';
import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';

const adapter = createPgsqlCompileOnlyAdapter();
const orm = createOrm({ schema: db, adapter });
const { sql, params } = orm.select('users').where(eq('active', true)).dump();
// sql, params — no Pool needed

// Attach observability metadata (correlationId for distributed tracing, queryName for logging):
const requestId = 'req-abc-123'; // typically from req.headers['x-request-id']
const dump = orm.select('users').where(eq('active', true))
  .dump({ queryName: 'fetch-active-users', correlationId: requestId });
console.log(dump.meta?.correlationId);
```

## Schema Scoping API

**Public API:** `orm.withSchema(schemaName)`

```typescript
// Returns a schema-scoped ORM context
const scopedOrm = orm.withSchema('tenant_123');
const users = await scopedOrm.select('users').all();
// SQL: SELECT * FROM "tenant_123"."users"
```

**Security:** Schema name MUST be validated against allow-list pattern (identifier validation).

- **Schema name validation:** both `orm.withSchema(name)` AND `adapter.compile(plan, { schemaName })` validate the schema name via `validateIdentifier`. Direct callers of the adapter's compile path are protected against SQL injection in addition to the ORM-level entry point.

## DDL Features

The PostgreSQL adapter supports the following DDL schema features via `compareSchemata()` and `generateDDL()`:

- Tables, columns, types (enums, sequences), extensions
- Indexes, check constraints, foreign keys, comments
- **Row-Level Security (RLS):** `rlsEnabled` + `policies[]` on TableIR — see `packages/docs/guide/rls-policies.md`
- Feature support is gated by `DialectCapabilities` flags (e.g. `supportsDDLRowLevelSecurity`)

### Runtime DDL Helpers (`orm.tables.<name>`)

| Method | Description |
|--------|-------------|
| `.truncate(options?)` | TRUNCATE TABLE — options: `{ cascade?, restartIdentity? }` |
| `.vacuum(options?)` | VACUUM — options: `{ full?, analyze? }` |
| `.storageSize()` | Returns total table size in bytes (`pg_total_relation_size`) |
| `.alterColumn(col, options)` | ALTER COLUMN — options: `{ type?, using?, setNotNull?, setDefault?, dropDefault? }` |
| `.indexes.create(options)` | CREATE INDEX — supports all methods: btree, gin, hnsw, bm25, etc. |
| `.indexes.drop(name, options?)` | DROP INDEX — options: `{ ifExists?, cascade?, concurrently?, schema? }` |
| `.indexes.list(options?)` | List indexes — options: `{ namePattern? }` → `IndexInfo[]` |
| `.indexes.exists(name)` | Returns `boolean` — whether index exists on this table |
| `orm.ddl.dropIndex(name, options?)` | Global shortcut — drop by name without a table reference |

All helpers respect `orm.withSchema()`. See `packages/docs/guide/ddl-provisioning.md`.

## Query Features

| Feature | API | Example |
|---------|-----|---------|
| Expression primitives | `op()`, `fn()`, `ref()`, `param()`, `cast()`, `literal()`, `unary()`, `namedArg()` | `op('<=>', ref('vector'), cast(param(qv), 'vector'))` |
| pgvector | `cosineDistance()`, `rawDistance()`, `l2Distance()`, `innerProduct()` | `cosineDistance('vector', qv).as('score')` |
| ParadeDB (low-level) | `score()`, `bm25Search()`, `parse()`, `boost()`, `booleanSearch()` | `bm25Search('s', term, { name: 3.0 })` |
| Full-text search | `fullTextSearch()`, `textScore()` | `fullTextSearch({ query, fields, tableAlias })` — preferred over `bm25Search`; see `packages/docs/guide/full-text-search.md` |
| PG builtins | `generateSeries()`, `nextval()`, `isDistinctFrom()` | `generateSeries(1, 100)`, `nextval('seq')` |
| INNER JOIN | `include('rel', { join: 'inner' })` | Filters root rows by relation |
| Manual JOIN | `.join(rel)` / `.join(table, { on, as, type })` — flat, non-hydrating | `orm.select('calls').join('caller')` / `.join('t', { on: eq(...), as: 'alias' })` |
| DISTINCT ON | `.distinctOn('col1', 'relation.col')` | PostgreSQL DISTINCT ON, including relation-column alias resolution |
| Set operations | `.union()`, `.unionAll()`, `.intersect()`, `.except()` | `q1.union(q2).all()` |
| IN subquery (= ANY) | `inSubquery('id', subquery('posts').select('userId'))` | Compiled as `col = ANY (SELECT ...)` |
| Scalar subquery | `subquery('t').count().asExpr('cnt')` | Subquery as SELECT column |
| Conditional upsert guard | `.doUpdate(set, exists('relation'))` | `ON CONFLICT ... DO UPDATE ... WHERE EXISTS (...)` |
| NQL tag mutations | ``orm.nql`insert into t set x = ${v}`.dump()/.run()/.all()`` | `.dump()` compile-only; execution runs mutation hooks; read-only `\| bind` pipelines may feed one final mutation |
| Param type casting | Automatic `CAST($N AS type)` via ModelIR `originalDbType` | Prevents nullable column type mismatch |
| CASE expressions | `caseWhen().when(cond, val).when(...).else(val).as(alias)` — in columns + orderBy | `caseWhen<string>().when("status='a'", 'Active').else('Other').as('label')` |
| Range operators (PostgreSQL) | `rangeOverlaps()`, `rangeContains()`, `rangeContainedBy()` | `rangeOverlaps('period', ['2024-01-01', '2024-01-31'])` — covers `daterange`, `int4range`, `tsrange`, etc. |
| Guides | **`packages/docs/guide/`** — the docs live there (VitePress), not in `docs/guides/`: `expression-primitives`, `extensions`, `rls-policies`, `case-expressions`, `ddl-provisioning`, `joins`, `recursive-cte`, `batch-values`, `full-text-search`, `schema-versioning`, `result-hydration`, `transactions`, `raw-sql`. Nav lives in `packages/docs/.vitepress/config.ts` — a new page must be wired in there or nobody finds it. | |

## Observability

Every query produces a `Dump`:

```typescript
type Dump = {
  plan: PlanReport;      // Decisions + reasoning + warnings
  sql: string;           // Compiled SQL
  params: readonly unknown[]; // Bound parameters
  meta?: {
    schema?: string;      // Schema name if schema-scoped
    queryName?: string;   // Optional label
    correlationId?: string;
  };
};
```

## Documentation

- **How-to guides:** `packages/docs/guide/` — feature-specific walkthroughs (joins, CTEs, RLS, DDL helpers, raw SQL, etc.). NOT `docs/guides/`, which holds only the e2e-testing guide.
- **Comparison:** `packages/docs/comparison.md` — how this project compares to other query builders and ORMs
- **Patterns:** `packages/docs/patterns.md` — recommended query patterns and best practices
- **Production:** `packages/docs/guide/production.md` — deployment, connection pooling, schema scoping for multi-tenancy
- **CLI usage:** `packages/docs/guide/cli-usage.md` — command-line interface reference
- **E2E / integration tests:** `docs/guides/how-to-write-e2e-integration-tests.md` — real-DB row-asserting tests (`pnpm test:e2e`, testcontainers harness)

## Build Order

```
packages/types → packages/nql → packages/core → packages/adapter-pgsql
```

Each step consumes the previous one's `dist/`, so building out of order fails with errors that read
like missing exports in the *sources* — `Module './intent-ast.js' has no exported member …`, or
`Cannot find module '@dbsp/nql'` from `core/src/dx/nql.ts`. The cause is the order, not the code.

## Getting Started

Install dependencies and build all packages:

```bash
pnpm install
pnpm -C packages/types build
pnpm -C packages/nql build
pnpm -C packages/core build
pnpm -C packages/adapter-pgsql build
```

Run tests:

```bash
pnpm test
```

Type-check:

```bash
pnpm tsc --noEmit
```

## NFRs

- **Type safety:** Strong TypeScript types throughout
- **Zero/minimal runtime deps:** Tree-shakeable, pg as peer
- **Full test coverage:** Unit + integration + golden tests
- **Deterministic:** Same inputs → same SQL/plan (stable aliasing)
- **Observability:** dump() = plan + SQL + params
- **Security:** Identifier validation, param redaction in logs
- **Performance:** Anti "row explosion" defaults, minimal JS overhead

## Out of Scope

These features are intentionally deferred:

- Cost-based optimization or join reordering
- NL-to-SQL / AI query generation
- Full ORM behavior (change tracking, dirty checking, migrations)
- Multi-dialect correctness guarantees (PostgreSQL-focused)
