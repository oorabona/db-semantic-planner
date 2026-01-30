# ADAPTER-PGSQL Phase 3: Migration & Sunset

**Status:** 🟡 IN PROGRESS
**Goal:** Replace adapter-kysely with adapter-pgsql as the sole adapter

## Overview

Phase 3 completes the adapter migration by:
1. Updating all imports to use @dbsp/adapter-pgsql
2. Making PgsqlAdapter the default in createOrm()
3. Removing adapter-kysely package
4. Cleaning up comparison infrastructure

## Prerequisites

- ✅ Phase 2 complete (full parity confirmed)
- ✅ 291 E2E tests pass with both adapters
- ✅ 0 mismatches between adapters

---

## Block 1: Update Imports & Default Adapter

### Tasks
- [ ] Update `packages/core/src/dx/orm.ts` - createOrm() to use PgsqlAdapter by default
- [ ] Update E2E tests to import from @dbsp/adapter-pgsql
- [ ] Update examples (if any) to use @dbsp/adapter-pgsql
- [ ] Verify all tests still pass

### Files to Modify
- `packages/core/src/dx/orm.ts`
- `tests/e2e/testkit/db.ts`
- `tests/e2e/*.test.ts` (as needed)

---

## Block 2: Add Deprecation Notice to adapter-kysely

### Tasks
- [ ] Add deprecation notice to adapter-kysely README
- [ ] Add console.warn in createKyselyAdapter()
- [ ] Document migration path

---

## Block 3: Remove adapter-kysely Package

### Tasks
- [ ] Remove `packages/adapter-kysely/` directory
- [ ] Remove from `pnpm-workspace.yaml` (if listed)
- [ ] Remove from root `package.json` devDependencies
- [ ] Update any remaining imports
- [ ] Run full test suite to verify

---

## Block 4: Cleanup Comparison Infrastructure

### Tasks
- [ ] Remove `DBSP_COMPARISON_MODE` handling from testkit
- [ ] Remove comparison utilities (or keep for future use)
- [ ] Update testkit to use PgsqlAdapter only
- [ ] Final test run

---

## Risk Mitigation

- **Rollback:** Keep adapter-kysely in git history
- **Gradual:** Can keep both adapters temporarily if issues found
- **Testing:** Full E2E suite validates migration

---

## Success Criteria

- [ ] All E2E tests pass with PgsqlAdapter only
- [ ] No references to adapter-kysely remain
- [ ] createOrm() defaults to PgsqlAdapter
- [ ] Clean build with no warnings
