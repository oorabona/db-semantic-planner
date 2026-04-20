# CLI Package — Documentation Coherence Audit
> Generated: 2026-04-20 | Coherence score: **3/10 (significant drift)**

## Files Audited

| File | Lines | Role |
|------|-------|------|
| `docs/CLI_USAGE.md` | ~370 | Primary end-user reference |
| `packages/cli/README.md` | ~50 | Package quick-start |

---

## Drift Table

| # | Source | Location | Claim | Reality | Severity |
|---|--------|----------|-------|---------|---------|
| 1 | DOC-1 | `CLI_USAGE.md:29` | Commands table omits `push` and `migrate` | Both fully implemented in `index.ts` | S |
| 2 | DOC-2 / DOC-3 | `CLI_USAGE.md:46 + :360` | `manifest` is a valid `generate` target; CI example uses it | Removed in ARCH-005; code calls `process.exit(1)` | S |
| 3 | DOC-7 | `CLI_USAGE.md:1` | `push` command undocumented | Has 5 flags: `--schema`, `--db`, `--schema-name`, `--drop`, `--dry-run`, `--json` | M |
| 4 | DOC-8 | `CLI_USAGE.md:1` | `migrate` command undocumented | Has 4 subcommands: `dev`, `apply`, `rollback`, `status` | M |
| 5 | DOC-4 | `CLI_USAGE.md:57` | `--dialect` accepts `mysql, sqlite, mssql` | Code warns "only postgresql supported" and coerces | M |
| 6 | DOC-5 | `CLI_USAGE.md:295` | `verify` Options omits `--json` | `--json` implemented in `verifyCommand` | M |
| 7 | DOC-6 | `CLI_USAGE.md:263` | `introspect` Options omits `--db-casing` | `--db-casing <casing>` implemented (default: `snake_case`) | M |
| 8 | DOC-10 | `cli/README.md:42` | `dbsp batch` listed as top-level command | No `batchCommand` in `index.ts`; batch is `repl --eval/--input` | M |
| 9 | DOC-9 | `cli/README.md:30` | Quick-start uses `generate manifest` | Removed; errors at runtime | M |
| 10 | DOC-11 | `CLI_USAGE.md:135` | `.sql` described as "Toggle SQL output" | `.sql` switches input language mode (NQL ↔ SQL); exec-toggle is `.exec` | M |

---

## Missing Documentation

| Feature | Status | Fix |
|---------|--------|-----|
| `repl --parse` flag | Undocumented | Add to REPL Options table |
| `repl --exec` flag | Undocumented | Add to REPL Options table |
| `repl -c/--config <path>` flag | Undocumented | Add to REPL Options table |
| `verify --json` flag | Undocumented | Add to verify Options table |
| `introspect --db-casing` flag | Undocumented | Add to introspect Options table |
| `.parse [on|off]` dot-command | Absent from REPL Commands section | Add row: "Toggle parse tree (AST) output" |
| `.natural` dot-command | Absent from .help output AND docs | Add to .help + docs |
| `.sql` dot-command | Described incorrectly | Fix description |
| `--output` alias for `--out` in generate | Omitted | Update flag row |
| `push` entire section | Missing | Add full section with flags + examples |
| `migrate` entire section | Missing | Add section for dev/apply/rollback/status |

---

## Coherence Score Rationale

**3/10** — Two entire commands (push, migrate) are absent. The primary CI example in the docs (`generate manifest`) fails with exit(1). The dialect support claim is actively misleading. Of 11 REPL flags/commands audited, 5 are either undocumented or incorrectly described. The README quick-start example also fails. This is the lowest-coherence documentation section in the project.
