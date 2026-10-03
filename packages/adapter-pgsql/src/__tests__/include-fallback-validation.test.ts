import { POSTGRESQL_CAPABILITIES, plan, ref, schema } from '@dbsp/core';
import type { IncludeIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compileSelect } from '../adapter-compiler-select.js';
import { DEFAULT_PK_COLUMN, defaultFkDerivation } from '../assert-field.js';
import { createDeclaredNameResolver } from '../declared-name-resolver.js';
import { createPgPhysicalModel } from '../physical-model/index.js';
import { synthesizeMissingJoinDecisions } from '../plan-decision-extractor.js';

const model = schema({
	variable_defs: {
		id: { type: 'integer', primaryKey: true },
		enclosing_symbol_id: ref('symbols', { as: 'enclosing_symbol' }),
	},
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		file_id: ref('files', { as: 'source_file' }),
	},
	files: { id: { type: 'integer', primaryKey: true } },
}).model;

function planned(extra: Partial<IncludeIntent> = {}) {
	return plan(
		{
			type: 'select',
			from: 'variable_defs',
			include: [{ relation: 'enclosingSymbol', join: 'left', ...extra }],
		},
		model,
		{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
	);
}

describe('#911 fallback includes are planned and validated', () => {
	for (const [extra, message] of [
		[
			{ select: { type: 'fields', fields: ['*', 'name'] } },
			"Include enclosingSymbol select cannot mix '*' with other fields",
		],
		[
			{ limit: 2 },
			"Invalid include: Include include[0](enclosingSymbol) limit is not supported by 'join' strategy. Remove the explicit join or use a strategy that limits per parent (json_agg, lateral).",
		],
		[
			{ orderBy: [{ field: 'name', direction: 'asc' }] },
			"Invalid include: Include include[0](enclosingSymbol) orderBy is not supported by 'join' strategy.",
		],
		[
			{ select: { type: 'expressions', columns: [] } },
			"Invalid include: Include include[0](enclosingSymbol) select is not supported by 'join' strategy. Received select form: expressions.",
		],
		[
			{ select: { type: 'fields' } },
			'Include enclosingSymbol select fields must be an array',
		],
		[
			{ include: [{ relation: 'sourceFile', join: 'left', limit: 1 }] },
			"Invalid include: Include include[0].include[0](enclosingSymbol.sourceFile) limit is not supported by 'join' strategy. Remove the explicit join or use a strategy that limits per parent (json_agg, lateral).",
		],
		[
			{
				relation: 'display',
				via: 'enclosingSymbol',
				select: { type: 'fields', fields: ['*', 'name'] },
			},
			"Include enclosingSymbol select cannot mix '*' with other fields",
		],
		[
			{
				via: 'enclosingSymbol',
				include: [
					{
						relation: 'displayFile',
						via: 'sourceFile',
						select: { type: 'fields' },
					},
				],
			},
			'Include enclosingSymbol.sourceFile select fields must be an array',
		],
	] as const) {
		it(`refuses ${JSON.stringify(extra)} during planning`, () => {
			expect.assertions(1);
			try {
				planned(extra as unknown as Partial<IncludeIntent>);
			} catch (error) {
				expect(error).toHaveProperty('message', message);
			}
		});
	}
	it('plans both camelCase hops, compiles their joins, and needs no synthesis', () => {
		const report = planned({
			select: { type: 'fields', fields: ['name'] },
			include: [{ relation: 'sourceFile', join: 'left' }],
		});
		expect(
			report.decisions
				.filter((d) => d.type === 'include-strategy')
				.map((d) => [d.context.relation, d.context.intentPath, d.choice]),
		).toEqual([
			['enclosing_symbol', 'include[0]', 'join'],
			['source_file', 'include[0].include[0]', 'join'],
		]);
		expect(synthesizeMissingJoinDecisions(report, new Set(), model)).toEqual(
			[],
		);
		const { sql } = compileSelect(report, undefined, {
			model,
			declaredNames: createDeclaredNameResolver(
				createPgPhysicalModel({
					mode: 'logical',
					model,
					schema: 'public',
					dbCasing: 'preserve',
				}),
			),
			schemaName: undefined,
			defaultPk: DEFAULT_PK_COLUMN,
			deriveFk: defaultFkDerivation,
		});
		expect(sql).toContain('LEFT JOIN symbols');
		expect(sql).toContain('LEFT JOIN files');
		expect(sql.match(/LEFT JOIN symbols/g)).toHaveLength(1);
	});
});
