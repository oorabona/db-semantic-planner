# ADR-004: Core Package Layered Structure (Mixed Concerns Assessment)

---
doc-meta:
  status: accepted
  scope: core
  type: adr
  created: 2026-01-12
  decision-date: 2026-01-12
---

## Status

**ACCEPTED** (2026-01-12)

## Context

### Problem Statement

DX-109 raised a concern that `packages/core` mixes domain logic (ModelIR, IntentAST, Planner) with infrastructure (DX execution, hydration). This could be seen as a violation of clean architecture principles where domain should be separated from infrastructure.

### Current Structure

```
packages/core/src/
├── model-ir.ts           # Domain: Schema representation
├── model-impl.ts         # Domain: ModelIR implementation
├── intent-ast.ts         # Domain: Query intent AST
├── planner.ts            # Domain: Semantic planning
├── schema-builder.ts     # Domain: Schema DSL
├── adapter.ts            # Port: Adapter interface (contract)
├── dialects/             # Domain: Dialect capabilities
│   └── index.ts
├── dx/                   # Application: DX layer
│   ├── orm.ts            # ORM factory + QueryBuilder
│   ├── query-executor.ts # Execution orchestration
│   ├── result-hydrator.ts# Include hydration
│   ├── intent-builder.ts # Intent construction
│   ├── mutation-builders.ts
│   ├── filters.ts        # Filter helpers (eq, gt, etc.)
│   ├── schema-bridge.ts  # Schema conversion
│   ├── types.ts          # DX types
│   └── errors.ts         # DX errors
└── index.ts              # Public exports
```

### Dependency Analysis

**Domain layer** (model-ir, intent-ast, planner, schema-builder):
- Has ZERO imports from adapter.ts or dx/
- Is completely pure and portable
- Can be tested in isolation

**Port** (adapter.ts):
- Defines the Adapter interface contract
- Imports types from domain (IntentAST, ModelIR, PlanReport)
- No external dependencies

**Application layer** (dx/):
- Imports from domain (intent-ast, model-ir, planner)
- Imports from port (adapter interface)
- Orchestrates domain + adapter to provide DX API

```
┌─────────────────────────────────────────────────────────────────┐
│                    Dependency Direction (Clean)                  │
│                                                                 │
│  Domain Layer ←── Application Layer (dx/) ←── External Code    │
│  (model-ir,        (orm.ts, query-executor,    (user code,      │
│   intent-ast,       result-hydrator)            adapters)       │
│   planner)                                                      │
│                                                                 │
│  Domain Layer ←── Port (adapter.ts)                             │
│  (types only)      (interface contract)                         │
└─────────────────────────────────────────────────────────────────┘
```

### Options Considered

#### Option A: Separate `@db-semantic-planner/dx` Package

Move dx/ to a separate package.

```
packages/core/         → Domain + Port only
packages/dx/           → Application layer (QueryBuilder, ORM)
packages/adapter-kysely/ → Kysely implementation
```

**Pros:**
- Strictest separation of concerns
- Enforced at package boundary
- Clear "core is pure domain" message

**Cons:**
- **Breaking change** (import paths change again)
- **Already rejected** in ADR-002 (packages/dx was merged into core precisely to avoid this)
- **User fatigue**: 3 packages to install/import instead of 2
- **Circular concern**: dx depends on core, but users want to import everything from one place
- **Build complexity**: Additional package to maintain, version, publish

#### Option B: Keep in Core with Internal Layering (Selected)

Document the current structure as intentional and enforce layering via conventions/tooling.

**Pros:**
- No breaking change
- Simpler for users (import from core)
- Already well-organized with dx/ subdirectory
- Layering is correct (dx → domain, not reverse)

**Cons:**
- Not enforced at package boundary
- Requires discipline to maintain layering

#### Option C: Rename dx/ to application/ or infra/

Cosmetic change to better communicate the layer's purpose.

**Rejected**: dx/ is established nomenclature, and the name matters less than the structure.

## Decision

**Option B: Keep the current structure and document it as intentional Hexagonal Architecture.**

The current organization is actually a **proper implementation of Ports & Adapters (Hexagonal Architecture)**:

| Layer | Location | Purpose | Dependencies |
|-------|----------|---------|--------------|
| **Domain** | `model-ir.ts`, `intent-ast.ts`, `planner.ts` | Business logic (schema, queries, planning) | None |
| **Port** | `adapter.ts` | Interface contract for adapters | Domain types only |
| **Application** | `dx/` | Orchestration layer (QueryBuilder, ORM) | Domain + Port |
| **Adapter** | `packages/adapter-*` | External implementations | Core (implements Port) |

The dx/ layer is the **application layer** in hexagonal terms - it orchestrates domain logic through the port interface. This is not a violation; it's the intended architecture.

### Enforcement Strategy

1. **TSConfig paths**: Already enforced - adapter packages cannot import from dx/
2. **Dependency Cruiser** (recommended): Add rule to prevent domain → dx imports
3. **Code review**: Maintain awareness of layer boundaries
4. **Documentation**: This ADR serves as the canonical reference

## Consequences

### Positive

1. **No breaking changes**: Users continue importing from `@db-semantic-planner/core`
2. **Clear mental model**: One package with well-organized layers
3. **Reduced complexity**: Two packages (core + adapter) instead of three
4. **Aligned with ADR-002**: Reinforces the original decision

### Negative

1. **No compile-time boundary**: Layering not enforced at package level
2. **Potential drift**: Future contributions could violate layering without detection

### Mitigation

Add dependency-cruiser rule to CI:

```javascript
// .dependency-cruiser.cjs (recommended addition)
module.exports = {
  forbidden: [
    {
      name: 'domain-no-dx',
      comment: 'Domain layer must not import from dx/',
      from: { path: 'packages/core/src/(model-ir|intent-ast|planner|schema-builder)\\.ts' },
      to: { path: 'packages/core/src/dx/' }
    }
  ]
};
```

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    @db-semantic-planner/core                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  DOMAIN LAYER (Pure, No External Dependencies)          │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │   │
│  │  │  ModelIR    │  │  IntentAST  │  │  Planner    │      │   │
│  │  │  (Schema)   │  │  (Query)    │  │  (Plan)     │      │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘      │   │
│  │  ┌─────────────┐  ┌─────────────────────────────────┐   │   │
│  │  │ Dialects    │  │ SchemaBuilder (defineSchema)    │   │   │
│  │  └─────────────┘  └─────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              ↑                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  PORT (Interface Contract)                              │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │ Adapter Interface (compile, execute, stream...) │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              ↑                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  APPLICATION LAYER (dx/) - Orchestration                │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │   │
│  │  │ createOrm() │  │QueryBuilder │  │ MutationBuilders│  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │   │
│  │  │  Filters    │  │ResultHydrator│ │ QueryExecutor   │  │   │
│  │  │ (eq,gt...)  │  │             │  │                 │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              ↑
                    implements Adapter
                              ↑
┌─────────────────────────────────────────────────────────────────┐
│                 @db-semantic-planner/adapter-kysely             │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  ADAPTER LAYER (External Implementation)                │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │   │
│  │  │ Compiler    │  │KyselyAdapter│  │ Multi-dialect   │  │   │
│  │  │ (SQL gen)   │  │ (Engine)    │  │ (capabilities)  │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Verification

The layering can be verified by checking imports:

```bash
# Domain layer should NOT import from dx/
grep -r "from '\.\./dx\|from '\./dx" packages/core/src/*.ts
# Expected: no matches (except index.ts re-export)

# dx/ layer CAN import from domain
grep -r "from '\.\.\/" packages/core/src/dx/*.ts
# Expected: imports from intent-ast, model-ir, planner, adapter
```

## References

- [ADR-002: Merge dx Package into core](./ADR-002-merge-dx-into-core.md) - Original decision to merge
- [CLAUDE.md Architecture Section](../../CLAUDE.md) - Project architecture overview
- [DX-109 in TODO_DX.md](../../TODO_DX.md) - Original concern that triggered this analysis
- [Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture/) - Alistair Cockburn's pattern
