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
 *   SC-04: non-dotted aggregate unchanged (regression guard)
 *   SC-05: count(*) unchanged (regression guard)
 *   SC-06: fn('count', ref('rel.col')) still works (INV-01)
 */

import { exprRef, fn } from '@dbsp/core';
import type { CustomFnExpressionIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	compilePlan,
	type PlanDecision,
	type SimplifiedPlanReport,
} from '../compiler.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function compile(plan: SimplifiedPlanReport): {
	sql: string;
	parameters: readonly unknown[];
} {
	return compilePlan(plan);
}

/** JOIN decision for callee_calls (hasMany from symbols) */
const calleeCallsJoin = {
	type: 'includeStrategy',
	choice: 'join',
	joinType: 'inner',
	relationName: 'callee_calls',
	targetTable: 'callee_calls',
	relationType: 'hasMany',
	foreignKey: 'symbol_id',
	parentKey: 'id',
	columns: ['id'],
} satisfies PlanDecision;

/** JOIN decision for file (belongsTo from symbols) */
const fileJoin = {
	type: 'includeStrategy',
	choice: 'join',
	joinType: 'left',
	relationName: 'file',
	targetTable: 'files',
	relationType: 'belongsTo',
	foreignKey: 'file_id',
	parentKey: 'id',
	columns: ['path'],
} satisfies PlanDecision;

// ── SC-01: count() with dotted column ref ─────────────────────────────────

describe('SC-01: count(dotted.col) produces COUNT("rel"."col")', () => {
	it('count("callee_calls.id") emits COUNT(callee_calls.id) NOT COUNT("symbols"."callee_calls.id")', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{ type: 'select', column: 'id', table: 'symbols' },
				calleeCallsJoin,
				{
					type: 'selectFunction',
					function: 'count',
					column: 'callee_calls.id',
					alias: 'call_count',
				} satisfies PlanDecision,
			],
		};

		const { sql } = compile(plan);

		// Must use the relation alias, not the root table
		expect(sql).toMatch(/COUNT\(callee_calls\.id\)/i);
		// Must NOT produce the wrong form
		expect(sql).not.toMatch(/COUNT\("?symbols"?\."callee_calls\.id"\)/i);
		expect(sql).not.toMatch(/COUNT\("?symbols"?\."?callee_calls\.id"?\)/i);
	});
});

// ── SC-02: min() with dotted column ref ──────────────────────────────────

describe('SC-02: min(dotted.col) produces MIN("rel"."col")', () => {
	it('min("file.path") emits MIN(file.path) NOT MIN("symbols"."file.path")', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{ type: 'select', column: 'id', table: 'symbols' },
				fileJoin,
				{
					type: 'selectFunction',
					function: 'min',
					column: 'file.path',
					alias: 'min_path',
				} satisfies PlanDecision,
			],
		};

		const { sql } = compile(plan);

		// Must use the relation alias
		expect(sql).toMatch(/MIN\(file\.path\)/i);
		// Must NOT produce the wrong form
		expect(sql).not.toMatch(/MIN\("?symbols"?\."file\.path"\)/i);
	});
});

// ── SC-03: HAVING with dotted aggregate ──────────────────────────────────

describe('SC-03: HAVING with dotted aggregate col', () => {
	it('having decision with dotted function field contains HAVING COUNT(callee_calls.id) > $1', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{ type: 'select', column: 'id', table: 'symbols' },
				calleeCallsJoin,
				{ type: 'groupBy', column: 'id', table: 'symbols' },
				{
					type: 'selectFunction',
					function: 'count',
					column: 'callee_calls.id',
					alias: 'call_count',
				} satisfies PlanDecision,
				{
					type: 'having',
					operator: '>',
					column: 'call_count',
					function: 'count',
					field: 'callee_calls.id',
					value: 10,
					paramIndex: 1,
				} satisfies PlanDecision,
			],
		};

		const { sql } = compile(plan);

		// HAVING clause must be present
		expect(sql).toMatch(/HAVING/i);
		// COUNT must reference the relation column
		expect(sql).toMatch(/COUNT\(callee_calls\.id\)/i);
		// Must NOT produce the wrong form
		expect(sql).not.toMatch(/COUNT\("?symbols"?\."callee_calls\.id"\)/i);
	});
});

// ── SC-04: non-dotted aggregate unchanged ─────────────────────────────────

describe('SC-04: non-dotted count() uses root table alias (regression guard)', () => {
	it('count("id") produces COUNT(symbols.id)', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{
					type: 'selectFunction',
					function: 'count',
					column: 'id',
					alias: 'total',
				} satisfies PlanDecision,
			],
		};

		const { sql } = compile(plan);

		// Non-dotted: still qualifies with root table
		expect(sql).toMatch(/COUNT\(symbols\.id\)/i);
		// Must NOT contain dot in column name
		expect(sql).not.toMatch(/COUNT\("?symbols"?\."id\.id"\)/i);
	});
});

// ── SC-05: count(*) unchanged ─────────────────────────────────────────────

describe('SC-05: count(*) unchanged (regression guard)', () => {
	it('count(*) produces COUNT(*)', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{
					type: 'selectFunction',
					function: 'count',
					column: '*',
					alias: 'total',
				} satisfies PlanDecision,
			],
		};

		const { sql } = compile(plan);

		expect(sql).toMatch(/COUNT\(\*\)/i);
		expect(sql).not.toMatch(/COUNT\("?symbols"?\.\*\)/i);
	});
});

// ── SC-06: fn('count', ref('rel.col')) still works (INV-01) ───────────────

describe('SC-06: fn("count", ref("rel.col")) still works (invariant)', () => {
	it('fn("count", exprRef("callee_calls.id")) emits count(callee_calls.id)', () => {
		const expr = fn('count', exprRef('callee_calls.id'));
		const intent = (expr as unknown as { intent: CustomFnExpressionIntent })
			.intent;

		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				calleeCallsJoin,
				{
					type: 'selectCustomExpression',
					expressionIntent: intent,
					alias: 'cnt',
				} satisfies PlanDecision,
			],
		};

		const { sql } = compile(plan);

		// The fn() path via compileExpressionIntent always worked — this must not regress
		expect(sql).toMatch(/count\(callee_calls\.id\)/i);
		expect(sql).not.toMatch(/count\("?symbols"?\."callee_calls\.id"\)/i);
	});
});
