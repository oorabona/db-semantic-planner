/**
 * S-1 / M-4: CompileOnlyAdapter type-contract test.
 *
 * Verifies that createPgsqlCompileOnlyAdapter() returns a CompileOnlyAdapter —
 * not the broader PgsqlAdapter<DB> — so that callers get compile-time errors
 * when they attempt to call execute/stream/transaction on the result.
 *
 * M-4 note: The test file is excluded from `packages/adapter-pgsql/tsconfig.json`
 * (test files are not compiled), so @ts-expect-error directives on `?: never`
 * property reads are never verified by `pnpm typecheck`. This test uses
 * `expectTypeOf` from vitest instead, enforced by vitest typecheck mode
 * (see `typecheck.enabled` in `packages/adapter-pgsql/vitest.config.ts`).
 *
 * Regression gate: changing `createPgsqlCompileOnlyAdapter`'s return type from
 * `CompileOnlyAdapter` to `PgsqlAdapter<DB>` causes vitest to emit a TypeCheckError
 * on the implementation (`EXIT:1`), surfacing the widening before it reaches callers.
 * The `?: never` markers in CompileOnlyAdapter prevent callers from statically
 * accessing execution methods — verified: restore return type → tests pass (EXIT:0).
 */

import type { CompileOnlyAdapter } from '@dbsp/types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

describe('createPgsqlCompileOnlyAdapter — type contract (S-1)', () => {
	it('returns a value assignable to CompileOnlyAdapter', () => {
		// If the factory return type is wider than CompileOnlyAdapter, this
		// assignment would fail typecheck (strict structural check).
		const adapter: CompileOnlyAdapter = createPgsqlCompileOnlyAdapter();
		expect(adapter).toBeDefined();
	});

	it('adapter.compile is callable on the returned instance', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		// Smoke: compile() is the core capability of CompileOnlyAdapter.
		expect(typeof adapter.compile).toBe('function');
	});

	/**
	 * TYPE-CONTRACT assertions — verified by vitest's type checking AND at runtime.
	 *
	 * `expectTypeOf(adapter).not.toHaveProperty(...)` fails the test if the named
	 * property exists on the TYPE returned by the factory. This catches accidental
	 * widening of the return type (e.g. removing `?: never` from CompileOnlyAdapter).
	 *
	 * Note: The runtime object IS a PgsqlAdapter instance and its prototype DOES have
	 * these methods (they throw ExecutionError without a pool). The `?: never` exclusion
	 * is purely a compile-time type-system contract — it prevents callers from
	 * STATICALLY accessing these methods, not from the prototype having them.
	 * The `expectTypeOf` checks below enforce the compile-time contract.
	 */
	it('execute/stream/transaction are excluded from CompileOnlyAdapter type (type contract)', () => {
		const adapter = createPgsqlCompileOnlyAdapter();

		// Type-level assertions: fail if the factory return type is widened
		// to include these methods (i.e., if `?: never` is removed from CompileOnlyAdapter).
		expectTypeOf(adapter).not.toHaveProperty('execute');
		expectTypeOf(adapter).not.toHaveProperty('executeWithMeta');
		expectTypeOf(adapter).not.toHaveProperty('executeOne');
		expectTypeOf(adapter).not.toHaveProperty('executeOneOrThrow');
		expectTypeOf(adapter).not.toHaveProperty('stream');
		expectTypeOf(adapter).not.toHaveProperty('streamRaw');
		expectTypeOf(adapter).not.toHaveProperty('transaction');
		expectTypeOf(adapter).not.toHaveProperty('introspect');
		expectTypeOf(adapter).not.toHaveProperty('executeRaw');
		expectTypeOf(adapter).not.toHaveProperty('executeDDL');
	});
});
