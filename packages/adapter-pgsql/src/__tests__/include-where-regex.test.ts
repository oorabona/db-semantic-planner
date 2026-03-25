/**
 * Regression tests: op() expressions in include({ where }) are compiled.
 *
 * Bug: convertWhereToDecisions() had no `case 'expression'` handler, so
 * op().eq() intents passed to include({ where }) were silently dropped —
 * the regex filter was never emitted in SQL.
 *
 * Fix: added `case 'expression'` to convertWhereToDecisions() in
 * plan-decision-extractor.ts.
 */

import type { PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import type { AdapterCompilerDeps } from '../adapter-compiler-deps.js';
import { compileSelect } from '../adapter-compiler-select.js';
import { DEFAULT_PK_COLUMN, defaultFkDerivation } from '../assert-field.js';
import { normalizeSQL } from '../ast-helpers.js';
import { identityNaming } from '../naming-plugin.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const deps: AdapterCompilerDeps = {
	naming: identityNaming,
	defaultPk: DEFAULT_PK_COLUMN,
	deriveFk: defaultFkDerivation,
};

function compile(plan: PlanReport): {
	sql: string;
	parameters: readonly unknown[];
} {
	return compileSelect(plan, undefined, deps);
}

/**
 * ExpressionIntent for: path ~ $N (regex match)
 * i.e. op('~', ref('path'), param(regex)).eq(true)
 *
 * The include where intent has kind='expression' wrapping a customOp.
 */
function makeRegexWhereIntent(regexValue: string) {
	return {
		kind: 'expression' as const,
		expr: {
			kind: 'customOp' as const,
			operator: '~',
			left: { kind: 'ref' as const, column: 'path' },
			right: { kind: 'param' as const, value: regexValue },
		},
		operator: 'eq' as const,
		value: true,
	};
}

/**
 * Minimal PlanReport: symbols INNER JOIN files ON files.id = symbols.file_id
 * with a regex filter on files.path in the include where.
 */
function makePlanWithRegexIncludeWhere(
	options: { regexValue?: string; extraAndCondition?: boolean } = {},
): PlanReport {
	const { regexValue = '^src/', extraAndCondition = false } = options;

	const whereIntent = extraAndCondition
		? {
				kind: 'and' as const,
				conditions: [
					{
						kind: 'comparison' as const,
						field: 'project_id',
						operator: 'eq',
						value: 1,
					},
					makeRegexWhereIntent(regexValue),
				],
			}
		: makeRegexWhereIntent(regexValue);

	return {
		rootTable: 'symbols',
		intent: {
			type: 'select',
			from: 'symbols',
			select: { type: 'fields', fields: ['id'] },
			include: [
				{
					relation: 'file',
					join: 'inner',
					where: whereIntent,
				},
			],
		},
		decisions: [
			{
				id: 'D1',
				type: 'include-strategy',
				choice: 'join',
				joinType: 'inner',
				context: {
					sourceTable: 'symbols',
					target: 'files',
					relation: 'file',
					relationType: 'belongsTo',
					intentPath: 'include[0]',
				},
				reasoning: 'explicit join:inner',
				alternatives: [],
			},
		],
		warnings: [],
		rootTableAlias: undefined,
		schemaName: undefined,
	} as unknown as PlanReport;
}

/**
 * Minimal PlanReport: top-level .where(op().eq()) on files table.
 * Regression guard — this path must keep working after the fix.
 * Uses the intent.where field (same path as ORM .where()) so
 * convertWhereCondition handles the expression kind.
 */
function makePlanWithTopLevelRegexWhere(regexValue = '^src/'): PlanReport {
	return {
		rootTable: 'files',
		intent: {
			type: 'select',
			from: 'files',
			select: { type: 'fields', fields: ['id', 'path'] },
			where: makeRegexWhereIntent(regexValue),
		},
		decisions: [],
		warnings: [],
		rootTableAlias: undefined,
		schemaName: undefined,
	} as unknown as PlanReport;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('include({ where: op().eq() }) — custom expression WHERE is compiled', () => {
	it('regex op in include where produces ~ operator in SQL', () => {
		const result = compile(makePlanWithRegexIncludeWhere());
		const sql = normalizeSQL(result.sql);

		// The regex operator must appear in the output SQL
		expect(sql).toMatch(/~/);
		// Must have a JOIN (INNER, not LEFT)
		expect(sql).toMatch(/\bjoin\b/i);
		expect(sql).not.toMatch(/left\s+join/i);
		// The WHERE clause must be present (expression became a condition)
		expect(sql).toMatch(/\bwhere\b/i);
		// The regex pattern must be bound as a parameter
		expect(result.parameters).toContain('^src/');
	});

	it('regex value is bound as a parameter, not inlined as a literal', () => {
		const result = compile(
			makePlanWithRegexIncludeWhere({ regexValue: '^lib/' }),
		);

		expect(result.parameters).toContain('^lib/');
	});

	it('AND(eq + regex) in include where: both conditions appear in SQL', () => {
		const result = compile(
			makePlanWithRegexIncludeWhere({ extraAndCondition: true }),
		);
		const sql = normalizeSQL(result.sql);

		// Both conditions must be present
		expect(sql).toMatch(/project_id/i);
		expect(sql).toMatch(/~/);
		// Parameters contain both values
		expect(result.parameters).toContain(1);
		expect(result.parameters).toContain('^src/');
	});

	it('AND condition produces WHERE with AND keyword', () => {
		const result = compile(
			makePlanWithRegexIncludeWhere({ extraAndCondition: true }),
		);
		const sql = normalizeSQL(result.sql);

		expect(sql).toMatch(/\bwhere\b/i);
		expect(sql).toMatch(/\band\b/i);
	});

	it('regression: top-level .where(op().eq()) still works', () => {
		const result = compile(makePlanWithTopLevelRegexWhere('^src/'));
		const sql = normalizeSQL(result.sql);

		expect(sql).toMatch(/~/);
		expect(sql).toMatch(/\bwhere\b/i);
		expect(result.parameters).toContain('^src/');
	});
});
