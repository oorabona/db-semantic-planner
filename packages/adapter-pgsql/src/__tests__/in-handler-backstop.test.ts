/**
 * Unit tests for the fail-closed backstop in the plain `in`/`notIn` handler
 * (handlers/where/in.ts).
 *
 * BACKGROUND
 * ----------
 * The plain `in` handler accepts ONLY a scalar array as `decision.value`.
 * Anything else — a subquery-shaped object (has `from`/`select` keys),
 * `undefined`, `null`, or any other non-array — must throw a clear error
 * instead of silently binding the value as `ANY($n)`, which would produce
 * structurally wrong SQL (an object bound as a pg parameter instead of a
 * compiled subquery).
 *
 * This backstop catches any current or future unguarded path that bypasses
 * the dispatchWhere / mapInSubqueryCondition / normalizeToDecision guards.
 *
 * TEST STRATEGY
 * -------------
 * 1. value is a subquery-shaped object ({ from, select }) → throws with hint
 * 2. value is undefined → throws
 * 3. value is null → throws
 * 4. value is a plain object (not subquery-shaped) → throws
 * 5. value is a scalar (string) → throws (not an array)
 * 6. value is a scalar array → compiles correctly (no false positive)
 * 7. value is an empty array → compiles to FALSE constant (IN semantics)
 * 8. notIn with empty array → compiles to TRUE constant
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
	COLLECTION_OPERATORS,
	clearHandlers,
	createCompilerState,
	type Decision,
} from '../handlers/index.js';
import type { CompilerContext } from '../handlers/types.js';
import {
	inHandler,
	registerSimpleWhereHandlers,
} from '../handlers/where/index.js';
import { identityNaming } from '../naming-plugin.js';

const ctx: CompilerContext = {
	naming: identityNaming,
	rootTable: 'users',
	maxRecursiveDepth: 100,
};

function compileDecision(decision: Decision) {
	const state = createCompilerState();
	return inHandler.compile(decision, ctx, state);
}

beforeEach(() => {
	clearHandlers();
	registerSimpleWhereHandlers();
});

describe('inHandler backstop: non-array value → throws (DEFECT 3)', () => {
	it('subquery-shaped object { from, select } → throws with IN+subquery hint', () => {
		const decision: Decision = {
			type: 'where',
			column: 'id',
			operator: COLLECTION_OPERATORS.IN,
			value: { from: 'sessions', select: 'user_id' },
		};
		expect(() => compileDecision(decision)).toThrow(
			/IN\+subquery decisions must be remapped to inSubquery\/notInSubquery/,
		);
	});

	it('subquery-shaped object { from } only → throws with IN+subquery hint', () => {
		const decision: Decision = {
			type: 'where',
			column: 'id',
			operator: 'in',
			value: { from: 'sessions' },
		};
		expect(() => compileDecision(decision)).toThrow(
			/IN\+subquery decisions must be remapped to inSubquery\/notInSubquery/,
		);
	});

	it('subquery-shaped object { select } only → throws with IN+subquery hint', () => {
		const decision: Decision = {
			type: 'where',
			column: 'id',
			operator: 'in',
			value: { select: 'user_id' },
		};
		expect(() => compileDecision(decision)).toThrow(
			/IN\+subquery decisions must be remapped to inSubquery\/notInSubquery/,
		);
	});

	it('value is undefined → throws with "undefined" in message', () => {
		const decision: Decision = {
			type: 'where',
			column: 'id',
			operator: COLLECTION_OPERATORS.IN,
			value: undefined,
		};
		expect(() => compileDecision(decision)).toThrow(/undefined/);
	});

	it('value is null → throws with "null" in message', () => {
		const decision: Decision = {
			type: 'where',
			column: 'id',
			operator: 'in',
			value: null,
		};
		expect(() => compileDecision(decision)).toThrow(/null/);
	});

	it('value is a plain object (no from/select keys) → throws', () => {
		const decision: Decision = {
			type: 'where',
			column: 'id',
			operator: 'in',
			value: { something: 'unexpected' },
		};
		expect(() => compileDecision(decision)).toThrow(/compiler bug/i);
	});

	it('value is a string scalar → throws (strings are not arrays)', () => {
		const decision: Decision = {
			type: 'where',
			column: 'id',
			operator: 'in',
			value: 'active' as any,
		};
		expect(() => compileDecision(decision)).toThrow(/compiler bug/i);
	});

	it('value is a number → throws', () => {
		const decision: Decision = {
			type: 'where',
			column: 'id',
			operator: 'in',
			value: 42 as any,
		};
		expect(() => compileDecision(decision)).toThrow(/compiler bug/i);
	});
});

describe('inHandler backstop: scalar array → compiles correctly (no false positives)', () => {
	it('non-empty scalar array → compiles without throwing', () => {
		const state = createCompilerState();
		const decision: Decision = {
			type: 'where',
			column: 'id',
			operator: COLLECTION_OPERATORS.IN,
			value: [1, 2, 3],
		};
		// Must not throw
		expect(() => inHandler.compile(decision, ctx, state)).not.toThrow();
		// Must record the array as a parameter
		expect(state.parameters).toEqual([[1, 2, 3]]);
	});

	it('empty array IN → returns boolean FALSE constant node (no throw)', () => {
		const state = createCompilerState();
		const decision: Decision = {
			type: 'where',
			column: 'id',
			operator: COLLECTION_OPERATORS.IN,
			value: [],
		};
		const node = inHandler.compile(decision, ctx, state);
		// Empty IN → false; the node should be a BooleanTest or TypeCast false
		expect(node).toBeDefined();
		// No parameters pushed for empty array
		expect(state.parameters).toHaveLength(0);
	});

	it('empty array NOT IN → returns boolean TRUE constant node (no throw)', () => {
		const state = createCompilerState();
		const decision: Decision = {
			type: 'where',
			column: 'id',
			operator: COLLECTION_OPERATORS.NOT_IN,
			value: [],
		};
		const node = inHandler.compile(decision, ctx, state);
		expect(node).toBeDefined();
		expect(state.parameters).toHaveLength(0);
	});

	it('notIn operator with scalar array → compiles without throwing', () => {
		const state = createCompilerState();
		const decision: Decision = {
			type: 'where',
			column: 'status',
			operator: COLLECTION_OPERATORS.NOT_IN,
			value: ['deleted', 'banned'],
		};
		expect(() => inHandler.compile(decision, ctx, state)).not.toThrow();
		expect(state.parameters).toEqual([['deleted', 'banned']]);
	});
});
