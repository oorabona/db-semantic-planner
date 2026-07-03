# FIX-155 — fail-safe, metadata-driven destructive-rollback guard

```yaml
doc-meta:
  issue: 155
  status: canonical
  created: 2026-06-20
```

## §1 Problem
`migrate rollback` requires `--force` only when a regex scan (`isDestructiveDown`, 3 patterns) finds destructive DOWN SQL. Static SQL scanning is fundamentally incomplete (comment-split keywords, string-literal comment markers, nested comments, E-strings, and the hard wall: dynamic SQL `DO $$ EXECUTE '...' $$` / `format(...)`). A miss = **silent destructive rollback without `--force`** = data loss. The fix is a design change: **stop proving destructiveness from SQL text; require `--force` unless provably safe.**

## §2 Design — metadata + fail-safe (NOT a better regex)
1. **Authoritative metadata at generation.** Generation already KNOWS destructiveness: `SchemaDiff.hasDestructive` / `SchemaChange.destructive` (schema-diff.ts) drive `changeToDownSQL` (it emits the DROP / the "cannot reverse" warning). `generateMigrationFile` (adapter `ddl/migration-file.ts`) stamps a parsed header line `-- dbsp:destructive: true|false` from that authoritative flag — per migration. NOT from the regex.
2. **`parseMigrationFile` reads the header** → `ParsedMigrationFile.destructive?: boolean | undefined` (`undefined` = un-marked / legacy / external).
3. **Fail-safe rollback gate** (`packages/cli/src/commands/migrate.ts` rollback, replacing the `isDestructiveDown(...) && !force` gate): **require `--force` UNLESS `parsed.destructive === false`.** That is: `true` → force; `undefined` (un-marked / legacy / external) → force (the core inversion: absence ≠ safe); `false` → no force (trust the authoritative generation stamp). **No SQL scanning in the gate** — purely metadata-driven, the cleanest realization of "stop proving destructiveness from SQL text".
4. **Header precedence over dynamic SQL (operator decision).** A stamped `destructive: false` is trusted even when the DOWN contains `DO $$ ... $$` / `EXECUTE` / `format(` — because generation KNOWS such a block is a non-destructive constraint re-add, not a drop. A separate dynamic-SQL escalation check is therefore NOT added: an un-marked DOWN with dynamic SQL already requires `--force` (via the un-marked → force rule), and a marked-`false` DOWN is trusted by precedence. (Threat model: the fail-safe protects against the regex ACCIDENTALLY missing a real destructive statement, not against a user deliberately mis-stamping their own migration file.)
5. **DB `_dbsp_migrations.destructive`** (already exists, written by `recordMigration` at apply): write it from the authoritative header/diff flag, not the regex. The rollback gate keys on the FILE header (portable, travels with the migration, user-visible); the DB column is corroboration.

## §3 Back-compat
Legacy migrations have no `-- dbsp:destructive` header (and DB `destructive` may be NULL/backfilled-false). They MUST read as **unknown → require `--force`** (not "safe"). This is the intended behavior inversion. Document in the rollback error: "migration is unmarked/legacy; re-generate or pass --force".

## §4 Out of scope (defer)
- Replacing the regex classifier with a full SQL lexer (issue item 3, the lexer-downgrade) — the regex leaves the rollback hot path entirely; the only residual classification is the escalate-only dynamic-SQL check. Defer to a follow-on. Note the existing `DO $$` generator emission as motivation.
- Per-statement granularity — per-migration `destructive` is sufficient (rollback is per-migration).

## §5 Tests (the issue's acceptance)
- Generation: a destructive DOWN (drop_table/drop_column/lossy type) → file stamped `-- dbsp:destructive: true`; a safe DOWN → `false`.
- `parseMigrationFile`: reads the header → `destructive` true/false/undefined.
- Rollback (metadata-driven, NO SQL scan): stamped `destructive: true` → `--force` required; stamped `false` → no `--force` (even with a `DO $$` block — header precedence); un-marked/legacy → `--force` required (fail-safe); un-marked with `DO $$` → `--force` (same un-marked rule).
- Invert the current SC-19 regex tests to the metadata gate. Keep SC-10/SC-11 (no-DOWN / empty-DOWN) gates unchanged.
- `isDestructiveDown` regex is retired from the rollback gate; if still used to populate the DB `destructive` column at apply time, it is now superseded by the authoritative header/diff flag (write the header value).

## §6 Verify
`pnpm clean:artifacts`; rebuild; `tsc --noEmit` + vitest green (cli + adapter). e2e if a migrate e2e exists (else unit-covered, the migrate path is CLI). The cross-family review pass + opus senior (this is a SAFETY guard — review the fail-safe default + the dynamic-SQL escalation + back-compat). Closes #155.
```
