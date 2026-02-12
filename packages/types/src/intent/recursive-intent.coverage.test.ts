/**
 * Coverage tests for getNodeIdAlias in recursive-intent module.
 *
 * Tests all 4 branches:
 * 1. Explicit `as` alias (any kind)
 * 2. Column without alias → column name
 * 3. Literal without alias → 'node_id'
 * 4. Binary without alias → 'node_id'
 */
import { describe, expect, it } from 'vitest';
import type { RecursiveNodeIdExpr } from './recursive-intent.js';
import { getNodeIdAlias } from './recursive-intent.js';

describe('getNodeIdAlias', () => {
	// ------------------------------------------------------------------
	// Column expressions
	// ------------------------------------------------------------------

	it('returns explicit alias for column with as', () => {
		const expr: RecursiveNodeIdExpr = {
			kind: 'column',
			name: 'id',
			as: 'my_alias',
		};
		expect(getNodeIdAlias(expr)).toBe('my_alias');
	});

	it('returns column name when column has no alias', () => {
		const expr: RecursiveNodeIdExpr = { kind: 'column', name: 'id' };
		expect(getNodeIdAlias(expr)).toBe('id');
	});

	// ------------------------------------------------------------------
	// Literal expressions
	// ------------------------------------------------------------------

	it('returns explicit alias for literal with as', () => {
		const expr: RecursiveNodeIdExpr = {
			kind: 'literal',
			value: 1,
			as: 'lit_alias',
		};
		expect(getNodeIdAlias(expr)).toBe('lit_alias');
	});

	it('returns "node_id" for literal without alias', () => {
		const expr: RecursiveNodeIdExpr = { kind: 'literal', value: 1 };
		expect(getNodeIdAlias(expr)).toBe('node_id');
	});

	// ------------------------------------------------------------------
	// Binary expressions
	// ------------------------------------------------------------------

	it('returns explicit alias for binary with as', () => {
		const expr: RecursiveNodeIdExpr = {
			kind: 'binary',
			left: { kind: 'column', name: 'a' },
			op: '||',
			right: { kind: 'column', name: 'b' },
			as: 'combo',
		};
		expect(getNodeIdAlias(expr)).toBe('combo');
	});

	it('returns "node_id" for binary without alias', () => {
		const expr: RecursiveNodeIdExpr = {
			kind: 'binary',
			left: { kind: 'column', name: 'a' },
			op: '||',
			right: { kind: 'column', name: 'b' },
		};
		expect(getNodeIdAlias(expr)).toBe('node_id');
	});
});
