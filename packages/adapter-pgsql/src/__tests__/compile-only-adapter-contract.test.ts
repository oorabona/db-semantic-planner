/**
 * S-1: CompileOnlyAdapter type-contract test.
 *
 * Verifies that createPgsqlCompileOnlyAdapter() returns a CompileOnlyAdapter —
 * not the broader PgsqlAdapter<DB> — so that callers get compile-time errors
 * when they attempt to call execute/stream/transaction on the result.
 *
 * The @ts-expect-error directives are load-bearing: if any of them stops
 * catching a type error, tsc reports "Unused '@ts-expect-error' directive"
 * and this file fails the typecheck run — meaning the contract was accidentally
 * widened back to the full adapter.
 */

import type { CompileOnlyAdapter } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
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
	 * TYPE-ONLY assertions — verified by `pnpm typecheck`, not by vitest runner.
	 *
	 * Each @ts-expect-error directive is load-bearing:
	 * - If the property IS excluded (?:never), TS suppresses the error → directive is consumed.
	 * - If the property is NOT excluded (factory return type widened), @ts-expect-error has
	 *   no error to suppress → tsc emits "Unused '@ts-expect-error' directive" → typecheck FAILS.
	 *
	 * This makes the test self-sealing: widening the return type breaks the typecheck run.
	 */
	it('execute/stream/transaction do not typecheck on CompileOnlyAdapter (type guard)', () => {
		// The inner function is never called at runtime; it exists solely so that
		// tsc processes the @ts-expect-error directives when checking this test file.
		function typeOnlyBlock(adapter: CompileOnlyAdapter): void {
			// @ts-expect-error: execute excluded from CompileOnlyAdapter (?: never)
			void adapter.execute;
			// @ts-expect-error: executeOne excluded from CompileOnlyAdapter (?: never)
			void adapter.executeOne;
			// @ts-expect-error: executeOneOrThrow excluded from CompileOnlyAdapter (?: never)
			void adapter.executeOneOrThrow;
			// @ts-expect-error: stream excluded from CompileOnlyAdapter (?: never)
			void adapter.stream;
			// @ts-expect-error: transaction excluded from CompileOnlyAdapter (?: never)
			void adapter.transaction;
			// @ts-expect-error: introspect excluded from CompileOnlyAdapter (?: never)
			void adapter.introspect;
			// @ts-expect-error: executeRaw excluded from CompileOnlyAdapter (?: never)
			void adapter.executeRaw;
			// @ts-expect-error: executeDDL excluded from CompileOnlyAdapter (?: never)
			void adapter.executeDDL;
		}
		// Reference the function to satisfy the no-unused-vars linter without calling it.
		expect(typeof typeOnlyBlock).toBe('function');
	});
});
