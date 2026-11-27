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

import { createOrm, isNotNull, isNull, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

// ============================================================================
// Helpers
// ============================================================================

const db = schema({
	variable_defs: {
		id: { type: 'integer', primaryKey: true },
	},
	def_variable_uses: {
		id: { type: 'integer', primaryKey: true },
		def_id: ref('variable_defs', { as: 'def', inverse: 'def_variable_uses' }),
	},
	orders: {
		id: { type: 'integer', primaryKey: true },
	},
	order_items: {
		id: { type: 'integer', primaryKey: true },
		deleted_at: { type: 'timestamp', nullable: true },
		order_id: ref('orders', { as: 'order', inverse: 'order_items' }),
	},
});
const orm = createOrm({
	model: db.model,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

// ============================================================================
// REF-IN-FILTER: dotted column names in WHERE / filter conditions
// ============================================================================

describe('REF-IN-FILTER: buildColumnRef splits dotted column names', () => {
	it('ref("alias.col") in isNotNull filter produces "alias"."col", not "root"."alias.col"', () => {
		// Primary regression: ref('def_variable_uses.id') inside isNotNull()
		// previously emitted "variable_defs"."def_variable_uses.id" (3-part, wrong).
		const { sql, params } = orm
			.select('variable_defs')
			.join('def_variable_uses')
			.where(isNotNull('def_variable_uses.id'))
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT variable_defs.* FROM variable_defs JOIN def_variable_uses AS def_variable_uses ON variable_defs.id = def_variable_uses.def_id WHERE def_variable_uses.id IS NOT NULL',
			params: [],
		});
	});

	it('ref("alias.col") in isNull filter produces "alias"."col"', () => {
		const { sql, params } = orm
			.select('orders')
			.join('order_items')
			.where(isNull('order_items.deleted_at'))
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT orders.* FROM orders JOIN order_items AS order_items ON orders.id = order_items.order_id WHERE order_items.deleted_at IS NULL',
			params: [],
		});
	});
});
