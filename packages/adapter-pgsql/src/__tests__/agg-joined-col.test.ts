/**
 * @module agg-joined-col.test
 * Tests for AGG-JOINED-COL: aggregate shortcuts handle dotted column refs
 * on JOINed tables correctly.
 *
 * Bug: count('callee_calls.id') produced COUNT("symbols"."callee_calls.id")
 *      because buildAggregate() passed the dotted string to columnRef() as-is.
 *
 * Fix: buildAggregate() now splits on '.' — producing COUNT("callee_calls"."id").
 *
 * Scenarios:
 *   SC-01: count() with dotted column ref → COUNT("rel"."col")
 *   SC-02: min() with dotted column ref → MIN("rel"."col")
 *   SC-03: HAVING with dotted aggregate → HAVING COUNT(...) > $1
 *   SC-06: fn('count', ref('rel.col')) still works (INV-01)
 */

import { createOrm, exprRef, fn, gt, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const db = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		file_id: ref('files', { as: 'file', inverse: 'symbols' }),
	},
	files: {
		id: { type: 'integer', primaryKey: true },
		path: { type: 'text' },
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		callee_id: ref('symbols', { as: 'callee', inverse: 'callee_calls' }),
	},
} as const);
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

// ── SC-01: count() with dotted column ref ─────────────────────────────────

describe('SC-01: count(dotted.col) produces COUNT("rel"."col")', () => {
	it('count("callee_calls.id") emits COUNT(callee_calls.id) NOT COUNT("symbols"."callee_calls.id")', () => {
		const { sql, params } = orm
			.select('symbols')
			.columns(['id'])
			.join('callee_calls')
			.count('callee_calls.id', 'call_count')
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT symbols.id, count(callee_calls.id) AS call_count FROM symbols JOIN calls AS callee_calls ON symbols.id = callee_calls.callee_id',
			params: [],
		});
	});
});

// ── SC-02: min() with dotted column ref ──────────────────────────────────

describe('SC-02: min(dotted.col) produces MIN("rel"."col")', () => {
	it('min("file.path") emits MIN(file.path) NOT MIN("symbols"."file.path")', () => {
		const { sql, params } = orm
			.select('symbols')
			.columns(['id'])
			.join('file')
			.min('file.path', 'min_path')
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT symbols.id, min(file.path) AS min_path FROM symbols JOIN files AS file ON symbols.file_id = file.id',
			params: [],
		});
	});
});

// ── SC-03: HAVING with dotted aggregate ──────────────────────────────────

describe('SC-03: HAVING with dotted aggregate col', () => {
	it('having decision with dotted function field contains HAVING COUNT(callee_calls.id) > $1', () => {
		const { sql, params } = orm
			.select('symbols')
			.columns(['id'])
			.join('callee_calls')
			.groupBy(['id'])
			.count('callee_calls.id', 'call_count')
			.having(gt('call_count', 10))
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT symbols.id, count(callee_calls.id) AS call_count FROM symbols JOIN calls AS callee_calls ON symbols.id = callee_calls.callee_id GROUP BY symbols.id HAVING count(callee_calls.id) > CAST($1 AS bigint)',
			params: [10],
		});
	});
});

// ── SC-06: fn('count', ref('rel.col')) still works (INV-01) ───────────────

describe('SC-06: fn("count", ref("rel.col")) still works (invariant)', () => {
	it('fn("count", exprRef("callee_calls.id")) emits count(callee_calls.id)', () => {
		const { sql, params } = orm
			.select('symbols')
			.join('callee_calls')
			.columns([fn('count', exprRef('callee_calls.id')).as('cnt')])
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT count(callee_calls.id) AS cnt FROM symbols JOIN calls AS callee_calls ON symbols.id = callee_calls.callee_id',
			params: [],
		});
	});
});
