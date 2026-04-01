/**
 * FR-10 Block 2 — JoinIntent SQL compilation tests.
 *
 * Tests the full DX→SQL pipeline for .join() calls:
 *   - Relation mode: FK auto-resolved from model (belongsTo and hasMany/hasOne)
 *   - Table mode:   Explicit ON condition (including self-joins)
 *   - Multiple chained joins
 *
 * All assertions use exact `toEqual` SQL matching (normalised whitespace).
 */

import { createOrm, eq, ref, schema } from '@dbsp/core';
import type { WhereComparisonIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema
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
	embeddings: {
		id: { type: 'integer', primaryKey: true },
		vector: { type: 'text' },
	},
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

/** Normalise whitespace for SQL comparison */
function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FR-10 Block 2: JoinIntent SQL compilation', () => {
	// --- Relation mode -------------------------------------------------------

	it('T1: relation mode — INNER JOIN (default) via FK (calls.caller_id → symbols)', () => {
		const orm = buildOrm();
		const dump = orm.select('calls').join('caller').dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT calls.* FROM (calls JOIN symbols AS caller ON caller_id = caller.id) caller',
		);
		expect(dump.params).toEqual([]);
	});

	it('T2: relation mode — LEFT JOIN via FK', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('calls')
			.join('caller', { type: 'left' })
			.dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT calls.* FROM (calls LEFT JOIN symbols AS caller ON caller_id = caller.id) caller',
		);
		expect(dump.params).toEqual([]);
	});

	it('T3: relation mode — belongsTo join (symbols.file_id → files)', () => {
		const orm = buildOrm();
		const dump = orm.select('symbols').join('file').dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.* FROM (symbols JOIN files AS file ON file_id = file.id) file',
		);
		expect(dump.params).toEqual([]);
	});

	it('T6: relation mode — callee LEFT JOIN', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('calls')
			.join('callee', { type: 'left' })
			.dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT calls.* FROM (calls LEFT JOIN symbols AS callee ON callee_id = callee.id) callee',
		);
		expect(dump.params).toEqual([]);
	});

	// --- Table mode ----------------------------------------------------------

	it('T4: table mode — self-join with explicit ON condition', () => {
		const orm = buildOrm();
		// ON embeddings.id < e2.id
		// - field uses dotted notation ('embeddings.id') → explicit table qualifier
		// - value is FieldRef(scope:'outer') which resolves to outerTable (tableAlias = 'e2')
		const onCond: WhereComparisonIntent = {
			kind: 'comparison',
			field: 'embeddings.id',
			operator: 'lt',
			value: { kind: 'fieldRef', column: 'id', scope: 'outer' },
		};
		const dump = (orm as any)
			.select('embeddings')
			.join('embeddings', { on: onCond, as: 'e2', type: 'inner' })
			.dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT embeddings.* FROM embeddings JOIN embeddings AS e2 ON embeddings.id < e2.id',
		);
		expect(dump.params).toEqual([]);
	});

	// --- Multiple joins -------------------------------------------------------

	it('T5: multiple chained joins — both FK joins present in SQL', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('calls')
			.join('caller')
			.join('callee')
			.dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT calls.* FROM ((calls JOIN symbols AS caller ON caller_id = caller.id) caller JOIN symbols AS callee ON callee_id = callee.id) callee',
		);
		expect(dump.params).toEqual([]);
	});

	// --- Bug 5: alias must not be used for FK resolution ---------------------

	it('T8: alias does not shadow relation name for FK resolution', () => {
		// Bug 5 fix: .join('caller', { as: 'callee' }) must resolve FK from 'caller'
		// not from 'callee'. Before the fix, r.name === intent.alias caused 'callee'
		// (which is also a valid relation on calls) to match the wrong relation.
		const orm = buildOrm();
		const dump = (orm as any)
			.select('calls')
			.join('caller', { as: 'c', type: 'inner' })
			.dump();
		// FK must come from caller (caller_id), not from callee (callee_id)
		expect(ws(dump.sql)).toContain('caller_id');
		expect(ws(dump.sql)).not.toContain('callee_id');
		// The output alias should be 'c'
		expect(ws(dump.sql)).toContain('symbols AS c');
	});

	// --- Combined WHERE + JOIN ------------------------------------------------

	it('T7: relation join combined with root WHERE clause', () => {
		const orm = buildOrm();
		const dump = (orm as any)
			.select('calls')
			.join('caller')
			.where(eq('id', 42))
			.dump();
		const sql = ws(dump.sql);
		expect(sql).toMatch(/JOIN symbols AS caller/);
		expect(sql).toMatch(/WHERE/i);
		expect(sql).toMatch(/\$1/);
		expect(dump.params).toEqual([42]);
	});
});

describe('FR-10 Block 2: JOIN ON aliases pre-population', () => {
	// Verifies Gap 3 fix: table-mode WhereCompilerCtx now pre-populates the
	// aliases map so expressions that look up root-table or alias mappings
	// work correctly when tableAlias differs from rootTable.

	it('T9: table mode — aliases map populated (rootTable → rootTable entry)', () => {
		const orm = buildOrm();
		// ON embeddings.id = e2.id (equality, explicit qualifiers on both sides)
		const onCond = {
			kind: 'comparison',
			field: 'embeddings.id',
			operator: 'eq',
			value: { kind: 'fieldRef', column: 'id', scope: 'outer' as const },
		};
		const dump = (orm as any)
			.select('embeddings')
			.join('embeddings', { on: onCond, as: 'e2', type: 'inner' })
			.dump();
		// Must produce qualified references on both sides of the ON condition
		expect(ws(dump.sql)).toContain('embeddings.id = e2.id');
	});

	it('T10: table mode — alias=rootTable case (no alias entry needed)', () => {
		const orm = buildOrm();
		// ON embeddings.id = embeddings.id (degenerate self-join without alias)
		const onCond = {
			kind: 'comparison',
			field: 'embeddings.id',
			operator: 'eq',
			value: { kind: 'fieldRef', column: 'id', scope: 'outer' as const },
		};
		const dump = (orm as any)
			.select('embeddings')
			.join('embeddings', { on: onCond, type: 'inner' })
			.dump();
		expect(ws(dump.sql)).toContain('JOIN embeddings');
		expect(dump.params).toEqual([]);
	});
});
