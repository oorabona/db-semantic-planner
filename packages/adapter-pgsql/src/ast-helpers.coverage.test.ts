// @ts-nocheck — coverage test: runtime assertions on AST nodes
import { describe, expect, it } from 'vitest';
import {
	andExpr,
	binaryExpr,
	boolExpr,
	booleanConstNode,
	coalesce,
	coalesceExpr,
	columnRef,
	columnRefStar,
	columnTarget,
	countDistinct,
	countStar,
	deleteStmt,
	eqExpr,
	fkCorrelation,
	floatNode,
	funcCall,
	gtExpr,
	gteExpr,
	ilikeExpr,
	innerJoin,
	insertStmt,
	integerNode,
	joinExpr,
	jsonAggCorrelation,
	jsonAggSubquery,
	leftJoin,
	likeExpr,
	ltExpr,
	lteExpr,
	mapLockToAst,
	neExpr,
	notExpr,
	nullConstNode,
	orExpr,
	rangeVar,
	resTarget,
	selectStmt,
	sortBy,
	starTarget,
	stringNode,
	typeCast,
	updateStmt,
	windowFuncCall,
} from './ast-helpers.js';
import { identityNaming } from './naming-plugin.js';

describe('ast-helpers coverage tests', () => {
	describe('Basic Value Nodes', () => {
		it('integerNode creates Integer node', () => {
			const result = integerNode(42);
			expect(result.Integer).toBeDefined();
			expect(result.Integer.ival).toBe(42);
		});

		it('integerNode handles zero', () => {
			const result = integerNode(0);
			expect(result.Integer.ival).toBe(0);
		});

		it('integerNode handles negative', () => {
			const result = integerNode(-10);
			expect(result.Integer.ival).toBe(-10);
		});

		it('floatNode creates Float node', () => {
			const result = floatNode('3.14');
			expect(result.Float).toBeDefined();
			expect(result.Float.fval).toBe('3.14');
		});

		it('floatNode handles scientific notation', () => {
			const result = floatNode('1.5e-10');
			expect(result.Float.fval).toBe('1.5e-10');
		});

		it('stringNode creates String node', () => {
			const result = stringNode('hello');
			expect(result.String).toBeDefined();
			expect(result.String.sval).toBe('hello');
		});

		it('stringNode handles empty string', () => {
			const result = stringNode('');
			expect(result.String.sval).toBe('');
		});

		it('booleanConstNode creates Boolean node for true', () => {
			const result = booleanConstNode(true);
			expect(result.A_Const).toBeDefined();
			expect(result.A_Const.boolval.boolval).toBe(true);
		});

		it('booleanConstNode creates Boolean node for false', () => {
			const result = booleanConstNode(false);
			expect(result.A_Const.boolval.boolval).toBe(false);
		});

		it('nullConstNode creates NULL constant', () => {
			const result = nullConstNode();
			expect(result.A_Const).toBeDefined();
			expect(result.A_Const.isnull).toBe(true);
		});
	});

	describe('Column and Table References', () => {
		it('columnRef with column only', () => {
			const result = columnRef('name');
			expect(result.ColumnRef).toBeDefined();
			expect(result.ColumnRef.fields).toHaveLength(1);
			expect(result.ColumnRef.fields[0].String.sval).toBe('name');
		});

		it('columnRef with table and column', () => {
			const result = columnRef('name', 'users');
			expect(result.ColumnRef.fields).toHaveLength(2);
			expect(result.ColumnRef.fields[0].String.sval).toBe('users');
			expect(result.ColumnRef.fields[1].String.sval).toBe('name');
		});

		it('columnRef with schema, table, and column', () => {
			const result = columnRef('name', 'users', 'public');
			expect(result.ColumnRef.fields).toHaveLength(3);
			expect(result.ColumnRef.fields[0].String.sval).toBe('public');
			expect(result.ColumnRef.fields[1].String.sval).toBe('users');
			expect(result.ColumnRef.fields[2].String.sval).toBe('name');
		});

		it('columnRef with naming plugin', () => {
			const result = columnRef('name', 'users', undefined, identityNaming);
			expect(result.ColumnRef.fields).toHaveLength(2);
			expect(result.ColumnRef.fields[1].String.sval).toBe('name');
		});

		it('columnRefStar without table', () => {
			const result = columnRefStar();
			expect(result.ColumnRef.fields).toHaveLength(1);
			expect(result.ColumnRef.fields[0].A_Star).toBeDefined();
		});

		it('columnRefStar with table', () => {
			const result = columnRefStar('users');
			expect(result.ColumnRef.fields).toHaveLength(2);
			expect(result.ColumnRef.fields[0].String.sval).toBe('users');
			expect(result.ColumnRef.fields[1].A_Star).toBeDefined();
		});

		it('columnRefStar with naming plugin', () => {
			const result = columnRefStar('users', identityNaming);
			expect(result.ColumnRef.fields[0].String.sval).toBe('users');
		});

		it('rangeVar with table only', () => {
			const result = rangeVar('users');
			expect(result.RangeVar).toBeDefined();
			expect(result.RangeVar.relname).toBe('users');
			expect(result.RangeVar.inh).toBe(true);
			expect(result.RangeVar.schemaname).toBeUndefined();
			expect(result.RangeVar.alias).toBeUndefined();
		});

		it('rangeVar with alias', () => {
			const result = rangeVar('users', 'u');
			expect(result.RangeVar.relname).toBe('users');
			expect(result.RangeVar.alias.aliasname).toBe('u');
		});

		it('rangeVar with schema', () => {
			const result = rangeVar('users', undefined, 'public');
			expect(result.RangeVar.relname).toBe('users');
			expect(result.RangeVar.schemaname).toBe('public');
		});

		it('rangeVar with all parameters', () => {
			const result = rangeVar('users', 'u', 'public', identityNaming);
			expect(result.RangeVar.schemaname).toBe('public');
			expect(result.RangeVar.relname).toBe('users');
			expect(result.RangeVar.alias.aliasname).toBe('u');
		});
	});

	describe('Target List', () => {
		it('resTarget without name', () => {
			const val = integerNode(42);
			const result = resTarget(val);
			expect(result.ResTarget).toBeDefined();
			expect(result.ResTarget.val).toBe(val);
			expect(result.ResTarget.name).toBeUndefined();
		});

		it('resTarget with name', () => {
			const val = integerNode(42);
			const result = resTarget(val, 'answer');
			expect(result.ResTarget.val).toBe(val);
			expect(result.ResTarget.name).toBe('answer');
		});

		it('columnTarget without alias or table', () => {
			const result = columnTarget('name');
			expect(result.ResTarget).toBeDefined();
			expect(result.ResTarget.val.ColumnRef.fields[0].String.sval).toBe('name');
			expect(result.ResTarget.name).toBeUndefined();
		});

		it('columnTarget with alias', () => {
			const result = columnTarget('name', 'fullname');
			expect(result.ResTarget.name).toBe('fullname');
		});

		it('columnTarget with table', () => {
			const result = columnTarget('name', undefined, 'users');
			expect(result.ResTarget.val.ColumnRef.fields[0].String.sval).toBe(
				'users',
			);
		});

		it('starTarget without table', () => {
			const result = starTarget();
			expect(result.ResTarget.val.ColumnRef.fields[0].A_Star).toBeDefined();
		});

		it('starTarget with table', () => {
			const result = starTarget('users');
			expect(result.ResTarget.val.ColumnRef.fields[0].String.sval).toBe(
				'users',
			);
		});
	});

	describe('Type Casts', () => {
		it('typeCast without array', () => {
			const arg = stringNode('42');
			const result = typeCast(arg, 'integer');
			expect(result.TypeCast).toBeDefined();
			expect(result.TypeCast.arg).toBe(arg);
			expect(result.TypeCast.typeName.names[0].String.sval).toBe('integer');
			expect(result.TypeCast.typeName.arrayBounds).toBeUndefined();
		});

		it('typeCast with array', () => {
			const arg = stringNode('{1,2,3}');
			const result = typeCast(arg, 'integer', true);
			expect(result.TypeCast.typeName.names[0].String.sval).toBe('integer');
			expect(result.TypeCast.typeName.arrayBounds).toBeDefined();
			expect(result.TypeCast.typeName.arrayBounds).toHaveLength(1);
		});
	});

	describe('Function Calls', () => {
		it('funcCall with no args', () => {
			const result = funcCall('now');
			expect(result.FuncCall).toBeDefined();
			expect(result.FuncCall.funcname[0].String.sval).toBe('now');
			expect(result.FuncCall.args).toBeUndefined();
		});

		it('funcCall with args', () => {
			const result = funcCall('upper', [stringNode('hello')]);
			expect(result.FuncCall.funcname[0].String.sval).toBe('upper');
			expect(result.FuncCall.args).toHaveLength(1);
		});

		it('funcCall with schema prefix', () => {
			const result = funcCall(['pg_catalog', 'upper'], [stringNode('hello')]);
			expect(result.FuncCall.funcname).toHaveLength(2);
			expect(result.FuncCall.funcname[0].String.sval).toBe('pg_catalog');
			expect(result.FuncCall.funcname[1].String.sval).toBe('upper');
		});

		it('funcCall with distinct', () => {
			const result = funcCall('count', [columnRef('id')], { distinct: true });
			expect(result.FuncCall.agg_distinct).toBe(true);
		});

		it('funcCall with star', () => {
			const result = funcCall('count', [], { star: true });
			expect(result.FuncCall.agg_star).toBe(true);
		});

		it('funcCall with orderBy', () => {
			const orderBy = [sortBy(columnRef('name'), 'ASC')];
			const result = funcCall('string_agg', [columnRef('name')], { orderBy });
			expect(result.FuncCall.agg_order).toBe(orderBy);
		});

		it('funcCall with filter', () => {
			const filter = eqExpr(columnRef('active'), booleanConstNode(true));
			const result = funcCall('count', [columnRef('id')], { filter });
			expect(result.FuncCall.agg_filter).toBe(filter);
		});

		it('countStar shorthand', () => {
			const result = countStar();
			expect(result.FuncCall.funcname[0].String.sval).toBe('count');
			expect(result.FuncCall.agg_star).toBe(true);
		});

		it('countDistinct shorthand', () => {
			const col = columnRef('id');
			const result = countDistinct(col);
			expect(result.FuncCall.funcname[0].String.sval).toBe('count');
			expect(result.FuncCall.args[0]).toBe(col);
			expect(result.FuncCall.agg_distinct).toBe(true);
		});

		it('coalesceExpr with multiple args', () => {
			const result = coalesceExpr([columnRef('email'), stringNode('N/A')]);
			expect(result.CoalesceExpr).toBeDefined();
			expect(result.CoalesceExpr.args).toHaveLength(2);
		});

		it('coalesce function call', () => {
			const result = coalesce(columnRef('email'), stringNode('N/A'));
			expect(result.FuncCall.funcname[0].String.sval).toBe('coalesce');
			expect(result.FuncCall.args).toHaveLength(2);
		});
	});

	describe('Sort/Order By', () => {
		it('sortBy with DEFAULT direction and nulls', () => {
			const expr = columnRef('name');
			const result = sortBy(expr);
			expect(result.SortBy).toBeDefined();
			expect(result.SortBy.node).toBe(expr);
			expect(result.SortBy.sortby_dir).toBe('SORTBY_DEFAULT');
			expect(result.SortBy.sortby_nulls).toBe('SORTBY_NULLS_DEFAULT');
		});

		it('sortBy with ASC', () => {
			const result = sortBy(columnRef('name'), 'ASC');
			expect(result.SortBy.sortby_dir).toBe('SORTBY_ASC');
		});

		it('sortBy with DESC', () => {
			const result = sortBy(columnRef('name'), 'DESC');
			expect(result.SortBy.sortby_dir).toBe('SORTBY_DESC');
		});

		it('sortBy with NULLS FIRST', () => {
			const result = sortBy(columnRef('name'), 'ASC', 'FIRST');
			expect(result.SortBy.sortby_nulls).toBe('SORTBY_NULLS_FIRST');
		});

		it('sortBy with NULLS LAST', () => {
			const result = sortBy(columnRef('name'), 'DESC', 'LAST');
			expect(result.SortBy.sortby_nulls).toBe('SORTBY_NULLS_LAST');
		});
	});

	describe('Boolean Expressions', () => {
		it('boolExpr with AND', () => {
			const args = [eqExpr(columnRef('a'), integerNode(1))];
			const result = boolExpr('AND_EXPR', args);
			expect(result.BoolExpr).toBeDefined();
			expect(result.BoolExpr.boolop).toBe('AND_EXPR');
			expect(result.BoolExpr.args).toBe(args);
		});

		it('andExpr with multiple args', () => {
			const result = andExpr(
				eqExpr(columnRef('a'), integerNode(1)),
				eqExpr(columnRef('b'), integerNode(2)),
			);
			expect(result.BoolExpr.boolop).toBe('AND_EXPR');
			expect(result.BoolExpr.args).toHaveLength(2);
		});

		it('orExpr with multiple args', () => {
			const result = orExpr(
				eqExpr(columnRef('a'), integerNode(1)),
				eqExpr(columnRef('b'), integerNode(2)),
			);
			expect(result.BoolExpr.boolop).toBe('OR_EXPR');
			expect(result.BoolExpr.args).toHaveLength(2);
		});

		it('notExpr with single arg', () => {
			const arg = eqExpr(columnRef('a'), integerNode(1));
			const result = notExpr(arg);
			expect(result.BoolExpr.boolop).toBe('NOT_EXPR');
			expect(result.BoolExpr.args).toHaveLength(1);
			expect(result.BoolExpr.args[0]).toBe(arg);
		});
	});

	describe('Binary Expressions', () => {
		it('eqExpr creates equality', () => {
			const left = columnRef('id');
			const right = integerNode(1);
			const result = eqExpr(left, right);
			expect(result.A_Expr).toBeDefined();
			expect(result.A_Expr.kind).toBe('AEXPR_OP');
			expect(result.A_Expr.name[0].String.sval).toBe('=');
			expect(result.A_Expr.lexpr).toBe(left);
			expect(result.A_Expr.rexpr).toBe(right);
		});

		it('neExpr creates not-equal', () => {
			const result = neExpr(columnRef('id'), integerNode(1));
			expect(result.A_Expr.name[0].String.sval).toBe('<>');
		});

		it('ltExpr creates less-than', () => {
			const result = ltExpr(columnRef('age'), integerNode(18));
			expect(result.A_Expr.name[0].String.sval).toBe('<');
		});

		it('lteExpr creates less-than-or-equal', () => {
			const result = lteExpr(columnRef('age'), integerNode(18));
			expect(result.A_Expr.name[0].String.sval).toBe('<=');
		});

		it('gtExpr creates greater-than', () => {
			const result = gtExpr(columnRef('age'), integerNode(18));
			expect(result.A_Expr.name[0].String.sval).toBe('>');
		});

		it('gteExpr creates greater-than-or-equal', () => {
			const result = gteExpr(columnRef('age'), integerNode(18));
			expect(result.A_Expr.name[0].String.sval).toBe('>=');
		});

		it('likeExpr creates LIKE', () => {
			const result = likeExpr(columnRef('name'), stringNode('%john%'));
			expect(result.A_Expr.kind).toBe('AEXPR_LIKE');
			expect(result.A_Expr.name[0].String.sval).toBe('~~');
		});

		it('ilikeExpr creates ILIKE', () => {
			const result = ilikeExpr(columnRef('name'), stringNode('%john%'));
			expect(result.A_Expr.kind).toBe('AEXPR_ILIKE');
			expect(result.A_Expr.name[0].String.sval).toBe('~~*');
		});

		it('binaryExpr with custom operator', () => {
			const result = binaryExpr('@@', columnRef('doc'), stringNode('search'));
			expect(result.A_Expr.name[0].String.sval).toBe('@@');
		});

		it('fkCorrelation builds correlation expression', () => {
			const result = fkCorrelation(
				'id',
				'users',
				'user_id',
				'posts',
				identityNaming,
			);
			expect(result.A_Expr).toBeDefined();
			expect(result.A_Expr.name[0].String.sval).toBe('=');
		});
	});

	describe('Joins', () => {
		it('joinExpr with INNER JOIN', () => {
			const left = rangeVar('users', 'u');
			const right = rangeVar('posts', 'p');
			const quals = eqExpr(columnRef('id', 'u'), columnRef('user_id', 'p'));
			const result = joinExpr('JOIN_INNER', left, right, quals);
			expect(result.JoinExpr).toBeDefined();
			expect(result.JoinExpr.jointype).toBe('JOIN_INNER');
			expect(result.JoinExpr.larg).toBe(left);
			expect(result.JoinExpr.rarg).toBe(right);
			expect(result.JoinExpr.quals).toBe(quals);
		});

		it('joinExpr without quals', () => {
			const result = joinExpr('JOIN_INNER', rangeVar('a'), rangeVar('b'));
			expect(result.JoinExpr.quals).toBeUndefined();
		});

		it('joinExpr with alias', () => {
			const result = joinExpr(
				'JOIN_LEFT',
				rangeVar('a'),
				rangeVar('b'),
				undefined,
				'joined',
			);
			expect(result.JoinExpr.alias.aliasname).toBe('joined');
		});

		it('innerJoin shorthand', () => {
			const left = rangeVar('users');
			const right = rangeVar('posts');
			const on = eqExpr(columnRef('id'), columnRef('user_id'));
			const result = innerJoin(left, right, on);
			expect(result.JoinExpr.jointype).toBe('JOIN_INNER');
		});

		it('leftJoin shorthand', () => {
			const left = rangeVar('users');
			const right = rangeVar('posts');
			const on = eqExpr(columnRef('id'), columnRef('user_id'));
			const result = leftJoin(left, right, on);
			expect(result.JoinExpr.jointype).toBe('JOIN_LEFT');
		});
	});

	describe('SELECT Statement', () => {
		it('selectStmt with targetList only', () => {
			const targetList = [resTarget(columnRef('id'))];
			const result = selectStmt({ targetList });
			expect(result.SelectStmt).toBeDefined();
			expect(result.SelectStmt.targetList).toBe(targetList);
			expect(result.SelectStmt.fromClause).toBeUndefined();
		});

		it('selectStmt with from clause', () => {
			const from = [rangeVar('users')];
			const result = selectStmt({
				targetList: [resTarget(columnRef('id'))],
				from,
			});
			expect(result.SelectStmt.fromClause).toBe(from);
		});

		it('selectStmt with where clause', () => {
			const where = eqExpr(columnRef('active'), booleanConstNode(true));
			const result = selectStmt({
				targetList: [resTarget(columnRef('id'))],
				where,
			});
			expect(result.SelectStmt.whereClause).toBe(where);
		});

		it('selectStmt with groupBy', () => {
			const groupBy = [columnRef('category')];
			const result = selectStmt({
				targetList: [resTarget(columnRef('category'))],
				groupBy,
			});
			expect(result.SelectStmt.groupClause).toBe(groupBy);
		});

		it('selectStmt with having', () => {
			const having = gtExpr(
				funcCall('count', [columnRef('id')]),
				integerNode(5),
			);
			const result = selectStmt({
				targetList: [resTarget(funcCall('count', [columnRef('id')]))],
				having,
			});
			expect(result.SelectStmt.havingClause).toBe(having);
		});

		it('selectStmt with orderBy', () => {
			const orderBy = [sortBy(columnRef('name'), 'ASC')];
			const result = selectStmt({
				targetList: [resTarget(columnRef('name'))],
				orderBy,
			});
			expect(result.SelectStmt.sortClause).toBe(orderBy);
		});

		it('selectStmt with limit', () => {
			const limit = integerNode(10);
			const result = selectStmt({
				targetList: [resTarget(columnRef('id'))],
				limit,
			});
			expect(result.SelectStmt.limitCount).toBe(limit);
		});

		it('selectStmt with offset', () => {
			const offset = integerNode(20);
			const result = selectStmt({
				targetList: [resTarget(columnRef('id'))],
				offset,
			});
			expect(result.SelectStmt.limitOffset).toBe(offset);
		});

		it('selectStmt with distinct boolean', () => {
			const result = selectStmt({
				targetList: [resTarget(columnRef('id'))],
				distinct: true,
			});
			expect(result.SelectStmt.distinctClause).toEqual([]);
		});

		it('selectStmt with distinct array', () => {
			const distinct = [columnRef('category')];
			const result = selectStmt({
				targetList: [resTarget(columnRef('id'))],
				distinct,
			});
			expect(result.SelectStmt.distinctClause).toBe(distinct);
		});

		it('selectStmt with withClause (CTEs)', () => {
			const ctes = [
				{
					CommonTableExpr: {
						ctename: 'cte',
						ctequery: selectStmt({ targetList: [resTarget(integerNode(1))] }),
					},
				},
			];
			const result = selectStmt({
				targetList: [resTarget(columnRef('id'))],
				withClause: { ctes },
			});
			expect(result.SelectStmt.withClause.ctes).toBe(ctes);
			expect(result.SelectStmt.withClause.recursive).toBe(false);
		});

		it('selectStmt with recursive withClause', () => {
			const ctes = [
				{
					CommonTableExpr: {
						ctename: 'cte',
						ctequery: selectStmt({ targetList: [resTarget(integerNode(1))] }),
					},
				},
			];
			const result = selectStmt({
				targetList: [resTarget(columnRef('id'))],
				withClause: { ctes, recursive: true },
			});
			expect(result.SelectStmt.withClause.recursive).toBe(true);
		});

		it('selectStmt with lockingClause', () => {
			const result = selectStmt({
				targetList: [resTarget(columnRef('id'))],
				lockingClause: {
					strength: 'LCS_FORUPDATE',
					waitPolicy: 'LockWaitSkip',
				},
			});
			expect(result.SelectStmt.lockingClause).toBeDefined();
			expect(result.SelectStmt.lockingClause[0].LockingClause.strength).toBe(
				'LCS_FORUPDATE',
			);
			expect(result.SelectStmt.lockingClause[0].LockingClause.waitPolicy).toBe(
				'LockWaitSkip',
			);
		});

		it('selectStmt with lockingClause and lockedRels', () => {
			const lockedRels = [rangeVar('users')];
			const result = selectStmt({
				targetList: [resTarget(columnRef('id'))],
				lockingClause: {
					strength: 'LCS_FORUPDATE',
					lockedRels,
				},
			});
			expect(result.SelectStmt.lockingClause[0].LockingClause.lockedRels).toBe(
				lockedRels,
			);
		});
	});

	describe('INSERT Statement', () => {
		it('insertStmt with table only', () => {
			const result = insertStmt({ table: 'users' });
			expect(result.InsertStmt).toBeDefined();
			expect(result.InsertStmt.relation.relname).toBe('users');
		});

		it('insertStmt with schema', () => {
			const result = insertStmt({ table: 'users', schema: 'public' });
			expect(result.InsertStmt.relation.schemaname).toBe('public');
		});

		it('insertStmt with columns', () => {
			const result = insertStmt({
				table: 'users',
				columns: ['name', 'email'],
			});
			expect(result.InsertStmt.cols).toHaveLength(2);
			expect(result.InsertStmt.cols[0].ResTarget.name).toBe('name');
			expect(result.InsertStmt.cols[1].ResTarget.name).toBe('email');
		});

		it('insertStmt with values', () => {
			const result = insertStmt({
				table: 'users',
				columns: ['name'],
				values: [[stringNode('Alice')]],
			});
			expect(result.InsertStmt.selectStmt.SelectStmt).toBeDefined();
			expect(result.InsertStmt.selectStmt.SelectStmt.valuesLists).toHaveLength(
				1,
			);
		});

		it('insertStmt with selectQuery', () => {
			const selectQuery = selectStmt({
				targetList: [resTarget(columnRef('name'))],
			});
			const result = insertStmt({
				table: 'users',
				selectQuery,
			});
			expect(result.InsertStmt.selectStmt).toBe(selectQuery);
		});

		it('insertStmt with returning', () => {
			const returning = [resTarget(columnRef('id'))];
			const result = insertStmt({
				table: 'users',
				returning,
			});
			expect(result.InsertStmt.returningList).toBe(returning);
		});

		it('insertStmt with naming plugin', () => {
			const result = insertStmt({
				table: 'users',
				naming: identityNaming,
			});
			expect(result.InsertStmt.relation.relname).toBe('users');
		});
	});

	describe('UPDATE Statement', () => {
		it('updateStmt with basic set', () => {
			const result = updateStmt({
				table: 'users',
				set: [{ column: 'name', value: stringNode('Bob') }],
			});
			expect(result.UpdateStmt).toBeDefined();
			expect(result.UpdateStmt.relation.relname).toBe('users');
			expect(result.UpdateStmt.targetList).toHaveLength(1);
			expect(result.UpdateStmt.targetList[0].ResTarget.name).toBe('name');
		});

		it('updateStmt with schema', () => {
			const result = updateStmt({
				table: 'users',
				schema: 'public',
				set: [{ column: 'name', value: stringNode('Bob') }],
			});
			expect(result.UpdateStmt.relation.schemaname).toBe('public');
		});

		it('updateStmt with where', () => {
			const where = eqExpr(columnRef('id'), integerNode(1));
			const result = updateStmt({
				table: 'users',
				set: [{ column: 'name', value: stringNode('Bob') }],
				where,
			});
			expect(result.UpdateStmt.whereClause).toBe(where);
		});

		it('updateStmt with from', () => {
			const from = [rangeVar('posts')];
			const result = updateStmt({
				table: 'users',
				set: [{ column: 'name', value: stringNode('Bob') }],
				from,
			});
			expect(result.UpdateStmt.fromClause).toBe(from);
		});

		it('updateStmt with returning', () => {
			const returning = [resTarget(columnRef('id'))];
			const result = updateStmt({
				table: 'users',
				set: [{ column: 'name', value: stringNode('Bob') }],
				returning,
			});
			expect(result.UpdateStmt.returningList).toBe(returning);
		});

		it('updateStmt with naming plugin', () => {
			const result = updateStmt({
				table: 'users',
				set: [{ column: 'name', value: stringNode('Bob') }],
				naming: identityNaming,
			});
			expect(result.UpdateStmt.relation.relname).toBe('users');
		});
	});

	describe('DELETE Statement', () => {
		it('deleteStmt with table only', () => {
			const result = deleteStmt({ table: 'users' });
			expect(result.DeleteStmt).toBeDefined();
			expect(result.DeleteStmt.relation.relname).toBe('users');
		});

		it('deleteStmt with schema', () => {
			const result = deleteStmt({ table: 'users', schema: 'public' });
			expect(result.DeleteStmt.relation.schemaname).toBe('public');
		});

		it('deleteStmt with where', () => {
			const where = eqExpr(columnRef('id'), integerNode(1));
			const result = deleteStmt({
				table: 'users',
				where,
			});
			expect(result.DeleteStmt.whereClause).toBe(where);
		});

		it('deleteStmt with using', () => {
			const using = [rangeVar('posts')];
			const result = deleteStmt({
				table: 'users',
				using,
			});
			expect(result.DeleteStmt.usingClause).toBe(using);
		});

		it('deleteStmt with returning', () => {
			const returning = [resTarget(columnRef('id'))];
			const result = deleteStmt({
				table: 'users',
				returning,
			});
			expect(result.DeleteStmt.returningList).toBe(returning);
		});

		it('deleteStmt with naming plugin', () => {
			const result = deleteStmt({
				table: 'users',
				naming: identityNaming,
			});
			expect(result.DeleteStmt.relation.relname).toBe('users');
		});
	});

	describe('Window Functions', () => {
		it('windowFuncCall without partition or order', () => {
			const result = windowFuncCall('row_number', [], {}, identityNaming);
			expect(result.FuncCall).toBeDefined();
			expect(result.FuncCall.funcname[0].String.sval).toBe('row_number');
			expect(result.FuncCall.over).toBeDefined();
			expect(result.FuncCall.over.frameOptions).toBe(1034);
		});

		it('windowFuncCall with partitionBy', () => {
			const result = windowFuncCall(
				'row_number',
				[],
				{ partitionBy: ['category'] },
				identityNaming,
			);
			expect(result.FuncCall.over.partitionClause).toHaveLength(1);
		});

		it('windowFuncCall with orderBy asc', () => {
			const result = windowFuncCall(
				'row_number',
				[],
				{ orderBy: [{ field: 'created_at', direction: 'asc' }] },
				identityNaming,
			);
			expect(result.FuncCall.over.orderClause).toHaveLength(1);
			expect(result.FuncCall.over.orderClause[0].SortBy.sortby_dir).toBe(
				'SORTBY_ASC',
			);
		});

		it('windowFuncCall with orderBy desc', () => {
			const result = windowFuncCall(
				'row_number',
				[],
				{ orderBy: [{ field: 'created_at', direction: 'desc' }] },
				identityNaming,
			);
			expect(result.FuncCall.over.orderClause[0].SortBy.sortby_dir).toBe(
				'SORTBY_DESC',
			);
		});

		it('windowFuncCall with table prefix', () => {
			const result = windowFuncCall(
				'row_number',
				[],
				{ partitionBy: ['category'] },
				identityNaming,
				'products',
			);
			expect(
				result.FuncCall.over.partitionClause[0].ColumnRef.fields[0].String.sval,
			).toBe('products');
		});

		it('windowFuncCall with args', () => {
			const result = windowFuncCall(
				'rank',
				[columnRef('score')],
				{},
				identityNaming,
			);
			expect(result.FuncCall.args).toHaveLength(1);
		});

		it('windowFuncCall for count with agg_star', () => {
			const result = windowFuncCall('count', [], {}, identityNaming);
			expect(result.FuncCall.agg_star).toBe(true);
		});
	});

	describe('JSON Aggregation', () => {
		it('jsonAggSubquery basic', () => {
			const whereExpr = eqExpr(columnRef('user_id'), columnRef('id'));
			const result = jsonAggSubquery('posts', whereExpr, 'posts_json');
			expect(result.ResTarget).toBeDefined();
			expect(result.ResTarget.name).toBe('posts_json');
			expect(result.ResTarget.val.CoalesceExpr).toBeDefined();
		});

		it('jsonAggSubquery with schema', () => {
			const whereExpr = eqExpr(columnRef('user_id'), columnRef('id'));
			const result = jsonAggSubquery(
				'posts',
				whereExpr,
				'posts_json',
				'public',
				identityNaming,
			);
			expect(result.ResTarget.name).toBe('posts_json');
		});

		it('jsonAggSubquery with innerAlias', () => {
			const whereExpr = eqExpr(columnRef('user_id'), columnRef('id'));
			const result = jsonAggSubquery(
				'posts',
				whereExpr,
				'posts_json',
				undefined,
				identityNaming,
				{ innerAlias: '__p__' },
			);
			expect(result.ResTarget.name).toBe('posts_json');
		});

		it('jsonAggSubquery with limit', () => {
			const whereExpr = eqExpr(columnRef('user_id'), columnRef('id'));
			const result = jsonAggSubquery(
				'posts',
				whereExpr,
				'posts_json',
				undefined,
				identityNaming,
				{ limit: 10 },
			);
			expect(result.ResTarget.name).toBe('posts_json');
		});

		it('jsonAggSubquery with column projection', () => {
			const whereExpr = eqExpr(columnRef('user_id'), columnRef('id'));
			const result = jsonAggSubquery(
				'posts',
				whereExpr,
				'posts_json',
				undefined,
				identityNaming,
				{ columns: ['id', 'title'] },
			);
			expect(result.ResTarget.name).toBe('posts_json');
		});

		it('jsonAggSubquery with childNodes', () => {
			const whereExpr = eqExpr(columnRef('user_id'), columnRef('id'));
			const childNode = jsonAggSubquery(
				'comments',
				eqExpr(columnRef('post_id'), columnRef('id')),
				'comments',
			);
			const result = jsonAggSubquery(
				'posts',
				whereExpr,
				'posts_json',
				undefined,
				identityNaming,
				{
					childNodes: [{ key: 'comments', node: childNode }],
				},
			);
			expect(result.ResTarget.name).toBe('posts_json');
		});

		it('jsonAggCorrelation builds correlation', () => {
			const result = jsonAggCorrelation(
				'users',
				'id',
				'__t__',
				'user_id',
				identityNaming,
			);
			expect(result.A_Expr).toBeDefined();
			expect(result.A_Expr.name[0].String.sval).toBe('=');
		});
	});

	describe('Lock Mapping', () => {
		it('mapLockToAst with forUpdate', () => {
			const result = mapLockToAst({
				strength: 'forUpdate',
				waitPolicy: 'block',
			});
			expect(result.strength).toBe('LCS_FORUPDATE');
			expect(result.waitPolicy).toBe('LockWaitBlock');
		});

		it('mapLockToAst with forNoKeyUpdate', () => {
			const result = mapLockToAst({
				strength: 'forNoKeyUpdate',
				waitPolicy: 'block',
			});
			expect(result.strength).toBe('LCS_FORNOKEYUPDATE');
		});

		it('mapLockToAst with forShare', () => {
			const result = mapLockToAst({
				strength: 'forShare',
				waitPolicy: 'block',
			});
			expect(result.strength).toBe('LCS_FORSHARE');
		});

		it('mapLockToAst with forKeyShare', () => {
			const result = mapLockToAst({
				strength: 'forKeyShare',
				waitPolicy: 'block',
			});
			expect(result.strength).toBe('LCS_FORKEYSHARE');
		});

		it('mapLockToAst with skipLocked', () => {
			const result = mapLockToAst({
				strength: 'forUpdate',
				waitPolicy: 'skipLocked',
			});
			expect(result.waitPolicy).toBe('LockWaitSkip');
		});

		it('mapLockToAst with noWait', () => {
			const result = mapLockToAst({
				strength: 'forUpdate',
				waitPolicy: 'noWait',
			});
			expect(result.waitPolicy).toBe('LockWaitError');
		});
	});
});
