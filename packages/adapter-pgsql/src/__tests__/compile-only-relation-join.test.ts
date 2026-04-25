/**
 * Regression test: compile-only adapter relation-mode join without constructor model.
 *
 * Before the fix, `createPgsqlCompileOnlyAdapter()` (no options) stored
 * `this.model = undefined`.  The `compileDeps` getter returned `{ model: undefined }`
 * so `compileJoinIntents` threw:
 *   "join('caller'): relation-mode join requires a model for FK resolution."
 *
 * After the fix, `buildCompileDeps(options)` reads `options?.model ?? this.model`,
 * and `query-builder.ts` always puts the schema model in `options.model`, so the
 * compiler receives the model even when the adapter was constructed without one.
 */

import { createOrm, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Minimal schema: calls → caller/callee → symbols → file → files
// ---------------------------------------------------------------------------

const testSchema = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		file_id: ref('files', { as: 'file', inverse: 'symbols' }),
	},
	files: {
		id: { type: 'integer', primaryKey: true },
		path: { type: 'text' },
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		caller_id: ref('symbols', { as: 'caller', inverse: 'caller_calls' }),
		callee_id: ref('symbols', { as: 'callee', inverse: 'callee_calls' }),
	},
} as const);

/** Normalise whitespace for SQL comparison */
function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compile-only adapter — relation-mode join without constructor model', () => {
	it('resolves FK from schema model passed via createOrm when adapter has no model in options', () => {
		// KEY: no model option passed to createPgsqlCompileOnlyAdapter()
		const adapter = createPgsqlCompileOnlyAdapter();
		const orm = createOrm({ schema: testSchema, adapter });

		// Before the fix this threw:
		// "join('caller'): relation-mode join requires a model for FK resolution."
		const dump = orm.select('calls').join('caller').dump();

		expect(ws(dump.sql)).toContain('JOIN');
		expect(ws(dump.sql)).toContain('symbols');
		expect(dump.params).toEqual([]);
	});

	it('SQL contains the correct JOIN alias (caller) and FK column (caller_id)', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const orm = createOrm({ schema: testSchema, adapter });

		const dump = orm.select('calls').join('caller').dump();
		const sql = ws(dump.sql);

		// FK resolution: calls.caller_id → symbols.id, alias = caller
		expect(sql).toContain('symbols AS caller');
		expect(sql).toContain('caller_id');
	});

	it('callee join also resolves FK correctly without constructor model', () => {
		const adapter = createPgsqlCompileOnlyAdapter();
		const orm = createOrm({ schema: testSchema, adapter });

		const dump = orm.select('calls').join('callee').dump();
		const sql = ws(dump.sql);

		expect(sql).toContain('JOIN');
		expect(sql).toContain('symbols AS callee');
		expect(sql).toContain('callee_id');
	});

	it('adapter with explicit model option still works (regression guard)', () => {
		// Constructor-time model should still work as before
		const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
		const orm = createOrm({ schema: testSchema, adapter });

		const dump = orm.select('calls').join('caller').dump();
		expect(ws(dump.sql)).toContain('JOIN');
		expect(ws(dump.sql)).toContain('symbols AS caller');
	});

	it('G-1: withSchema + relation-mode join propagates both schemaName AND model', () => {
		// Verifies that orm.withSchema() works end-to-end when the adapter has no
		// constructor model: schemaName from withSchema + model from createOrm both
		// reach the compiler through buildCompileDeps(options).
		const adapter = createPgsqlCompileOnlyAdapter(); // no model, no schema
		const orm = createOrm({ schema: testSchema, adapter });

		const dump = orm.withSchema('tenant_x').select('calls').join('caller').dump();
		const sql = ws(dump.sql);

		expect(sql).toContain('tenant_x');
		expect(sql).toContain('calls');
		expect(sql).toContain('JOIN');
		expect(sql).toContain('symbols');
	});

	it('G-3: options.model from createOrm overrides constructor this.model when adapter has wrong model', () => {
		// Adapter is constructed with schemaA (files only, no calls table or relations).
		// createOrm is called with testSchema (calls + symbols + files + relations).
		// The compiler must use testSchema.model (from options.model) to resolve the
		// 'caller' relation on 'calls' — if it used the adapter's constructor model
		// it would find no relation and throw.
		const schemaA = schema({
			files: {
				id: { type: 'integer', primaryKey: true },
				path: { type: 'text' },
			},
		} as const);

		const adapter = createPgsqlCompileOnlyAdapter({ model: schemaA.model });
		// createOrm injects testSchema.model into options.model on every compile call
		const orm = createOrm({ schema: testSchema, adapter });

		// 'calls' and 'caller' relation do not exist in schemaA.model —
		// if the adapter's constructor model wins, this throws.
		const dump = orm.select('calls').join('caller').dump();
		expect(ws(dump.sql)).toContain('JOIN');
		expect(ws(dump.sql)).toContain('symbols AS caller');
	});
});
