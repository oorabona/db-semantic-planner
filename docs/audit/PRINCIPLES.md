# Engineering Principles Compliance

## SOLID Principles

### Single Responsibility (SRP)

| Status | Count | Details |
|--------|-------|---------|
| ✅ Compliant | 95% | Most modules have focused responsibilities |
| ✅ Resolved | 0 | Large files split (2026-01-20) |

**Previously Identified (Now Resolved):**

| File:Line | Class/Function | Issue | Resolution |
|-----------|----------------|-------|------------|
| ~~`adapter-kysely/src/compiler.ts:1-4735`~~ | Module | 21 compile* functions | ✅ Split into compiler/ module (now 2633 lines, -44%) |
| ~~`core/src/dx/orm.ts:1-2351`~~ | QueryBuilderImpl | Multiple concerns | ✅ ResultHydrator extracted (now 1776 lines, -23%) |

**Compliance Score:** 9/10

---

### Open/Closed (OCP)

| Status | Observation |
|--------|-------------|
| ✅ Good | Extension via adapter interface pattern |

**Analysis:**
- Adapter interface allows new database adapters without modifying core
- Strategy pattern for filter/include decisions is extensible
- Intent types can be extended for new query patterns

**Examples of good OCP:**
- `Adapter` interface: `adapter-kysely/src/kysely-adapter.ts:1-529`
- Strategy selection: `core/src/planner.ts:200-300`
- Filter type extensibility: `core/src/dx/filters.ts`

**Compliance Score:** 9/10

---

### Liskov Substitution (LSP)

| Status | Observation |
|--------|-------------|
| ✅ Good | Interface contracts maintained |

**Analysis:**
- `KyselyAdapter` correctly implements all `Adapter` interface methods
- Mock adapter in tests properly substitutes for real adapter
- No behavioral surprises in subtype implementations

**Evidence:**
- All adapter methods have consistent signatures
- Error handling follows consistent patterns
- Tests use both real and mock adapters interchangeably

**Compliance Score:** 9/10

---

### Interface Segregation (ISP)

| Status | Observation |
|--------|-------------|
| ✅ Excellent | Well-segregated adapter interfaces |

**Analysis:**
The adapter interfaces are excellently segregated:

```typescript
// From core/src/adapter.ts
interface BaseAdapter { capabilities; validateIdentifier }
interface CompilingAdapter extends BaseAdapter { compile, compileInsert, ... }
interface ExecutingAdapter extends CompilingAdapter { execute, executeOne }
interface StreamingAdapter extends ExecutingAdapter { stream }
interface TransactionalAdapter extends ExecutingAdapter { transaction, withSchema }
interface IntrospectingAdapter { introspect }
interface DDLGeneratingAdapter { generateDDL }
interface RawSqlAdapter { executeRaw }
```

- Clients only depend on interfaces they use
- Capability detection allows graceful degradation
- No forced implementation of unused methods

**Compliance Score:** 10/10

---

### Dependency Inversion (DIP)

| Status | Observation |
|--------|-------------|
| ✅ Good | Core depends on abstractions |

**Analysis:**
- Core package defines `Adapter` interface (abstraction)
- Adapter-kysely implements that interface (concrete)
- DX layer uses adapter through interface, not concrete type
- Kysely is a peer dependency, not hard-coded

**Dependency flow:**
```
core (defines Adapter interface)
    ↓ depends on abstraction
adapter-kysely (implements Adapter)
    ↓ uses
Kysely (peer dependency)
```

**Compliance Score:** 9/10

---

## DRY (Don't Repeat Yourself)

### Duplicated Function Detection

```bash
# Command to find duplicate function names
grep -rn "^export function\|^function" --include="*.ts" packages/*/src/**/*.ts \
  | grep -v test.ts \
  | awk -F: '{print $3}' | sed 's/function //' | sed 's/(.*/:/' \
  | sort | uniq -c | sort -rn | head -10
```

### ⚠️ Duplicated Functions Found

| Function | File 1 | File 2 | Severity |
|----------|--------|--------|----------|
| `singularize` | `core/src/conventions.ts:43` | `core/src/dx/lightweight-model.ts:353` | **High** |
| `parseDotNotationInclude` | `core/src/dx/intent-builder.ts:138` | `core/src/dx/orm.ts:745` | **High** |
| `getNodeIdAlias` | `core/src/planner.ts:289` | `adapter-kysely/src/compiler.ts:1581` | Medium |

#### DUP-001: `singularize` — Two different implementations

```typescript
// conventions.ts - version simple (12 lignes)
export function singularize(name: string): string {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  // ...
}

// lightweight-model.ts - version avancée (30 lignes)
export function singularize(tableName: string): string {
  const irregular = IRREGULAR_PLURALS[lower]; // Gère "people" → "person"
  // ... plus de logique, gestion de la casse
}
```

**Recommendation:** Garder la version avancée dans `conventions.ts`, supprimer de `lightweight-model.ts`.

#### DUP-002: `parseDotNotationInclude` — Code quasi-identique

Les deux implémentations sont **copier-collées** avec seulement le type d'options qui diffère.

**Recommendation:** Extraire dans un module partagé avec type générique.

#### DUP-003: `getNodeIdAlias` — Logique similaire

- `planner.ts` gère le cas `'literal'` explicitement
- `compiler.ts` utilise un fallback direct

**Recommendation:** Déplacer vers `intent-ast.ts` (proche du type `RecursiveNodeIdExpr`).

### Same Name, Different Purpose (NOT duplications)

| Function | Context 1 | Context 2 | Why different |
|----------|-----------|-----------|---------------|
| `resolveRelation` | planner.ts | compiler.ts | Planner: warnings + disambiguation / Compiler: uses plan decisions |
| `mapColumnType` | ddl.ts | schema-bridge.ts | DDL: ColumnType→SQL / Bridge: GeneratedType→ColumnType |
| `inferRelations` | conventions.ts | introspection.ts | Schema definition vs DB introspection |
| `buildTableIR` | schema-bridge.ts | introspection.ts | From definition vs from introspection |

### Pattern Usage (Not Duplication)

| Pattern | Occurrences | Assessment |
|---------|-------------|------------|
| `eb.fn()` usage | ~50 | ✅ Consistent Kysely API usage |
| `eb.ref()` usage | ~40 | ✅ Necessary for column refs |

**Compliance Score:** 6/10 ⚠️ (3 duplications à corriger)

---

## KISS (Keep It Simple)

### Over-Engineering Detected

| Location | Issue | Simplification |
|----------|-------|----------------|
| None critical | - | - |

**Analysis:**
The codebase avoids over-engineering:
- No unnecessary abstractions
- No premature optimization
- Clear, direct code paths
- Configuration has sensible defaults

### Complexity Concerns

| File | Concern | Assessment |
|------|---------|------------|
| compiler.ts | 2633 lines | ✅ Split into modules (-44%), handlers extracted |
| planner.ts | Multiple strategy branches | ✅ Appropriate for decision complexity |
| intent-ast.ts | Many intent types | ✅ Necessary for type safety |

**Compliance Score:** 8/10

---

## YAGNI (You Ain't Gonna Need It)

### Unused Code

```bash
# Dead code scan - no unused exports found
# All public APIs have tests or documentation
```

| Item | Type | Last Used | Action |
|------|------|-----------|--------|
| None found | - | - | - |

### Premature Abstractions

| Abstraction | Actual Uses | Issue |
|-------------|-------------|-------|
| None found | - | - |

**Analysis:**
The codebase follows YAGNI well:
- Features are implemented when needed (backlog items documented)
- No speculative code
- Out-of-scope features clearly documented as deferred

**Compliance Score:** 9/10

---

## Compliance Summary

| Principle | Score | Status |
|-----------|-------|--------|
| SRP | 8/10 | 🟢 |
| OCP | 9/10 | 🟢 |
| LSP | 9/10 | 🟢 |
| ISP | 10/10 | 🟢 |
| DIP | 9/10 | 🟢 |
| DRY | 6/10 | 🟡 |
| KISS | 8/10 | 🟢 |
| YAGNI | 9/10 | 🟢 |

**Overall Principle Compliance:** 8.5/10 🟢

---

## Recommendations

### High Priority (P1)

1. **Split compiler.ts** into focused modules
   - `select-compiler.ts` — SELECT query compilation
   - `mutation-compiler.ts` — INSERT/UPDATE/DELETE
   - `recursive-compiler.ts` — CTE and recursive queries
   - `expression-compiler.ts` — WHERE, HAVING expressions

### Medium Priority (P2)

2. **Extract concerns from QueryBuilderImpl**
   - `QueryExecutor` — execution logic
   - `ResultHydrator` — include hydration
   - Keep QueryBuilder focused on intent building

### Low Priority (P3)

3. **Create error message factory**
   - Centralize error message construction
   - Improve consistency across packages

---

## Intentional Tradeoffs

The following patterns appear to violate principles but are documented as intentional:

| Pattern | Reason | Documentation |
|---------|--------|---------------|
| Large compiler.ts | All SQL generation in one file for locality | To be addressed |
| WeakMap for plugin state | Memory safety tradeoff | GOTCHAS.md #4 |
| Dual schema paths | Different use cases | SKILL.md Architecture |
| PostgreSQL-first | Focus over breadth | CLAUDE.md |

These are not violations — they are conscious decisions with documented rationale.
