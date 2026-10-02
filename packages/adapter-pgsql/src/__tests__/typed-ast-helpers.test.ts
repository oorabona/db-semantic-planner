import { describe, expect, it } from 'vitest';
import {
	sqlColumnRef,
	sqlColumnRefStar,
	sqlDeleteStmt,
	sqlInsertStmt,
	sqlJsonAggCorrelation,
	sqlJsonAggSubquery,
	sqlRangeAlias,
	sqlRangeVar,
	sqlResTarget,
	sqlUpdateStmt,
} from '../ast-helpers.js';
import { queryLocal } from '../sql-identifier.js';

const table = queryLocal('order_lines');
const column = queryLocal('line_total');
const alias = queryLocal('lineAlias');
const schema = queryLocal('tenant_42');

describe('established-identifier AST helpers', () => {
	it('emits column, star, range, target, and alias identifiers verbatim', () => {
		expect(sqlColumnRef(column, alias, schema)).toMatchObject({
			ColumnRef: {
				fields: [
					{ String: { sval: 'tenant_42' } },
					{ String: { sval: 'lineAlias' } },
					{ String: { sval: 'line_total' } },
				],
			},
		});
		expect(sqlColumnRefStar(alias)).toMatchObject({
			ColumnRef: {
				fields: [{ String: { sval: 'lineAlias' } }, { A_Star: {} }],
			},
		});
		expect(sqlRangeAlias(alias)).toEqual({ aliasname: 'lineAlias' });
		expect(sqlRangeVar(table, alias, schema)).toMatchObject({
			RangeVar: {
				relname: 'order_lines',
				schemaname: 'tenant_42',
				alias: { aliasname: 'lineAlias' },
			},
		});
		expect(sqlResTarget(sqlColumnRef(column), alias)).toMatchObject({
			ResTarget: { name: 'lineAlias' },
		});
	});

	it('emits DML targets and column lists verbatim', () => {
		expect(sqlInsertStmt({ table, columns: [column] })).toMatchObject({
			InsertStmt: {
				relation: { relname: 'order_lines' },
				cols: [{ ResTarget: { name: 'line_total' } }],
			},
		});
		expect(
			sqlUpdateStmt({ table, set: [{ column, value: sqlColumnRef(column) }] }),
		).toMatchObject({
			UpdateStmt: {
				relation: { relname: 'order_lines' },
				targetList: [{ ResTarget: { name: 'line_total' } }],
			},
		});
		expect(sqlDeleteStmt({ table })).toMatchObject({
			DeleteStmt: { relation: { relname: 'order_lines' } },
		});
	});

	it('emits JSON aggregate identifiers verbatim', () => {
		const correlation = sqlJsonAggCorrelation(alias, column, table, column);
		expect(correlation).toMatchObject({
			A_Expr: {
				lexpr: {
					ColumnRef: {
						fields: [
							{ String: { sval: 'order_lines' } },
							{ String: { sval: 'line_total' } },
						],
					},
				},
				rexpr: {
					ColumnRef: {
						fields: [
							{ String: { sval: 'lineAlias' } },
							{ String: { sval: 'line_total' } },
						],
					},
				},
			},
		});
		expect(
			sqlJsonAggSubquery(table, correlation, alias, schema, {
				innerAlias: alias,
				columns: [column],
			}),
		).toMatchObject({ ResTarget: { name: 'lineAlias' } });
	});
});
