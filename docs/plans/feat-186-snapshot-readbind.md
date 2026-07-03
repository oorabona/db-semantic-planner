# FEAT-186 — snapshot a read-only `| bind` referenced across an intervening mutation

```yaml
doc-meta: { issue: 186, status: canonical, created: 2026-06-20 }
```

## §1 Problem
In a multi-statement `orm.nql` program, a read-only `| bind` is compiled as an inline CTE re-evaluated at each reference. If referenced AFTER an intervening mutation, it would re-read post-mutation state (read-after-write drift). #173 fails loud on this (`rejectReadBindingReferenceAcrossMutation`, `packages/nql/src/compiler/index.ts:392`, trigger `lastMutationStatement > definitionIndex`). #186 lifts that fail-loud by MATERIALIZING the read-bind as a SNAPSHOT at its source position (execute once before the mutation, capture rows, feed downstream as a table-anchored VALUES CTE) — preserving at-definition snapshot semantics. Back-compat: only widens what is accepted.

## §2 Design — conditional snapshot (minimal, strictly correct)
Snapshot a read-bind ONLY when it is referenced after an intervening mutation; read-binds that do NOT cross a mutation keep the inline-CTE path unchanged. (Within one transaction, snapshot ≡ inline EXCEPT when an intervening mutation writes the read-bind's data — exactly the drift case — so conditional is correct and avoids an extra round-trip for the common case.)

1. **Compile: throw → tag.** Replace the `rejectReadBindingReferenceAcrossMutation` throw with TAGGING the crossing read-bind so the executor snapshots it. Surface it through the program sequence (a new step kind e.g. `query-snapshot`, or a `snapshot: true` flag on the read-bind step) carrying the read-bind's `QueryIntent` + its registered `NqlBindingOutputSchema` (projected columns). Keep `rejectInvalidReadBindingDependencies` detecting the cross-mutation case (both pre- and post-compile passes) — it now MARKS instead of throwing.
2. **Execute: capture at source position.** In `executeNqlProgramSequence` (`packages/core/src/dx/nql.ts:1665`), add the missing execute hook for a snapshot-tagged non-final query step: run `txAdapter.execute(compiled)` for the read-bind query at its source-order position (before the later mutation), `snapshotMutationRows(...)` the rows, and store via `createRuntimeBinding` into `runtimeBindings` (the SAME path mutation bindings use, ~:1705) — so later references resolve to a table-anchored VALUES CTE, not the inline SELECT.
3. **Adapter: source-table anchor.** `compileNqlRuntimeBindingCte` (`packages/adapter-pgsql/src/pgsql-adapter.ts:412`) anchors the empty/typed CTE on a source table; for mutation bindings that's `mutationBindings.get(name).table`. For a snapshot read-bind, thread the anchor from the read-bind's `QueryIntent.from` (the source single table). Reuse the existing type-casting (`resolveRuntimeBindingColumnType` then `originalDbType`/`validateTypeName`), the empty-rows `WHERE false` case, and the 32k param cap unchanged.
4. **Dependency-filter.** A snapshot read-bind moves into the runtime-binding class then becomes subject to `filterMapByRuntimeBindingDependencies` like mutation bindings (only emit when referenced). Non-snapshot read-binds keep their always-emit behavior.
5. **Row shape.** Reuse `toRuntimeBindingRow` (canonicalizes DB column names to model/logical names via the read-bind's output schema) + `snapshotMutationRows` clone (rows come from `adapter.execute` as plain objects then `structuredClone` is safe; snapshot immediately after execute).

## §3 Edge cases (verify against this list — self-review the diff before reporting)
- Empty snapshot then table-anchored `SELECT cols FROM <from> WHERE false` (no VALUES); later reference yields zero rows (NOT a re-read).
- Ordering: a read SELECT may carry ORDER BY then snapshot preserves the returned order (better-behaved than mutation RETURNING).
- 32k param cap: snapshot rows × columns count against the cap (same enforcement); a large snapshot exceeding it must fail loud with the existing cap error, not silently truncate.
- Column canonicalization: projected columns come from the read-bind's `NqlBindingOutputSchema`; `toRuntimeBindingRow` resolves both logical + snake_case keys.
- Type anchor: `QueryIntent.from` must be a single real source table (the read-bind is single-source by the binding rules) — fail loud if not resolvable.
- A read-bind referenced BOTH before AND after a mutation: the snapshot (pre-mutation) is the single materialization used for ALL references (consistent — pre-mutation everywhere); confirm no double-emission (inline + snapshot) for the same name.
- A read-bind depending on an EARLIER mutation's RETURNING (read-after-write by design, #173) then referenced after a LATER mutation: the snapshot executes after the earlier mutation (its source position) — confirm ordering holds.

## §4 Out of scope
- Always-snapshot mode (broad option) — not needed; conditional is correct + cheaper.
- Non-single-source read-binds as snapshots (the binding rules already constrain read-binds to single-source for the relevant paths).

## §5 Tests
- INVERT the #173 fail-loud unit (`nql-bindings.test.ts` ~:379, the `#186` case): was throw then now compiles + runs with snapshot semantics.
- **E2E real-DB (the drift authority)**: a read-bind over table T; an intervening mutation that WOULD change T's matching rows; a later statement referencing the read-bind then assert the later statement sees the PRE-mutation snapshot rows (NOT the post-mutation drift). Plus: empty-snapshot case; multi-row + ORDER BY preserved; a read-bind referenced both before and after a mutation (same pre-mutation rows both times).
- Unit: the tag/step-kind emission; the runtime-binding CTE for a read-bind snapshot (table-anchored VALUES with `QueryIntent.from` anchor); dependency-filter now applies.

## §6 Verify
`pnpm clean:artifacts`; rebuild types→nql→core→adapter-pgsql; `tsc --noEmit` + vitest green (core + nql + adapter). E2E against a real Postgres (the drift assertion is the row-correctness authority). Cross-family gate (codex+copilot) clean + opus senior (security/correctness: read-after-write drift — verify the snapshot is taken at source position, pre-mutation, and the inline path is untouched for non-crossing read-binds). Closes #186.
