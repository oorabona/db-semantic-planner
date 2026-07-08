<!--
doc-meta:
  status: draft
  story: fix-265-ddl-migration-gaps
  issue: 265
  adversarial_applied: true
  llm_spec_reviewed: true
  production_audit_applied: true
  created: 2026-07-08
-->

# fix-265 — Four DDL migration correctness gaps

## §1 Scope

Four independent correctness gaps in the DDL migration subsystem
(`packages/adapter-pgsql/src/ddl/`), reported by a downstream migration planner
composing `compareSchemata` / `generateMigrationSQL` / `generateDownSQL` over
bridge-built `ModelIR`s. All four are **CONFIRMED** against current `main`
(forensic investigation 2026-07-08).

| # | Gap | Packages touched | Nature | Bump |
|---|-----|------------------|--------|------|
| 1 | External FK targets over-qualified with the migration schema | types + core + adapter-pgsql | new capability: cross-schema FK end-to-end | `feat` |
| 2 | `compareSchemata` never diffs `ColumnIR.unique` | adapter-pgsql | correctness | `fix` |
| 3 | PK-change down-migration leaves the table with NO primary key | adapter-pgsql | correctness / data-integrity | `fix` |
| 4 | Enum/CHECK label validation rejects safe *escaped* literals | adapter-pgsql | correctness (false-positive) + security-adjacent | `fix` |

**In scope:** the four fixes + full test coverage (unit + real-DB e2e where a
gap only manifests against Postgres) + docs sync (`schema-versioning.md`,
CLAUDE.md Query/DDL tables where relevant).

**Out of scope:** any FK feature beyond a *declared referenced schema*
(no cross-database refs, no dynamic schema resolution); reworking the
`validateSqlExpression` contract at its non-CHECK call sites (index WHERE
predicates, RLS `USING`/`WITH CHECK`) — Gap 4 is scoped to CHECK-constraint
contexts ONLY.

---

## §2 Reality constraints & design decisions

These are load-bearing; the whole review loop should anchor on them rather than
re-litigate.

### D1 — Gap 1 scope = FULL (operator decision 2026-07-08)

The user chose **declared referenced schema** over the minimal
"emit-unqualified" fix. This makes it a **public type-contract change**
(`ForeignKeyIR.references` gains an optional `schema`), so Hyrum's-law applies:
the field is optional and backward-compatible (absent ⇒ current behavior).

### D2 — the IR carries NO schema for FK targets today (the gap's real root)

`ModelIR.externalTables: ReadonlySet<string>` is bare names (used only to
suppress `drop_table` — `schema-diff.ts:277`); `ForeignKeyIR.references` is
`{ table, columns }` — no schema; the DSL authoring type
`SchemaForeignKeyReference` likewise has no schema. So the reporter's mental
model ("`externalTables` is the cross-schema mechanism") never matched reality.
The fix threads a NEW `schema?` datum end-to-end: DSL → `ModelIR` →
introspection → diff → emit.

### D3 — introspection today actively HIDES cross-schema FKs

The FK catalog query (`introspection.ts:254-279`) joins
`constraint_column_usage ccu ON ... AND ccu.table_schema = tc.table_schema`
(L272). For a genuine cross-schema FK the referenced table lives in another
schema ⇒ the join yields no row ⇒ the FK vanishes from introspection entirely.
It also never projects the referenced namespace. **Decision:** rewrite this
query against `pg_constraint` (`contype='f'`, `conrelid`/`confrelid`,
`conkey`/`confkey`) joined to `pg_class`/`pg_namespace` for BOTH the source and
the referenced relation — the catalog idiom the codebase already uses for CHECK
constraints (`introspection.ts:382-386`). Preserve composite-key column pairing
via `unnest(conkey/confkey) WITH ORDINALITY` (do NOT rely on array position
implicitly).

### D4 — introspection normalizes schema to avoid phantom diffs

Introspection populates `references.schema` **only when the referenced schema
differs from the source table's schema**; same-schema FKs keep it `undefined`,
exactly as a DSL author writing a same-schema FK does. Both sides therefore read
`undefined` for the common case ⇒ no spurious `drop+add`. This localizes the
"baseline schema" decision to introspection (where the source schema `$1` is
known) and avoids threading a migration/default schema into the diff layer
(`compareForeignKeys` has neither the `ModelIR` nor a schema name in scope, and
`CompareSchemataOptions` carries none — confirmed).

**Schema comparison is BYTE-EXACT** (finding — S): normalization compares
`references.schema` strings verbatim — NO lowercasing (unlike `dbCasing` for
columns). PG stores `nspname` case-exact; a quoted/case-sensitive schema must
match byte-for-byte. `validateIdentifier`'s ASCII-only pattern means char==byte,
so `.length`-based 63 checks are safe.

*Accepted minor limitation (adversarial-confirmed as a no-op, not a bug):* an
author who explicitly sets `references.schema` to the very schema they later
migrate INTO will diff against an introspected `undefined`, producing a `drop+add`
churn — idempotent net effect, identical resulting schema. The adversarial pass
verified `compareForeignKeys` has no schema in scope and blessed D4 without
threading `defaultSchema`; kept simple (YAGNI). Documented, not fixed here. The
churn's only cost is a redundant drop+re-add at apply (avoid by leaving
same-schema targets' `schema` undefined — the documented DSL convention).

### D5 — `fkKey` MUST fold the normalized schema

FKs are matched by structural key `fkKey(fk) = localCols→table(targetCols)`
(`schema-diff.ts:698`), NOT by constraint name. A schema-only retarget (same
table name, different schema) must be caught as `drop+add` (Postgres cannot
re-point a constraint in place). ⇒ fold `references.schema` into `fkKey`.
Regression watch: `schema-diff.test.ts:1927` "ignore identical FK" must stay at
**zero** changes (two same-schema FKs, both `schema: undefined`).

### D6 — the full `fk` object already travels in `meta.fk`

Every FK `SchemaChange` carries `meta: { fk }` (add/alter/drop) and the emit
chokepoint `generateAddFKSQL` (`migration-sql.ts:1469`) reads it verbatim — the
object is never reconstructed. So once the type gains `references.schema`, the
emit fix is one line at each of TWO sites:
`generateAddFKSQL` (`migration-sql.ts:1478`) and the full-DDL sibling
`generateAlterTableAddFK` (`ddl-generator.ts:~330`):
`qualifyTable(fk.references.table, fk.references.schema ?? schemaName)`.

### D7 — Gap 2 mechanism = dedicated `alter_column_unique` change kind (recommended)

`ColumnIR.unique` is a column-property toggle exactly like `collation`/`identity`
(already modeled as `alter_column_collation`/`alter_column_identity`). Emit it as
a constraint (mirrors the inline `UNIQUE` keyword, which PG realizes as a
constraint + backing index), NOT as a synthetic `create_index` (that would
collide with `compareIndexes`' `autoUniqueIndexKeys` suppression and hit the
"`DROP INDEX` cannot drop a constraint-backed index" wrinkle). See §Gap 2 for
the open drop-name question flagged to adversarial.

### D8 — Gap 4 fix = QUOTE-AWARE forbidden-char scan, scoped to CHECK contexts ONLY

**(REVISED after adversarial — the original "AST parse via `parseRawExpression`"
premise was FALSE.)** `parseRawExpression` (`compiler-utils.ts:247`) →
`parseExpression` (`raw-expression-parser.ts:495`) is a **hand-rolled
arithmetic-only** parser (`tokenise`/`Parser`/`buildAExpr`), NOT libpg_query.
It recognizes only `+ - * / :: () , .`, numbers, single-quoted strings,
identifiers, and function calls — it has NO `=`, `<`, `>`, `[`, `IN`, `ANY`,
`ARRAY`, `AND`/`OR`/`NOT`, `IS NULL`… so it would REJECT essentially every real
CHECK boolean expression (including this spec's own examples). The real
libpg_query (`pgsql-parser`) is a **devDependency only** (`package.json:59`) —
unavailable at runtime by design (minimal-deps NFR). An AST-parse fix is off the
table.

**The fix (laziest-correct):** make the check QUOTE-AWARE. Scan the expression
character by character tracking literal context; apply the forbidden-char check
(`;`, `--`, `/*`, `*/`, `\`) ONLY to text OUTSIDE string literals. Literal rules:
- single-quoted strings `'…'` with `''` as an embedded escaped quote;
- dollar-quoted strings — **exact PG tag grammar** (re-check finding — S): a
  dollar-quote opens ONLY at `$$` or `$[A-Za-z_][A-Za-z0-9_]*$` (case-sensitive)
  AND only when the `$` is NOT immediately preceded by an identifier-continuation
  char (else it is part of an identifier, e.g. `a$tag$` — `$` is legal in idents).
  Content up to the matching close tag is literal. Getting this wrong is a
  false-NEGATIVE (`x = a$t$); DROP … -- $t$` could hide the injection).
- an UNBALANCED/unterminated quote (single OR dollar) ⇒ REJECT (fail-closed).
- **E-string / U& note:** `E'…\n…'` (backslash escapes) and `U&'…'` are NOT
  handled specially — `pg_get_constraintdef` emits standard `'…'` literals, not
  E-strings, so this is a rare-input fail-CLOSED limitation (an E-string with a
  backslash would be REJECTED, a false-positive, never a false-negative).
  Acceptable; documented. Do NOT add E-string parsing (YAGNI + it only loosens).

**BLAST-RADIUS CONSTRAINT:** `validateSqlExpression` (`validate.ts:585`) has 16
call sites (index WHERE, RLS `USING`/`WITH CHECK`, policies). The quote-aware
scan is strictly MORE permissive than the current blind regex, so applying it
broadly would change behavior at non-CHECK sites. Introduce a SEPARATE
CHECK-scoped validator (e.g. `validateCheckExpression`) applied ONLY to the 3
CHECK sites — `upAddCheckConstraint` (`migration-sql.ts:606`), the
`drop_check_constraint` down-reversal (`migration-sql.ts:1085`),
`generateConstraintsPhase` (`phases/constraints.ts:46`). The other 13 sites keep
the strict blind regex (fail-safe — stricter than needed, opens no injection
path; verified adversarial finding #1-sound).

**Security invariant:** genuine injection — `x = 1); DROP TABLE users; --` —
has `;`/`--` OUTSIDE any literal ⇒ REJECTED. `x IN ('a;b')` has them INSIDE ⇒
ACCEPTED. Every payload in the existing injection suites must stay rejected.
NOTE: CHECK expressions cannot contain volatile/side-effecting functions anyway
— PG rejects those at DDL apply, so the validator polices injection, not
semantics.

### D9 — testing conventions (project NON-NEGOTIABLE)

- SQL assertions use `sql.equals` / `sql.matches` — **never** `sql.contains`.
- Real-DB behavior (introspection round-trip, cross-schema FK apply, CHECK
  accept/reject) goes in e2e (`pnpm test:e2e`, testcontainers) — a gap that only
  manifests against Postgres is not proven by a dry-run.
- Every regression lock is RED→GREEN proven (revert fix → red).
- `pnpm clean:artifacts` before builds (stale in-place `.js` poison — memory
  `[[build_noise_inplace_js]]`).

---

## §3 Per-gap design

### Gap 3 — PK-change down restores the previous PK  *(smallest; implement FIRST)*

**Bug:** `comparePrimaryKeys` (`schema-diff.ts:562-613`) pushes `drop_primary_key`
at two sites (pure-drop L590-595; PK-change L600-605) with NO `meta`. The
down-handler `changeToDownSQL['drop_primary_key']` (`migration-sql.ts:1006-1021`)
ALREADY reverses it *iff* `change.meta.columns` is present — it's dead code
starved of input. `dbPK` (the old PK columns) is in scope at both push sites.

**Fix:** attach `meta: { columns: dbPK }` at both `drop_primary_key` push sites
(mirrors `add_primary_key`'s existing `meta: { columns: schemaPK }`). No
down-handler change.

**BDD:**
- Given a table whose PK changes `id → code`, When `generateDownMigrationSQL`,
  Then the down emits `ALTER TABLE … ADD CONSTRAINT … PRIMARY KEY ("id")`
  (destructive: false), NOT a `-- WARNING` comment.
- Given a PK dropped entirely (`schemaPK=[]`, `dbPK=[id]`), When down, Then it
  re-adds `PRIMARY KEY ("id")`.
- Regression: `migration-sql.test.ts:1520` (hand-built change with no meta →
  WARNING) stays green (fallback path untouched).

**Tests:** `schema-diff.test.ts` — assert `meta.columns` on both PK cases (new
assertions at ~L308/L330). `migration-sql.test.ts` — new end-to-end:
compareSchemata PK-change → generateDownMigrationSQL → `sql.equals` the ADD
CONSTRAINT. RED→GREEN: revert the meta attach → down goes back to WARNING.

### Gap 2 — `compareSchemata` diffs `ColumnIR.unique`

**Bug (current behavior VERIFIED against code):** `compareColumnDetails`
(`schema-diff.ts:403-487`) compares type/nullable/default/collation/identity —
never `unique`.
- **`false→true` = guaranteed empty diff** (deterministic, no model-shape
  dependency): `autoUniqueIndexKeys` (`schema-diff.ts:756`) is built from
  SCHEMA-side `col.unique===true` but the schema-side implicit index is not in
  `schema.indexes[]`, so the "schema has index, DB doesn't → create" loop never
  fires, and `compareColumnDetails` ignores `unique`. **This is the clean RED
  test.**
- **`true→false` = model-dependent** (finding #8, resolved): with an INTROSPECTED
  db model (implicit unique index present in `db.indexes[]`) it emits a MISLABELED
  bare `drop_index` (`destructive:false`, "Drop index …", not "unique removed")
  via the drop loop (`schema-diff.ts:770`); with a hand-built db model it is
  SILENT. Frame the RED test to assert a correctly-labeled `alter_column_unique`
  instead of the current mislabeled/absent change.

**Fix (D7):** new `ChangeKind` `alter_column_unique`, emitted from
`compareColumnDetails` when `schema.unique !== db.unique`, carrying
`meta: { unique: boolean }` + `column`.
- UP `false→true`: `ALTER TABLE <t> ADD CONSTRAINT "<name>" UNIQUE ("col");`
- UP `true→false`: `ALTER TABLE <t> DROP CONSTRAINT IF EXISTS "<name>";`
- DOWN = the inverse (destructive: false both ways — no data loss).

**Full wiring checklist (finding #7 — the new kind must be added to ALL of):**
1. `ChangeKind` union (`schema-diff.ts`).
2. `changeToUpSQL` switch (`migration-sql.ts:761`).
3. `changeToDownSQL` switch (`migration-sql.ts:887`) — **MANDATORY explicit case.**
   Its `default → failSafeUnknownDownChange` silently degrades a forgotten case
   to a `-- WARNING` (NOT a compile error) — so a missing down-case is a silent
   bug, not a build failure. Add the case explicitly + test the down output.
4. `getPhase` (`migration-sql.ts:390`, exhaustive switch, NO default → a missing
   case IS a strict-mode compile error, good). **Pin the phase to the ADD PRIMARY
   KEY band, BEFORE the ADD FOREIGN KEY band** (re-check finding — M): a UNIQUE
   constraint added on a column can be the TARGET of an FK added in the same
   migration; if `alter_column_unique` ran in the later ADD CHECK CONSTRAINT band
   the FK would reference a not-yet-unique column and fail. Co-locating it with
   ADD PRIMARY KEY means UP order is `…add PK + add unique → add FK` (correct) and
   the DOWN reverse drops the FK before the unique (correct). `getPhase` maps by
   KIND not direction, so one bucket serves both toggle directions. Accepted
   caveat: the true→false DROP sits in an add-band rather than an early drop-band —
   valid SQL, and the pathological co-occurrences (drop-unique + drop-same-column,
   or drop-unique while adding an FK that needs it) don't arise from a coherent
   `col.unique` diff, so a two-kind split is unnecessary complexity (YAGNI).
5. `buildSummary()` (`schema-diff.ts:1268-1338`): add the new kind to the switch —
   increment **`columns.altered`** (matches `alter_column_collation`/
   `alter_column_identity`, which are also column-property toggles; verified). The
   switch has no `default`, so a missing case is uncounted — TS exhaustiveness
   flags it.
6. `isChangeSupported` (`migration-sql.ts:241`, `default: return true`) — UNIQUE
   is universal, no `DialectCapabilities` flag needed (no change required).

**Constraint naming (finding #6 — M; grounded to codebase philosophy):** name via
the PG convention `<t>_<col>_key`. The codebase has NO identifier-truncation
helper and is uniformly FAIL-LOUD (every 63-byte site throws via
`validateIdentifier`; `fkName`/`pkName`/`idxName` do not truncate). So do NOT
build a truncation helper (it would contradict the codebase's reject-don't-truncate
stance) — let a `>63`-byte name throw at `validateIdentifier`, consistent with the
rest of the DDL layer. **Documented limitation:** for names within 63 bytes the
convention round-trips (PG's inline `UNIQUE` uses the same `<t>_<col>_key`); a
unique whose PG name was truncated (long identifiers), collision-suffixed (`_keyN`),
explicitly named, or authored via `CREATE UNIQUE INDEX`/`constraints`/`indexes[]`
is NOT reliably dropped by `col.unique`'s toggle. Record in the guide + a
follow-up issue for exact-name-capture-at-introspection if the reporter needs
long-identifier support.

**Coordinate with `compareIndexes`:** `compareColumnDetails` now OWNS the
`col.unique` toggle; verify `compareIndexes` does NOT ALSO emit a `drop_index`/
`create_index` for the same implicit unique on either direction (double-emit).

**BDD:**
- `unique: false→true` ⇒ exactly one `alter_column_unique` (unique:true); UP
  `sql.equals` the ADD CONSTRAINT; no `create_index`.
- `unique: true→false` ⇒ exactly one `alter_column_unique` (unique:false); UP
  `sql.equals` DROP CONSTRAINT IF EXISTS; NO extra `drop_index`/`create_index`.
- unchanged `unique` ⇒ zero changes (regression on the whole
  "implicit unique index suppression" block `schema-diff.test.ts:765-862`).
- down of a `false→true` ⇒ DROP CONSTRAINT; down of `true→false` ⇒ ADD CONSTRAINT.
- e2e: create table w/ unique col → introspect → author non-unique → migrate →
  assert constraint gone; and reverse.

### Gap 4 — CHECK-expression validation accepts safe escaped literals

**Bug:** `validateSqlExpression` (`validate.ts:585-595`) blind-regex over the
full canonical CHECK text from `pg_get_constraintdef`. Rejects e.g.
`CHECK (status = ANY (ARRAY['a;b', 'c--d']))` where `;`/`--` are inside quoted
literals and cannot break out.

**Fix (D8 — REVISED):** a CHECK-scoped, QUOTE-AWARE forbidden-char scanner (NOT
an AST parse — `parseRawExpression` is an arithmetic-only hand-rolled parser that
would reject every real CHECK; see D8). New `validateCheckExpression(sql, ctx)`:
scan char-by-char tracking single-quote (`''` escape) and dollar-quote
(`$tag$…$tag$`) literal context; flag `;`/`--`/`/*`/`*/`/`\` ONLY outside
literals; reject on any unbalanced/unterminated quote. Apply ONLY at the 3 CHECK
call sites: `upAddCheckConstraint` (`migration-sql.ts:606`), the
`drop_check_constraint` down-reversal (`migration-sql.ts:1085`),
`generateConstraintsPhase` (`phases/constraints.ts:46`). Leave the other 13 call
sites on the existing `validateSqlExpression` (strict = fail-safe).

**Expression shape (VERIFIED):** `check.expression` is the FULL `CHECK (…)` clause
— introspection stores `pg_get_constraintdef(...)` verbatim (`introspection.ts:381`,
`buildCheckMap` `:502`) and `upAddCheckConstraint` (`migration-sql.ts:599-620`)
splices it RAW after `ADD CONSTRAINT <name> ` (no wrapper added by the emitter;
the wrapper must be in the value). The quote-aware scanner is wrapper-agnostic (it
scans whatever string it's given) — just scan, do NOT strip/parse structure.
Negative tests feed the full-`CHECK (…)` shape.

**Security invariant (BDD):**
- `status IN ('a;b','c--d')` (safe, quoted) ⇒ ACCEPTED, emitted verbatim.
- `status = ANY (ARRAY['a;b'::text])` (canonical pg form, safe) ⇒ ACCEPTED.
- `x = 1); DROP TABLE users; --` (injection) ⇒ REJECTED (`;` outside literal).
- `x = $$a$$; DROP` and an unclosed `x = $$a` ⇒ REJECTED (unbalanced/`;` outside).
- Lock every payload from `injection-defense-128.test.ts` /
  `ddl-migration-sql-injection.test.ts` / `ddl-security.test.ts` — all must STAY
  rejected under the quote-aware scanner.
- Index WHERE / RLS `USING` call sites unchanged (assert one still rejects a raw
  `;` to prove the swap was scoped, not global).

**Tests:** new positive cases (safe quoted `;`/`--`/`/* */`/`$$…$$` accepted) —
currently zero coverage of the false-positive direction. Existing injection
suites are the negative regression lock. RED→GREEN: point the CHECK sites back at
`validateSqlExpression` → the new safe-literal test goes red.

**Delivery note:** with the quote-aware scanner, Gap 4 is implementable and stays
in PR-A (the AST-parse blocker that would have stalled it is gone).

### Gap 1 — cross-schema FK end-to-end (declared referenced schema)

Vertical slice: type → DSL → introspection → diff → emit → tests. Fix sites
(all confirmed with file:line in the investigation):

**1a — types (`packages/types`)**
- `ForeignKeyIR.references` (`model-ir.ts:215-236`): add `readonly schema?: string`.

**1b — DSL authoring + build (`packages/core`)** — thread `schema?` through:
- `SchemaForeignKeyReference` (`schema-dsl-types.ts:53-74`) — add `schema?: string`.
- `col()` column-level FK build (`dx/schema.ts:1177-1183`).
- table-level composite FK build (`dx/schema.ts:1374-1385`).
- schema-bridge column-level (`dx/schema-bridge.ts:461-472`) + table-level
  (`dx/schema-bridge.ts:556-566`).
- Supporting TS shapes: `GeneratedColumn.references` / `GeneratedForeignKey.references`
  (`schema-bridge.ts:70-96`).
- Valibot (else the value is stripped on parse): `ForeignKeyReferenceSchema`
  (`schema-bridge.ts:981-990`), `TableDefWithConfigSchema.foreignKeys[].references`
  (`schema-bridge.ts:1022-1027`).
- Round-trip mapper (`schema-bridge.ts:1246-1249`).
- **Catch-all test (finding-sound recommendation):** one round-trip test —
  author `references.schema` in a DSL schema → `schemaToModelIR` → assert
  `ForeignKeyIR.references.schema` survives. This catches ANY missed construction
  site OR Valibot schema that silently strips the field on parse.

**1c — introspection (`packages/adapter-pgsql`)** — per D3/D4. The rewrite MUST be
a SHAPE-COMPATIBLE drop-in: emit the SAME column names/types the current
`information_schema` query does, so `buildFKMap` + `mapDeleteRule` stay UNCHANGED
(minimal blast radius) — plus ONE new `target_schema` column. Do this by
CASE-mapping the `pg_constraint` codes back to the words/strings the JS already
expects (adversarial findings #2, #4):
- Rewrite the FK query (`introspection.ts:254-279`) to `pg_constraint`
  (`contype='f'`) joined to `pg_class`/`pg_namespace` for BOTH source
  (`conrelid`) and referenced relation (`confrelid → relnamespace → nspname`).
  - **Letter-code → word mapping IN SQL** (finding #2 — S): `confdeltype`/
    `confupdtype` are single letters `a/r/c/n/d`; emit
    `CASE confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
    WHEN 'd' THEN 'SET DEFAULT' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END
    AS delete_rule` and the same for `confupdtype AS update_rule`. This keeps the
    existing `mapDeleteRule` (which is fed BOTH onDelete AND onUpdate — there is
    no `mapUpdateRule`) working verbatim. Without this, every FK (same-schema
    too) silently loses ON DELETE/UPDATE.
  - **Boolean deferred → 'YES'/'NO' IN SQL** (finding #4 — M): `condeferrable`/
    `condeferred` are booleans but `buildFKMap` does `=== 'YES'`; emit
    `CASE WHEN condeferrable THEN 'YES' ELSE 'NO' END AS is_deferrable` and same
    for `condeferred AS initially_deferred`.
  - **Composite pairing** (finding #5 — M): expand `conkey`/`confkey` via
    `unnest(conkey, confkey) WITH ORDINALITY AS u(attnum, confattnum, ord)` and
    `ORDER BY ord` so source/target column pairs stay aligned (do NOT rely on
    implicit array position). Resolve attnums to names via `pg_attribute`.
  - **Partition/inherited dedup** (finding #5 — M): add `AND c.conparentid = 0`
    (PG12+) so inherited/partition child FK clones don't duplicate the logical FK.
  - Restrict source to `WHERE nsp.nspname = $1` (the introspected schema);
    referenced schema is whatever `confrelid`'s namespace is (may differ).
- Carry the referenced namespace: add `target_schema` to `RawForeignKey`
  (`introspection.ts:86-96`) → `FKEntry` (`introspection.ts:617-625`, built in
  `buildFKMap` L628-648, add `targetSchema`) → `buildTableIR` FK construction
  (`introspection.ts:799-810`): set `references.schema` ONLY when
  `targetSchema !== sourceSchema` (D4 — same-schema stays `undefined`).
- **Relax the last-step guard** (finding #3 — S): `buildTableIR` currently does
  `if (!ctx.tableNames.includes(fk.target)) continue;` (`introspection.ts:~801`),
  which drops cross-schema FKs (target not in the single-schema `ctx.tableNames`)
  — making the whole introspection half a no-op. Change to: skip ONLY when the FK
  is same-schema AND target ∉ ctx.tableNames; keep it when `targetSchema` differs
  from the source schema (cross-schema FK is legitimately retained).
- Sibling `inferRelations` (`introspection.ts:956`) — keep consistent (RelationIR
  path, not DDL; low risk, note only).
- e2e MUST cover: same-schema FK round-trip preserves ON DELETE CASCADE / SET
  NULL / RESTRICT + deferred + NOT VALID (regression guard for the query rewrite),
  AND a genuine cross-schema FK yields populated `references.schema`.

**1d — diff (`packages/adapter-pgsql`)** — per D5:
- Fold `references.schema` into `fkKey` (`schema-diff.ts:698`) using
  `` `${fk.references.schema ?? ''}` `` (NOT a literal `"undefined"` — finding
  #12). Both sides normalize to `''` for same-schema ⇒ no phantom diff; a
  schema-only retarget ⇒ different key ⇒ `drop+add` (correct — PG can't re-point).

**1e — emit (`packages/adapter-pgsql`)** — per D6:
- `generateAddFKSQL` (`migration-sql.ts:1478`):
  `qualifyTable(fk.references.table, fk.references.schema ?? schemaName)`.
- `generateAlterTableAddFK` (`ddl-generator.ts:~329`): same, but this site takes a
  3rd `naming` arg — `qualifyTable(fk.references.table, fk.references.schema ??
  schemaName, naming)` (finding #12). It also uses `quoteIdentifier` (not the
  `quoteIdent`/`qualifyTable` of the migration path) — verify it validates the
  schema identifier equivalently.
- Update the now-stale comment at `generateAddFKSQL` L1476-1477 ("must be
  schema-qualified to resolve within the same schema") to reflect declared-schema
  resolution (finding #12).
- **Identifier-injection is already mitigated** (adversarial finding #11 —
  verified): a declared `references.schema` reaches emit via `qualifyTable` →
  `quoteIdent` → `validateIdentifier` (`validate.ts:184`, ASCII `^[a-zA-Z_]…$`,
  ≤63). Add a NEGATIVE test: `references.schema = 'a"; DROP TABLE x'` ⇒ rejected
  at emit (both the migration path AND the `ddl-generator` path).

**BDD:**
- Author FK `references: { table:'_platform_tenant', schema:'platform' }`,
  migrate into schema `tenant_a` ⇒ UP `sql.equals`
  `… REFERENCES "platform"."_platform_tenant" ("id") …`; owning table stays
  `"tenant_a"."orders"`.
- Same-schema FK (no `schema`) migrated into `tenant_a` ⇒
  `… REFERENCES "tenant_a"."<t>" …` (current behavior preserved — locks the
  previously-untested "qualified target" path).
- No `schemaName` at all ⇒ unqualified target (locks `migration-sql.test.ts:1834`).
- compareForeignKeys: FK whose ONLY change is `references.schema` ⇒ `drop+add`.
- compareForeignKeys: two identical same-schema FKs ⇒ zero changes
  (`schema-diff.test.ts:1927` regression).
- e2e round-trip: create a cross-schema FK in real PG → `introspect()` →
  `references.schema` populated with the real namespace; same-schema FK →
  `references.schema` undefined.

**Regression watch (§5 of investigation):** `schema-diff.test.ts:1927`;
`migration-sql.test.ts:1834`, `:398`, `:1799`; `ddl.test.ts:334/391`;
introspection round-trip suites.

---

## §4 Delivery plan — SINGLE PR (operator decision 2026-07-09)

All four gaps ship in ONE PR, `feat:` bump (Gap 1 adds the cross-schema-FK
capability; the release-please train takes the highest bump). Branch
`feat/265-ddl-migration-gaps`.

Implementation is two sequential codex `--mode exec` dispatches on the ONE branch
(each diff stays coherent + independently verifiable), then a SINGLE cross-family
review loop on the cumulative `base...HEAD` diff:
- **Dispatch A — gaps 3 → 2 → 4** (adapter-pgsql only; ascending risk; no public
  type change). Orchestrator verifies (typecheck + pure unit + `git diff --stat` +
  `diff_symbols`) before Dispatch B.
- **Dispatch B — gap 1** (types + core + adapter-pgsql; public type + introspection
  rewrite; vertical slice).

codex runs ONLY typecheck + pure unit tests (no containers — podman can't nest in
its sandbox). The ORCHESTRATOR runs the DB-backed e2e (`pnpm test:e2e`,
testcontainers) in main against the running stack — the introspection round-trip
and cross-schema FK apply MUST be proven there, not on codex's word.

---

## §5 Adversarial findings ledger (§12.5)

opus adversarial pass (code-verified via astix), 2026-07-08.

| # | Perspective | Finding | S/M/L | Resolution |
|---|-------------|---------|-------|------------|
| 1 | Security/Failure | Gap 4 `parseRawExpression` is a hand-rolled arithmetic-only parser (not libpg_query; `pgsql-parser` devDep-only) — rejects `=`/`<`/`IN`/`ANY`/`AND` ⇒ every real CHECK rejected | S | D8 REVISED → quote-aware forbidden-char scan |
| 2 | Failure | Gap 1 introspection: `pg_constraint` letter codes fed to `mapDeleteRule` (expects words), no `mapUpdateRule` ⇒ all ON DELETE/UPDATE silently NO ACTION | S | §1c: CASE-map letters→words IN SQL (shape-compatible query) |
| 3 | Failure | Gap 1 `buildTableIR` guard `!ctx.tableNames.includes(fk.target)` drops cross-schema FKs ⇒ introspection half is a no-op | S | §1c: relax guard — retain when cross-schema |
| 4 | Failure | Gap 1 `buildFKMap` computes `deferred` via string `=== 'YES'`; `pg_constraint` booleans ⇒ flag lost | M | §1c: CASE boolean→'YES'/'NO' IN SQL |
| 5 | Failure | Gap 1 `pg_constraint` needs `conparentid=0` + `unnest … WITH ORDINALITY ORDER BY ord` (partition dedup + composite pairing) | M | §1c added |
| 6 | Edge | Gap 2 `<t>_<col>_key` breaks on 63-byte truncation / `_keyN` collision — silent no-op DROP | M | Gap 2: PG-compatible truncation helper + documented limitation |
| 7 | Integration | Gap 2 `alter_column_unique` phase unspecified; `changeToDownSQL` default masks a forgotten down-case as WARNING (not compile error) | M | Gap 2: full wiring checklist + phase pinned + mandatory down-case |
| 8 | Integration | Gap 2 "true→false leaks drop_index today" claim likely wrong (likely silent) → RED framing must be empirically re-verified | M | Gap 2: verify-current-behavior-first note |
| 9 | Contract | 2-PR split clean, but Gap 4's S-blocker would stall PR-A | M | Resolved — quote-aware fix keeps Gap 4 in PR-A |
| 10 | Security | Gap 4 blind regex also bans `$$`/`\`; quote-aware rewrite must keep dollar-quoting safe | M | D8: dollar-quote handling + reject unbalanced |
| 11 | Security | Gap 1 identifier-injection already mitigated (schema→`validateIdentifier` at emit) | L | Add negative test (both emit paths) |
| 12 | Contract | Under-spec: getPhase value, `naming` arg at ddl-generator, stale comment, "libpg_query" wording, `fkKey` undefined-fold format | L | Fixed across D5/D8/1e/Gap 2 |

**Adversarial-confirmed SOUND (no change needed):** Gap 3 fully correct (implement
first); Gap 1 public-type backward-compat + D4/D5 + D6 emit chokepoint; Gap 4
call-site scoping (16 sites, 3 CHECK, 13 stay on strict regex = fail-safe); Gap 2
dedicated-kind choice over synthetic `create_index`; D9 testing conventions.

## §6 /llm --spec consensus ledger (§12.6)

codex `--mode consensus` pass, 2026-07-08 (agreement HIGH with opus adversarial on
the S-class items; findings deduplicated into §5 where overlapping).

| # | LLM | Finding | S/M/L | Resolution |
|---|-----|---------|-------|------------|
| c1 | codex | Gap 1 FK action/deferred/NOT VALID letter-code mapping under-specified | S | = §5 #2/#4 |
| c2 | codex | Gap 1 explicit same-schema churn may fail under locks/NOT VALID/drift | M | D4: documented; adversarial verified as idempotent no-op — accepted |
| c3 | codex | Gap 1 byte-exact schema comparison (no lowercasing) for quoted schemas | S | D4: byte-exact note added |
| c4 | codex | Gap 1 composite key needs `array_agg ORDER BY ordinality` | M | = §5 #5 |
| c5 | codex | Gap 1 partition/inherited FK duplication (conparentid/relkind) | M | = §5 #5 |
| c6 | codex | Gap 4 "strip leading CHECK/outer parens" fragile; extractor needed | M | Moot under quote-aware scan (wrapper-agnostic); shape-verify note added |
| c7 | codex | Gap 4 `SELECT <expr>` accepts volatile functions | M | Moot (no AST parse); PG rejects volatiles in CHECK at apply anyway |
| c8 | codex | Gap 2 phase/dispatch/destructive wiring under-specified | M | = §5 #7 |
| c9 | codex | 2-PR split has merge-order friction; PR-A first | S | §4: PR-A lands first (acknowledged) |

**Step 13 re-check (codex, on the amended spec):**

| # | LLM | Finding | S/M/L | Resolution |
|---|-----|---------|-------|------------|
| r1 | codex | Gap 4 dollar-quote grammar under-specified → false-negative risk (`$` after ident char is not a dollar-quote open) | S | D8: exact PG tag grammar `$$`/`$[A-Za-z_]…$`, not-preceded-by-ident-char; E-string fail-closed note |
| r2 | codex | Gap 2 phase in CHECK band breaks FK dependency (FK added before unique target exists); DOWN inverse | M | Gap 2: re-pinned to ADD PRIMARY KEY band (before ADD FOREIGN KEY) |
| r3 | codex | Gap 2 wiring omits `buildSummary()` bucket | L | Gap 2: added `constraints.altered` bucket |
| — | codex | SOUND (verified): Gap 1 `a/r/c/n/d` map, `conparentid=0` sentinel, multi-array `unnest … WITH ORDINALITY` pairing, relaxed FK guard; Gap 4 single-quote/`''`/comment/U& handling | — | No change |
