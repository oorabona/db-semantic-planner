
/**
 * @module groupby-relation.test
 * Regression tests for GROUP BY with relation (JOIN) columns.
 *
 * Issue: groupBy(['id', 'file.path']) with include('file', { join: 'inner' })
 * was producing GROUP BY "symbols"."file.path" (wrong — treats dotted name as
 * a single column in the root table) instead of GROUP BY "file"."path" (correct).
 *
 * Fix: the 'groupBy' case in compileSelect now splits dotted column names on '.'
 * the same way the 'ref' handler in compileExpressionIntent does.
 */

import { describe, expect, it } from 'vitest';
import {
	compilePlan,
	type PlanDecision,
	type SimplifiedPlanReport,
} from '../compiler.js';

function compileToSql(plan: SimplifiedPlanReport): {
	sql: string;
	parameters: readonly unknown[];
} {
	return compilePlan(plan);
}

describe('GROUP BY with relation (JOIN) columns', () => {
	it('groupBy dotted column produces table-qualified ref, not root-table-qualified', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{ type: 'select', column: 'id', table: 'symbols' },
				{
					type: 'includeStrategy',
					choice: 'join',
					joinType: 'inner',
					relationName: 'file',
					targetTable: 'files',
					relationType: 'belongsTo',
					foreignKey: 'file_id',
					parentKey: 'id',
					columns: ['path'],
				} satisfies PlanDecision,
				{ type: 'groupBy', column: 'id', table: 'symbols' },
				{ type: 'groupBy', column: 'file.path', table: 'symbols' },
			],
		};

		const { sql } = compileToSql(plan);

		// GROUP BY clause must be present
		expect(sql).toContain('GROUP BY');
		// Root column: qualified with root table (deparser emits unquoted lowercase)
		expect(sql).toMatch(/symbols\.id/);
		// Join relation column in GROUP BY: must use the relation alias, not root table
		// The dot-split fix produces columnRef('path', 'file') → "file".path or file.path
		expect(sql).toMatch(/GROUP BY.*symbols\.id.*file\.path|GROUP BY.*file\.path/);
		// Must NOT produce the wrong form where "file.path" appears as a column of symbols
		expect(sql).not.toMatch(/symbols\."file\.path"/);
		expect(sql).not.toMatch(/"symbols"\."file\.path"/);
	});

	it('groupBy non-dotted column still qualifies with root table', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{ type: 'select', column: '*', table: 'symbols' },
				{ type: 'groupBy', column: 'id', table: 'symbols' },
			],
		};

		const { sql } = compileToSql(plan);

		expect(sql).toContain('GROUP BY');
		expect(sql).toMatch(/GROUP BY.*symbols\.id/);
	});

	it('groupBy multiple dotted columns each resolve to correct table alias', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{ type: 'select', column: 'id', table: 'symbols' },
				{
					type: 'includeStrategy',
					choice: 'join',
					joinType: 'inner',
					relationName: 'callerFile',
					targetTable: 'files',
					relationType: 'belongsTo',
					foreignKey: 'caller_file_id',
					parentKey: 'id',
					columns: ['path', 'name'],
				} satisfies PlanDecision,
				{ type: 'groupBy', column: 'id', table: 'symbols' },
				{ type: 'groupBy', column: 'callerFile.path', table: 'symbols' },
				{ type: 'groupBy', column: 'callerFile.name', table: 'symbols' },
			],
		};

		const { sql } = compileToSql(plan);

		// GROUP BY clause must be present
		expect(sql).toContain('GROUP BY');
		// Root column qualified with root table (deparser: unquoted lowercase)
		expect(sql).toMatch(/symbols\.id/);
		// Relation columns resolved to the join alias — "callerFile" is quoted (has uppercase)
		// The fix produces columnRef('path', 'callerFile') → "callerFile".path
		expect(sql).toContain('"callerFile".path');
		expect(sql).toContain('"callerFile".name');
		// Wrong form must be absent (symbols should NOT own these dotted columns)
		expect(sql).not.toMatch(/symbols\."callerFile\.path"/);
		expect(sql).not.toMatch(/symbols\."callerFile\.name"/);
	});
});
