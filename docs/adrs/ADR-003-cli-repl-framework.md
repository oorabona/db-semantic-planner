# ADR-003: CLI REPL Framework Selection

## Status

**ACCEPTED** - 2025-01-11

## Context

DX-030-SPIKE required evaluating terminal UI frameworks for the db-semantic-planner interactive REPL. The REPL needs:

- Rich input handling with history
- Box layouts with borders and styling
- Table rendering for SQL results
- Color and formatting support
- Cross-platform terminal compatibility

Two main candidates were identified:
1. **Ink** - React-based terminal UI library
2. **vue-termui** - Vue.js-based terminal UI library

## Decision

**We will use Ink (React for CLI)** for the REPL implementation.

## Evaluation

### Methodology

Built minimal POCs in `packages/cli/spike/` demonstrating:
- Input handling with command history
- Box layouts with borders and padding
- Table rendering for query results
- Styling (colors, bold, dimmed)

### Criteria Scoring (from TODO.md)

| Criterion | Weight | Ink | vue-termui | Notes |
|-----------|--------|-----|------------|-------|
| Ease of Implementation | 30% | 9/10 | 6/10 | Ink has more docs, examples |
| Component Quality | 25% | 9/10 | 7/10 | @inkjs/ui + ink-table mature |
| Stability | 25% | 9/10 | 5/10 | Ink v5.0+ stable; vue-termui v0.0.19 |
| Bundle Size | 10% | 7/10 | 8/10 | Both similar, Vue slightly lighter |
| Team Familiarity | 10% | 8/10 | 6/10 | React patterns well-known |

### Weighted Scores

- **Ink**: (9×0.30) + (9×0.25) + (9×0.25) + (7×0.10) + (8×0.10) = **8.7**
- **vue-termui**: (6×0.30) + (7×0.25) + (5×0.25) + (8×0.10) + (6×0.10) = **6.2**

### Detailed Analysis

#### Ink Advantages

1. **Mature Ecosystem**
   - v5.0.1 stable (major version)
   - @inkjs/ui provides TextInput, PasswordInput, Spinner, etc.
   - ink-table for formatted table output
   - Active maintenance by Sindre Sorhus

2. **Familiar React Patterns**
   - useState, useCallback, useEffect work as expected
   - Component composition is natural
   - useApp() and useInput() hooks are intuitive

3. **Excellent Documentation**
   - Comprehensive README with examples
   - Many community tutorials
   - Clear migration guides between versions

4. **Production Proven**
   - Used by Gatsby, Parcel, Yarn, etc.
   - Large user base for bug reports

#### vue-termui Disadvantages

1. **Pre-v1.0 Status**
   - v0.0.19 indicates early development
   - API may change significantly
   - Limited bug reports and fixes

2. **Smaller Ecosystem**
   - No equivalent to ink-table (manual table implementation required)
   - Fewer ready-made components
   - Less community support

3. **Documentation Gaps**
   - Fewer examples
   - Some features poorly documented
   - useStdin API less intuitive

4. **Vite HMR Advantage Irrelevant**
   - Hot reload useful for development
   - But CLI apps don't need constant UI iteration
   - Build-and-test cycle is fast enough

### POC Implementation Notes

**Ink POC** (`packages/cli/spike/ink-poc/`):
- Clean, readable component structure
- TextInput from @inkjs/ui works immediately
- Table rendering via ink-table is trivial
- 156 lines of code

**vue-termui POC** (`packages/cli/spike/vue-termui-poc/`):
- Required manual keyboard handling (useStdin)
- No built-in table component
- More verbose setup (vite.config.ts, shims)
- 185 lines of code for equivalent features

## Consequences

### Positive

- Familiar React patterns reduce learning curve
- Rich ecosystem of components available
- Stable API reduces maintenance burden
- Production-proven reliability

### Negative

- React as dependency (already in devDependencies)
- Need to learn Ink-specific hooks (useApp, useInput)

### Neutral

- Build tooling (tsup) supports React JSX natively

## Implementation Notes

### Dependencies to Add

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

### Entry Point Pattern

```typescript
import { render } from 'ink';
import { ReplApp } from './components/ReplApp.js';

render(<ReplApp />);
```

### Component Structure

```
packages/cli/src/
├── index.tsx          # Entry point
├── components/
│   ├── ReplApp.tsx    # Main REPL container
│   ├── Header.tsx     # Title bar
│   ├── Input.tsx      # Query input
│   ├── Output.tsx     # SQL/Plan/Results display
│   └── Table.tsx      # Results table wrapper
└── hooks/
    ├── useHistory.ts  # Command history
    └── useQuery.ts    # Query execution
```

## References

- [Ink Documentation](https://github.com/vadimdemedes/ink)
- [@inkjs/ui Components](https://github.com/vadimdemedes/ink-ui)
- [ink-table](https://github.com/maticzav/ink-table)
- [vue-termui](https://github.com/vue-terminal/vue-termui)
- POCs: `packages/cli/spike/ink-poc/`, `packages/cli/spike/vue-termui-poc/`
