# Architecture Overview

## System Context Diagram

```mermaid
graph TB
    subgraph "External"
        User[Developer / CLI User]
        PG[(PostgreSQL)]
        MCP[MCP Client]
    end

    subgraph "db-semantic-planner"
        Core["@dbsp/core<br/>Schema + Planner + DX"]
        Adapter["@dbsp/adapter-pgsql<br/>SQL Compiler + Executor"]
        NQL["@dbsp/nql<br/>NQL Parser"]
        Types["@dbsp/types<br/>Shared Types"]
        CLI["@dbsp/cli<br/>REPL + Batch"]
        MCPSrv["@dbsp/mcp-server<br/>MCP Protocol"]
    end

    User --> CLI
    User --> Core
    MCP --> MCPSrv
    Core --> Adapter
    Core --> NQL
    Core --> Types
    NQL --> Types
    Adapter --> Core
    Adapter --> Types
    Adapter --> PG
    CLI --> Core
    CLI --> NQL
    CLI --> Adapter
    MCPSrv --> Core
```

## Component Diagram (Ports & Adapters)

```mermaid
graph TB
    subgraph "packages/core (DB-Agnostic)"
        subgraph "Domain Layer"
            ModelIR["model-ir.ts<br/>Schema IR (460 LOC)"]
            IntentAST["intent-ast.ts<br/>Query AST (re-exports)"]
            Planner["planner.ts<br/>Semantic Planner (1,544 LOC)"]
        end

        subgraph "DX Layer (dx/)"
            ORM["orm.ts<br/>Public API (1,774 LOC)"]
            Filters["filters.ts<br/>57 filter helpers (1,180 LOC)"]
            QueryExec["query-executor.ts<br/>Execution (623 LOC)"]
            IntentBuilder["intent-builder.ts<br/>AST Builder (643 LOC)"]
            SchemaDSL["schema.ts<br/>Schema DSL (1,084 LOC)"]
        end

        AdapterIF["adapter.ts<br/>Port Interface (535 LOC)"]
    end

    subgraph "packages/adapter-pgsql (PostgreSQL)"
        PgsqlAdapter["pgsql-adapter.ts<br/>Adapter Impl (1,930 LOC)"]
        Compiler["compiler.ts<br/>SQL Compiler (1,250 LOC)"]
        Handlers["handlers/<br/>Decision Handlers (2,263 LOC)"]
        ASTHelpers["ast-helpers.ts<br/>PG AST Factory (893 LOC)"]
        Validate["validate.ts<br/>Identifier Validation"]
    end

    ORM --> Planner
    ORM --> AdapterIF
    Planner --> ModelIR
    Planner --> IntentAST
    PgsqlAdapter -.->|implements| AdapterIF
    PgsqlAdapter --> Compiler
    Compiler --> Handlers
    Compiler --> ASTHelpers
    PgsqlAdapter --> Validate
```

## Package Structure

| Package | Purpose | LOC | Dependencies |
|---------|---------|-----|--------------|
| `@dbsp/types` | Shared TypeScript types (IntentAST, utils) | 1,851 | none |
| `@dbsp/nql` | NQL parser (Chevrotain-based) | 4,990 | `@dbsp/types`, `chevrotain` |
| `@dbsp/core` | Schema, Planner, DX layer, Adapter interface | 19,865 | `@dbsp/nql`, `@dbsp/types`, `valibot` |
| `@dbsp/adapter-pgsql` | PostgreSQL-native SQL compiler + executor | 13,757 | `@dbsp/core`, `@dbsp/types`, `pg`, `pgsql-deparser` |
| `@dbsp/cli` | Interactive REPL + batch execution | 6,194 | `@dbsp/core`, `@dbsp/nql`, `@dbsp/adapter-pgsql`, `ink`, `commander` |
| `@dbsp/mcp-server` | Model Context Protocol server | 511 | `@dbsp/core`, `@modelcontextprotocol/sdk` |

## Dependency Graph

```mermaid
graph LR
    Types["@dbsp/types"]
    NQL["@dbsp/nql"]
    Core["@dbsp/core"]
    Adapter["@dbsp/adapter-pgsql"]
    CLI["@dbsp/cli"]
    MCP["@dbsp/mcp-server"]

    NQL --> Types
    Core --> Types
    Core --> NQL
    Adapter --> Core
    Adapter --> Types
    CLI --> Core
    CLI --> NQL
    CLI --> Adapter
    MCP --> Core
```

**Architecture Compliance:** :green_circle: No violations detected. Core does not import adapter code.

## Architecture Patterns Used

| Pattern | Where | Evaluation |
|---------|-------|------------|
| Ports & Adapters | core ↔ adapter-pgsql | :green_circle: Excellent |
| Intent-first (Declarative) | QueryIntent → PlanReport → SQL | :green_circle: Excellent |
| Discriminated Unions | IntentAST, WhereIntent, Decision | :green_circle: Proper |
| Handler Registry | adapter-pgsql/handlers/ | :green_circle: Extensible |
| Immutable Builders | QueryBuilder clone pattern | :yellow_circle: Verbose (20+ clones) |
| AST-based SQL Generation | compiler → ast-helpers → deparser | :green_circle: Secure |

## Compilation Pipeline

```mermaid
sequenceDiagram
    participant U as User Code
    participant ORM as ORM (core/dx)
    participant NQL as NQL Parser
    participant P as Planner
    participant A as Adapter
    participant C as Compiler
    participant PG as PostgreSQL

    U->>ORM: orm.select('users').where(eq('active', true)).all()
    ORM->>ORM: Build QueryIntent via IntentBuilder
    ORM->>P: plan(intent, model)
    P-->>ORM: PlanReport (decisions + warnings)
    ORM->>A: compile(planReport, options)
    A->>C: PlanCompiler.compile(decisions)
    C->>C: Decision dispatch → Handler registry
    C->>C: Build PostgreSQL AST nodes
    C-->>A: deparseQuoted(ast) → SQL + params
    A->>PG: pool.query(sql, params)
    PG-->>A: ResultSet
    A->>A: transformResultRows (naming)
    A-->>ORM: T[] results
    ORM-->>U: typed results
```
