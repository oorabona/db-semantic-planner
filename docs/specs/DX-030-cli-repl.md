# DX-030: CLI REPL Interactive Playground

## Overview

Interactive REPL for testing db-semantic-planner queries without full database setup.

**Status:** In Progress
**Priority:** HIGH
**Effort:** M (~17h)
**Dependencies:** DX-030-SPIKE ✅, DX-031 (MockAdapter) ✅

## User Story

> As a developer using db-semantic-planner, I want an interactive REPL to test my queries without full setup, so I can see generated SQL and execution plan in real-time.

## Acceptance Criteria

### AC-1: CLI Command
- `dbsp repl --schema ./dbsp.schema.ts` starts the REPL
- Schema is loaded and validated on startup
- Error message if schema file not found or invalid

### AC-2: Query Evaluation
- Natural syntax (default): `users where active = true`
- SQL mode (`.sql`): `SELECT * FROM users WHERE active = $1`
- Display: Generated SQL + Query Plan + Mock results

### AC-3: Dot Commands
- `.help` - Show available commands
- `.tables` - List all tables in schema
- `.schema [table]` - Show table schema (columns, types)
- `.relations [table]` - Show table relations
- `.sql` - Toggle SQL mode on/off
- `.clear` - Clear screen
- `.exit` or Ctrl+C - Exit REPL

### AC-4: UI Features
- Pretty table output with borders
- Syntax highlighting (SQL keywords, strings, numbers)
- Command history (up/down arrows)
- History persistence across sessions (~/.dbsp_history)

### AC-5: Autocompletion
- Tab completes table names
- Tab completes relation names after `.`
- Tab completes dot commands

### AC-6: Split View
- Default: single view (query + result)
- `.split` - Toggle split view
- Split layout: [Schema Panel | Query + Result Panel]

## BDD Scenarios

### Scenario 1: Start REPL with schema
```gherkin
Given a valid schema file at "./dbsp.schema.ts"
When I run "dbsp repl --schema ./dbsp.schema.ts"
Then the REPL should start
And display "db-semantic-planner REPL"
And show the loaded tables count
```

### Scenario 2: Natural query execution
```gherkin
Given the REPL is running with a schema containing "users" table
When I type "users where active = true"
And press Enter
Then I should see the generated SQL
And I should see the query plan
And I should see mock result rows
```

### Scenario 3: SQL mode toggle
```gherkin
Given the REPL is running in natural mode
When I type ".sql"
Then the prompt should change to indicate SQL mode
When I type "SELECT * FROM users"
Then it should parse as SQL and generate the query
```

### Scenario 4: Dot commands
```gherkin
Given the REPL is running
When I type ".tables"
Then I should see a list of all tables in the schema
When I type ".schema users"
Then I should see columns and types for "users" table
```

### Scenario 5: Autocompletion
```gherkin
Given the REPL is running with tables "users", "posts", "comments"
When I type "us" and press Tab
Then it should complete to "users"
When I type "users.p" and press Tab  
Then it should show relation options starting with "p"
```

### Scenario 6: Command history
```gherkin
Given I have executed queries in a previous session
When I start a new REPL session
And press Up arrow
Then I should see the last command from history
```

### Scenario 7: Split view
```gherkin
Given the REPL is running in single view
When I type ".split"
Then the layout should change to split view
And the left panel should show schema info
And the right panel should show query input and results
```

## Technical Design

### Architecture

```
packages/cli/src/
├── commands/
│   └── repl.ts              # CLI command entry point
├── repl/
│   ├── index.tsx            # Main REPL app (Ink)
│   ├── components/
│   │   ├── Header.tsx       # Title bar
│   │   ├── QueryInput.tsx   # Input with history
│   │   ├── SqlOutput.tsx    # SQL display
│   │   ├── PlanOutput.tsx   # Plan display
│   │   ├── ResultTable.tsx  # Results table
│   │   ├── SchemaPanel.tsx  # Schema sidebar
│   │   └── HelpDisplay.tsx  # Help overlay
│   ├── hooks/
│   │   ├── useHistory.ts    # Command history
│   │   ├── useCompletion.ts # Autocompletion
│   │   └── useQueryEval.ts  # Query evaluation
│   ├── parsers/
│   │   ├── natural.ts       # Natural syntax parser
│   │   └── sql.ts           # SQL mode parser
│   └── utils/
│       └── highlight.ts     # Syntax highlighting
```

### Dependencies

```json
{
  "dependencies": {
    "ink": "^5.0.1",
    "@inkjs/ui": "^2.0.0",
    "ink-table": "^3.1.0",
    "react": "^18.3.1"
  }
}
```

### Key Interfaces

```typescript
interface ReplState {
  mode: 'natural' | 'sql';
  splitView: boolean;
  history: string[];
  schema: GeneratedSchema | null;
  lastResult: QueryResult | null;
}

interface QueryResult {
  sql: string;
  params: unknown[];
  plan: PlanReport;
  mockData: Record<string, unknown>[];
}
```

## Implementation Blocks

| # | Block | Description | Files | Tests |
|---|-------|-------------|-------|-------|
| 1 | CLI + Schema Loading | `dbsp repl` command, schema loader | repl.ts, index.tsx | 5 |
| 2 | Natural Query Parser | Parse "users where x = y" syntax | natural.ts | 10 |
| 3 | Dot Commands | .help, .tables, .schema, .relations, .sql, .clear | components/*.tsx | 8 |
| 4 | Plan + Table Display | Pretty output with Ink | SqlOutput, PlanOutput, ResultTable | 5 |
| 5 | Command History | Up/down, persistence | useHistory.ts | 5 |
| 6 | Autocompletion | Tab completion | useCompletion.ts | 8 |
| 7 | Split View | Dual panel layout | SchemaPanel.tsx | 4 |

**Total estimated tests:** ~45

## Test Strategy

### Unit Tests
- Natural query parser (various syntaxes)
- Dot command parsing
- History management
- Completion logic

### Integration Tests
- Full REPL flow with mock schema
- Command execution sequences

### Manual Testing
- Visual verification of UI
- Keyboard interaction (arrows, tab, ctrl+c)

## Out of Scope

- Real database execution (compile-only)
- Multi-file schema support
- Remote schema loading
- Query result caching
- Export to file

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Natural parser complexity | Start simple, iterate |
| Ink rendering issues | Fallback to simpler layout |
| History file permissions | Graceful degradation |

## References

- ADR-003: CLI REPL Framework (Ink selected)
- DX-031: MockAdapter (compile-only)
- Ink POC: packages/cli/spike/ink-poc/
