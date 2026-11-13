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

import {
	and,
	createOrm,
	eq,
	exprRef,
	fn,
	neq,
	param,
	ref,
	relationColumn,
	schema,
} from '@dbsp/core';
import type { WhereComparisonIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

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
		project_id: ref('projects', { as: 'project', inverse: 'files' }),
	},
	projects: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		caller_id: ref('symbols', { as: 'caller', inverse: 'caller_calls' }),
		callee_id: ref('symbols', { as: 'callee', inverse: 'callee_calls' }),
	},
	embeddings: {
		id: { type: 'integer', primaryKey: true },
		symbol_id: { type: 'integer' },
		model: { type: 'text' },
		vector: { type: 'text' },
	},
} as const);

function buildOrm() {
	const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
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
			'SELECT calls.* FROM calls JOIN symbols AS caller ON calls.caller_id = caller.id',
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
			'SELECT calls.* FROM calls LEFT JOIN symbols AS caller ON calls.caller_id = caller.id',
		);
		expect(dump.params).toEqual([]);
	});

	it('T3: relation mode — belongsTo join (symbols.file_id → files)', () => {
		const orm = buildOrm();
		const dump = orm.select('symbols').join('file').dump();
		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.* FROM symbols JOIN files AS file ON symbols.file_id = file.id',
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
			'SELECT calls.* FROM calls LEFT JOIN symbols AS callee ON calls.callee_id = callee.id',
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
			'SELECT calls.* FROM calls JOIN symbols AS caller ON calls.caller_id = caller.id JOIN symbols AS callee ON calls.callee_id = callee.id',
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

	it('T11: table mode — ON param and WHERE param keep distinct placeholders', () => {
		const orm = buildOrm();
		const onCond = and(
			eq('symbols.id', exprRef('embeddings.symbol_id')),
			eq('embeddings.model', param('text-embedding-3-small')),
		);
		const dump = (orm as any)
			.select('symbols')
			.join('embeddings', { type: 'left', on: onCond })
			.where(eq('symbols.name', 'normalize.ts'))
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.* FROM symbols LEFT JOIN embeddings AS embeddings ON symbols.id = embeddings.symbol_id AND embeddings.model = $2 WHERE symbols.name = $1',
		);
		expect(dump.params).toEqual(['normalize.ts', 'text-embedding-3-small']);
	});

	it('T12: table mode — two ON params are renumbered after the WHERE param', () => {
		const orm = buildOrm();
		const firstOn = and(
			eq('symbols.id', exprRef('e_openai.symbol_id')),
			eq('e_openai.model', param('text-embedding-3-small')),
		);
		const secondOn = and(
			eq('symbols.id', exprRef('e_local.symbol_id')),
			eq('e_local.model', param('bge-small-en')),
		);
		const dump = (orm as any)
			.select('symbols')
			.join('embeddings', { type: 'left', on: firstOn, as: 'e_openai' })
			.join('embeddings', { type: 'left', on: secondOn, as: 'e_local' })
			.where(eq('symbols.name', 'planner.ts'))
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.* FROM symbols LEFT JOIN embeddings AS e_openai ON symbols.id = e_openai.symbol_id AND e_openai.model = $2 LEFT JOIN embeddings AS e_local ON symbols.id = e_local.symbol_id AND e_local.model = $3 WHERE symbols.name = $1',
		);
		expect(dump.params).toEqual([
			'planner.ts',
			'text-embedding-3-small',
			'bge-small-en',
		]);
	});

	it('T13: table mode — multiple bound params in one ON renumber contiguously', () => {
		const orm = buildOrm();
		const onCond = and(
			eq('symbols.id', exprRef('embeddings.symbol_id')),
			eq('embeddings.model', param('m1')),
			eq('embeddings.vector', param('v1')),
		);
		// No `as any` cast: exercises the public table-mode .join(table, { on })
		// contract directly (QueryBuilder types this overload).
		const dump = orm
			.select('symbols')
			.join('embeddings', { type: 'left', on: onCond })
			.where(eq('symbols.name', 'x'))
			.dump();

		expect(ws(dump.sql)).toEqual(
			'SELECT symbols.* FROM symbols LEFT JOIN embeddings AS embeddings ON symbols.id = embeddings.symbol_id AND embeddings.model = $2 AND embeddings.vector = $3 WHERE symbols.name = $1',
		);
		expect(dump.params).toEqual(['x', 'm1', 'v1']);
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

	it('T10: table mode — implicit alias colliding with root is refused', () => {
		const orm = buildOrm();
		// An unaliased self-join would emit the root qualifier twice.
		const onCond = {
			kind: 'comparison',
			field: 'embeddings.id',
			operator: 'eq',
			value: { kind: 'fieldRef', column: 'id', scope: 'outer' as const },
		};
		expect(() =>
			(orm as any)
				.select('embeddings')
				.join('embeddings', { on: onCond, type: 'inner' })
				.dump(),
		).toThrowError(
			new Error("Query scope already binds qualifier 'embeddings'."),
		);
	});
});

describe('#982: multi-hop relation join', () => {
	const CALLEE = 'JOIN symbols AS callee ON calls.callee_id = callee.id';
	const CALLEE_FILE =
		'JOIN files AS callee_file ON callee.file_id = callee_file.id';
	const C = 'JOIN symbols AS c ON calls.callee_id = c.id';
	const CF = 'JOIN files AS cf ON c.file_id = cf.id';

	it('multi-hop relation join — inner on every hop', () => {
		const dump = buildOrm().select('calls').join('callee.file').dump();
		expect(ws(dump.sql)).toEqual(
			`SELECT calls.* FROM calls ${CALLEE} ${CALLEE_FILE}`,
		);
		expect(dump.params).toEqual([]);
	});

	it('multi-hop relation join — left on every hop', () => {
		const dump = buildOrm()
			.select('calls')
			.join('callee.file', { type: 'left' })
			.dump();
		expect(ws(dump.sql)).toEqual(
			`SELECT calls.* FROM calls LEFT ${CALLEE} LEFT ${CALLEE_FILE}`,
		);
	});

	it('multi-hop relation join — third hop correlates to the second', () => {
		const dump = buildOrm().select('calls').join('callee.file.project').dump();
		expect(ws(dump.sql)).toEqual(
			`SELECT calls.* FROM calls ${CALLEE} ${CALLEE_FILE} JOIN projects AS callee_file_project ON callee_file.project_id = callee_file_project.id`,
		);
	});

	it('multi-hop relation join — as names the last hop', () => {
		const dump = buildOrm()
			.select('calls')
			.join('callee.file', { as: 'cf' })
			.dump();
		expect(ws(dump.sql)).toEqual(
			`SELECT calls.* FROM calls ${CALLEE} JOIN files AS cf ON callee.file_id = cf.id`,
		);
	});

	it('multi-hop relation join — as array names every hop', () => {
		const dump = buildOrm()
			.select('calls')
			.join('callee.file', { as: ['c', 'cf'] })
			.dump();
		expect(ws(dump.sql)).toEqual(`SELECT calls.* FROM calls ${C} ${CF}`);
	});

	it('multi-hop relation join — relation paths of every hop resolve under GROUP BY', () => {
		const dump = buildOrm()
			.select('calls')
			.join('callee.file', { type: 'left', as: ['c', 'cf'] })
			.columns([
				relationColumn('callee.file', 'path', 'file'),
				fn('count', exprRef('calls.id')).as('n'),
			])
			.groupBy(['callee.id', 'callee.file.path'])
			.dump();
		expect(ws(dump.sql)).toEqual(
			`SELECT cf.path AS file, count(calls.id) AS n FROM calls LEFT ${C} LEFT ${CF} GROUP BY c.id, cf.path`,
		);
	});

	it('multi-hop relation join — default hop aliases group', () => {
		const dump = buildOrm()
			.select('calls')
			.join('callee.file')
			.columns([relationColumn('callee.file', 'path', 'file')])
			.groupBy(['callee_file.path'])
			.dump();
		expect(ws(dump.sql)).toEqual(
			`SELECT callee_file.path AS file FROM calls ${CALLEE} ${CALLEE_FILE} GROUP BY callee_file.path`,
		);
	});

	it('multi-hop relation join — a hop aliased like an earlier hop table', () => {
		for (const as of [
			'symbols',
			['c', 'symbols'],
			['files', 'symbols'],
		] as const) {
			const [first, last] = typeof as === 'string' ? ['callee', as] : as;
			const dump = buildOrm()
				.select('calls')
				.join('callee.file', { as })
				.dump();
			expect(ws(dump.sql)).toEqual(
				`SELECT calls.* FROM calls JOIN symbols AS ${first} ON calls.callee_id = ${first}.id JOIN files AS ${last} ON ${first}.file_id = ${last}.id`,
			);
		}
	});

	it('multi-hop relation join — DISTINCT over a hop column', () => {
		const dump = buildOrm()
			.select('calls')
			.join('callee.file')
			.columns([relationColumn('callee.file', 'path', 'file')])
			.distinct()
			.dump();
		expect(ws(dump.sql)).toEqual(
			`SELECT DISTINCT callee_file.path AS file FROM calls ${CALLEE} ${CALLEE_FILE}`,
		);
	});

	it('multi-hop relation join — root WHERE on the last hop alias', () => {
		const dump = buildOrm()
			.select('calls')
			.join('callee.file')
			.where(eq('callee_file.path', 'a.ts'))
			.dump();
		expect(ws(dump.sql)).toEqual(
			`SELECT calls.* FROM calls ${CALLEE} ${CALLEE_FILE} WHERE callee_file.path = $1`,
		);
		expect(dump.params).toEqual(['a.ts']);
	});

	it('multi-hop relation join — DISTINCT ON and ORDER BY by relation path', () => {
		const dump = buildOrm()
			.select('calls')
			.join('callee.file', { as: ['c', 'cf'] })
			.distinctOn('callee.file.path')
			.orderBy('callee.file.path')
			.dump();
		expect(ws(dump.sql)).toEqual(
			`SELECT DISTINCT ON (cf.path) calls.* FROM calls ${C} ${CF} ORDER BY cf.path ASC`,
		);
	});

	it('multi-hop relation join — HAVING binds a hop alias', () => {
		const dump = buildOrm()
			.select('calls')
			.join('callee.file', { as: ['c', 'cf'] })
			.columns([fn('count', exprRef('calls.id')).as('n')])
			.groupBy(['cf.path'])
			.having(neq('cf.path', 'x'))
			.dump();
		expect(ws(dump.sql)).toEqual(
			`SELECT count(calls.id) AS n FROM calls ${C} ${CF} GROUP BY cf.path HAVING cf.path <> $1`,
		);
		expect(dump.params).toEqual(['x']);
	});

	it('multi-hop relation join — a later ON sees every hop', () => {
		const dump = buildOrm()
			.select('calls')
			.join('callee.file', { as: ['c', 'cf'] })
			.join('projects', { as: 'p', on: eq('p.id', exprRef('cf.project_id')) })
			.dump();
		expect(ws(dump.sql)).toEqual(
			`SELECT calls.* FROM calls ${C} ${CF} JOIN projects AS p ON p.id = cf.project_id`,
		);
	});

	it('multi-hop relation join — a values join after a path keeps its payload', () => {
		const orm = buildOrm();
		const query = orm
			.select('calls')
			.join('callee.file')
			.join(orm.batchValues([[1]], ['id'], ['int4'], { alias: 'bv' }), {
				on: eq('bv.id', exprRef('calls.id')),
			})
			.where(eq('calls.id', 9));
		const dump = query.dump();
		expect(ws(dump.sql)).toEqual(
			`SELECT calls.* FROM calls ${CALLEE} ${CALLEE_FILE} JOIN unnest(CAST($2 AS int4[])) AS bv(id) ON bv.id = calls.id WHERE calls.id = $1`,
		);
		expect(dump.params).toEqual([9, [1]]);
		expect(
			query.plan().execution!.joins.map((join) => join.intentIndex),
		).toEqual([0, 0, 1]);
	});

	it('multi-hop relation join — one path joined twice is ambiguous', () => {
		expect(() =>
			buildOrm()
				.select('calls')
				.join('callee.file', { as: ['c1', 'f1'] })
				.join('callee.file', { as: ['c2', 'f2'] })
				.columns([relationColumn('callee.file', 'path', 'p')])
				.dump(),
		).toThrowError(
			new Error(
				'relation column "callee.file"."path" is ambiguous between emitted aliases "f1" and "f2"',
			),
		);
	});

	it('multi-hop relation join — an unknown middle segment is refused by name', () => {
		expect(() =>
			buildOrm().select('calls').join('callee.nope').plan(),
		).toThrowError(
			new Error(
				"join('callee.nope'): relation 'nope' not found on table 'symbols'. Available: file, caller_calls, callee_calls",
			),
		);
	});

	it('multi-hop relation join — a hop alias already bound is refused', () => {
		expect(() =>
			buildOrm().select('calls').join('callee').join('callee.file').plan(),
		).toThrowError(new Error("Query scope already binds qualifier 'callee'."));
	});

	it('multi-hop relation join — an earlier ON cannot see a later hop alias', () => {
		expect(() =>
			buildOrm()
				.select('calls')
				.join('files', { on: eq('callee_file.id', exprRef('calls.id')) })
				.join('callee.file')
				.plan(),
		).toThrowError(
			new Error("WHERE qualifier 'callee_file' is not visible in this query."),
		);
	});
});
