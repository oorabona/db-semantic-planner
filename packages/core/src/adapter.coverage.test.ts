/**
 * Coverage tests for adapter runtime helpers.
 *
 * Tests all 6 feature-detection type guards, both error classes,
 * and the assertCapability function.
 */

import type { Adapter, BaseAdapter } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	AdapterRequiredError,
	assertCapability,
	supportsDDLGeneration,
	supportsExecution,
	supportsIntrospection,
	supportsRawSql,
	supportsStreaming,
	supportsTransactions,
	UnsupportedCapabilityError,
} from './adapter.js';

// ============================================================================
// supportsExecution
// ============================================================================

describe('supportsExecution', () => {
	it('returns false for empty object', () => {
		expect(supportsExecution({} as BaseAdapter)).toBe(false);
	});

	it('returns false when only execute is present (missing executeOne)', () => {
		const adapter = { execute: () => {} } as unknown as BaseAdapter;
		expect(supportsExecution(adapter)).toBe(false);
	});

	it('returns false when execute is not a function', () => {
		const adapter = {
			execute: 'notFunction',
			executeOne: () => {},
		} as unknown as BaseAdapter;
		expect(supportsExecution(adapter)).toBe(false);
	});

	it('returns true when execute and executeOne are both functions', () => {
		const adapter = {
			execute: () => {},
			executeOne: () => {},
		} as unknown as BaseAdapter;
		expect(supportsExecution(adapter)).toBe(true);
	});
});

// ============================================================================
// supportsStreaming
// ============================================================================

describe('supportsStreaming', () => {
	it('returns false for empty object', () => {
		expect(supportsStreaming({} as BaseAdapter)).toBe(false);
	});

	it('returns false when stream is not a function', () => {
		const adapter = { stream: 'notFunction' } as unknown as BaseAdapter;
		expect(supportsStreaming(adapter)).toBe(false);
	});

	it('returns true when stream is a function', () => {
		const adapter = { stream: () => {} } as unknown as BaseAdapter;
		expect(supportsStreaming(adapter)).toBe(true);
	});
});

// ============================================================================
// supportsIntrospection
// ============================================================================

describe('supportsIntrospection', () => {
	it('returns false for empty object', () => {
		expect(supportsIntrospection({} as BaseAdapter)).toBe(false);
	});

	it('returns false when introspect is not a function', () => {
		const adapter = { introspect: 42 } as unknown as BaseAdapter;
		expect(supportsIntrospection(adapter)).toBe(false);
	});

	it('returns true when introspect is a function', () => {
		const adapter = { introspect: () => {} } as unknown as BaseAdapter;
		expect(supportsIntrospection(adapter)).toBe(true);
	});
});

// ============================================================================
// supportsTransactions
// ============================================================================

describe('supportsTransactions', () => {
	it('returns false for empty object', () => {
		expect(supportsTransactions({} as BaseAdapter)).toBe(false);
	});

	it('returns false when only transaction is present (missing withSchema)', () => {
		const adapter = { transaction: () => {} } as unknown as BaseAdapter;
		expect(supportsTransactions(adapter)).toBe(false);
	});

	it('returns false when transaction is not a function', () => {
		const adapter = {
			transaction: 'notFunction',
			withSchema: () => {},
		} as unknown as BaseAdapter;
		expect(supportsTransactions(adapter)).toBe(false);
	});

	it('returns true when transaction and withSchema are both present as functions', () => {
		const adapter = {
			transaction: () => {},
			withSchema: () => {},
		} as unknown as BaseAdapter;
		expect(supportsTransactions(adapter)).toBe(true);
	});
});

// ============================================================================
// supportsRawSql
// ============================================================================

describe('supportsRawSql', () => {
	it('returns false for empty object', () => {
		expect(supportsRawSql({} as BaseAdapter)).toBe(false);
	});

	it('returns false when executeRaw is not a function', () => {
		const adapter = { executeRaw: null } as unknown as BaseAdapter;
		expect(supportsRawSql(adapter)).toBe(false);
	});

	it('returns true when executeRaw is a function', () => {
		const adapter = { executeRaw: () => {} } as unknown as BaseAdapter;
		expect(supportsRawSql(adapter)).toBe(true);
	});
});

// ============================================================================
// supportsDDLGeneration
// ============================================================================

describe('supportsDDLGeneration', () => {
	it('returns false for empty object', () => {
		expect(supportsDDLGeneration({} as BaseAdapter)).toBe(false);
	});

	it('returns false when generateDDL is not a function', () => {
		const adapter = { generateDDL: true } as unknown as BaseAdapter;
		expect(supportsDDLGeneration(adapter)).toBe(false);
	});

	it('returns true when generateDDL is a function', () => {
		const adapter = { generateDDL: () => {} } as unknown as BaseAdapter;
		expect(supportsDDLGeneration(adapter)).toBe(true);
	});
});

// ============================================================================
// Error Classes
// ============================================================================

describe('AdapterRequiredError', () => {
	it('sets name to "AdapterRequiredError"', () => {
		const error = new AdapterRequiredError('execute');
		expect(error.name).toBe('AdapterRequiredError');
	});

	it('includes operation name in message', () => {
		const error = new AdapterRequiredError('stream');
		expect(error.message).toContain('stream');
		expect(error.message).toContain('requires an adapter');
	});

	it('extends Error', () => {
		const error = new AdapterRequiredError('query');
		expect(error).toBeInstanceOf(Error);
	});
});

describe('UnsupportedCapabilityError', () => {
	it('sets name to "UnsupportedCapabilityError"', () => {
		const error = new UnsupportedCapabilityError(
			'withSchema',
			'supportsSchemas',
		);
		expect(error.name).toBe('UnsupportedCapabilityError');
	});

	it('includes operation and capability in message', () => {
		const error = new UnsupportedCapabilityError(
			'recursiveQuery',
			'supportsRecursiveCTE',
		);
		expect(error.message).toContain('recursiveQuery');
		expect(error.message).toContain('supportsRecursiveCTE');
	});

	it('extends Error', () => {
		const error = new UnsupportedCapabilityError('op', 'supportsStreaming');
		expect(error).toBeInstanceOf(Error);
	});
});

// ============================================================================
// assertCapability
// ============================================================================

describe('assertCapability', () => {
	function makeAdapter(
		overrides: Partial<Record<string, boolean>> = {},
	): Adapter {
		return {
			capabilities: {
				supportsReturning: false,
				supportsSchemas: false,
				supportsStreaming: false,
				supportsRecursiveCTE: false,
				supportsWindowFunctions: false,
				supportsArrayType: false,
				...overrides,
			},
		} as unknown as Adapter;
	}

	it('does not throw when capability is true', () => {
		const adapter = makeAdapter({ supportsSchemas: true });
		expect(() =>
			assertCapability(adapter, 'supportsSchemas', 'withSchema'),
		).not.toThrow();
	});

	it('throws UnsupportedCapabilityError when capability is false', () => {
		const adapter = makeAdapter({ supportsSchemas: false });
		expect(() =>
			assertCapability(adapter, 'supportsSchemas', 'withSchema'),
		).toThrow(UnsupportedCapabilityError);
	});

	it('thrown error contains correct operation and capability', () => {
		const adapter = makeAdapter({ supportsRecursiveCTE: false });
		try {
			assertCapability(adapter, 'supportsRecursiveCTE', 'recursiveQuery');
			expect.unreachable('should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(UnsupportedCapabilityError);
			expect((error as Error).message).toContain('recursiveQuery');
			expect((error as Error).message).toContain('supportsRecursiveCTE');
		}
	});

	it('passes for each capability when set to true', () => {
		const capabilities = [
			'supportsReturning',
			'supportsSchemas',
			'supportsStreaming',
			'supportsRecursiveCTE',
			'supportsWindowFunctions',
			'supportsArrayType',
		] as const;

		for (const cap of capabilities) {
			const adapter = makeAdapter({ [cap]: true });
			expect(() => assertCapability(adapter, cap, `test-${cap}`)).not.toThrow();
		}
	});
});
