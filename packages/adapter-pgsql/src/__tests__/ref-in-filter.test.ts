/**
 * REF-IN-FILTER: regression tests for buildColumnRef with dotted column names.
 *
 * Bug: ref('alias.col') inside filter(isNotNull(...)) produced "root"."alias.col"
 * (3-part, wrong) instead of "alias"."col" (2-part, correct) because buildColumnRef
 * did not split dotted column names before passing them to columnRef().
 *
 * Fix: buildColumnRef() now splits on '.' and uses the left part as the table qualifier
 * and the right part as the column name, bypassing root table alias substitution.
 */

import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';

// ============================================================================
// Helpers
// ============================================================================

function makePlan(
	rootTable: string,
	decisions: SimplifiedPlanReport['decisions'],
): SimplifiedPlanReport {
	return { rootTable, decisions };
}

// ============================================================================
// REF-IN-FILTER: dotted column names in WHERE / filter conditions
// ============================================================================

describe('REF-IN-FILTER: buildColumnRef splits dotted column names', () => {
	it('ref("alias.col") in isNotNull filter produces "alias"."col", not "root"."alias.col"', () => {
		// Primary regression: ref('def_variable_uses.id') inside isNotNull()
		// previously emitted "variable_defs"."def_variable_uses.id" (3-part, wrong).
		const plan = makePlan('variable_defs', [
			{ type: 'select', column: '*' },
			{
				type: 'where',
				column: 'def_variable_uses.id',
				operator: 'isNotNull',
			},
		]);

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		// Must produce 2-part reference: def_variable_uses.id (deparser uses unquoted form)
		expect(sql).toContain('def_variable_uses.id is not null');
		// Must NOT contain the root table as the qualifier
		expect(sql).not.toContain('variable_defs.def_variable_uses');
	});

	it('ref("alias.col") in isNull filter produces "alias"."col"', () => {
		const plan = makePlan('orders', [
			{ type: 'select', column: '*' },
			{
				type: 'where',
				column: 'order_items.deleted_at',
				operator: 'isNull',
			},
		]);

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('order_items.deleted_at is null');
		expect(sql).not.toContain('orders.order_items');
	});

	it('ref("alias.col") in equality comparison produces "alias"."col"', () => {
		const plan = makePlan('posts', [
			{ type: 'select', column: '*' },
			{
				type: 'where',
				column: 'post_tags.tag_id',
				operator: '=',
				value: 42,
			},
		]);

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('post_tags.tag_id = $1');
		expect(sql).not.toContain('posts.post_tags');
		expect(result.parameters).toEqual([42]);
	});

	// ============================================================================
	// Regression guard: simple column names (no dot) still use root table alias
	// ============================================================================

	it('simple ref("col") without dot still uses root table alias (isNotNull)', () => {
		const plan = makePlan('users', [
			{ type: 'select', column: '*' },
			{
				type: 'where',
				column: 'email',
				operator: 'isNotNull',
			},
		]);

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('users.email is not null');
	});

	it('simple ref("col") without dot still uses root table alias (equality)', () => {
		const plan = makePlan('products', [
			{ type: 'select', column: '*' },
			{
				type: 'where',
				column: 'status',
				operator: '=',
				value: 'active',
			},
		]);

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('products.status = $1');
		expect(result.parameters).toEqual(['active']);
	});
});
