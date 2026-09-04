/**
 * AST Helpers tests
 *
 * Tests for factory functions that build PostgreSQL AST nodes.
 */

import { deparseSync } from 'pgsql-deparser';
import { describe, expect, it } from 'vitest';

import {
	andExpr,
	booleanConstNode,
	coalesceExpr,
	columnRef,
	columnRefStar,
	columnTarget,
	countDistinct,
	countStar,
	deleteStmt,
	distinctExpr,
	eqExpr,
	floatNode,
	funcCall,
	gtExpr,
	gteExpr,
	ilikeExpr,
	innerJoin,
	insertStmt,
	integerNode,
	leftJoin,
	likeExpr,
	ltExpr,
	lteExpr,
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
} from '../ast-helpers.js';
import { CamelCaseNamingPlugin } from '../naming-plugin.js';
import { createParamRef } from '../param-ref.js';

describe('Basic Value Nodes', () => {
	it('creates String node', () => {
		const node = stringNode('test');
		expect(node).toEqual({ String: { sval: 'test' } });
	});

	it('creates Integer node', () => {
		const node = integerNode(42);
		expect(node).toEqual({ Integer: { ival: 42 } });
	});

	it('creates Float node', () => {
		const node = floatNode('3.14');
		expect(node).toEqual({ Float: { fval: '3.14' } });
	});

	it('creates Boolean constant node', () => {
		expect(booleanConstNode(true)).toEqual({
			A_Const: { boolval: { boolval: true } },
		});
		expect(booleanConstNode(false)).toEqual({
			A_Const: { boolval: { boolval: false } },
		});
	});

	it('creates NULL constant node', () => {
		const node = nullConstNode();
		expect(node).toEqual({ A_Const: { isnull: true } });
	});
});

describe('Column and Table References', () => {
	it('creates simple ColumnRef', () => {
		const node = columnRef('id');
		expect(node).toHaveProperty('ColumnRef');
		expect(
			(node as { ColumnRef: { fields: unknown[] } }).ColumnRef.fields,
		).toHaveLength(1);
	});

	it('creates ColumnRef with table', () => {
		const node = columnRef('id', 'users');
		expect(
			(node as { ColumnRef: { fields: unknown[] } }).ColumnRef.fields,
		).toHaveLength(2);
	});

	it('creates ColumnRef with schema, table, column', () => {
		const node = columnRef('id', 'users', 'public');
		expect(
			(node as { ColumnRef: { fields: unknown[] } }).ColumnRef.fields,
		).toHaveLength(3);
	});

	it('applies naming plugin to ColumnRef', () => {
		const naming = new CamelCaseNamingPlugin();
		const node = columnRef('createdAt', 'userProfiles', undefined, naming);
		const fields = (
			node as { ColumnRef: { fields: Array<{ String: { sval: string } }> } }
		).ColumnRef.fields;

		expect(fields[0]?.String.sval).toBe('user_profiles');
		expect(fields[1]?.String.sval).toBe('created_at');
	});

	it('creates star ColumnRef', () => {
		const node = columnRefStar();
		expect(node).toHaveProperty('ColumnRef');
		const fields = (node as { ColumnRef: { fields: unknown[] } }).ColumnRef
			.fields;
		expect(fields[0]).toHaveProperty('A_Star');
	});

	it('creates star ColumnRef with table', () => {
		const node = columnRefStar('users');
		const fields = (node as { ColumnRef: { fields: unknown[] } }).ColumnRef
			.fields;
		expect(fields).toHaveLength(2);
		expect(fields[1]).toHaveProperty('A_Star');
	});

	it('creates RangeVar', () => {
		const node = rangeVar('users');
		expect(node).toHaveProperty('RangeVar');
		expect((node as { RangeVar: { relname: string } }).RangeVar.relname).toBe(
			'users',
		);
	});

	it('creates RangeVar with alias and schema', () => {
		const node = rangeVar('users', 'u', 'public');
		const rv = (
			node as {
				RangeVar: {
					relname: string;
					alias?: { aliasname: string };
					schemaname?: string;
				};
			}
		).RangeVar;
		expect(rv.relname).toBe('users');
		expect(rv.alias?.aliasname).toBe('u');
		expect(rv.schemaname).toBe('public');
	});
});

describe('Target List', () => {
	it('creates ResTarget', () => {
		const node = resTarget(columnRef('id'), 'user_id');
		expect(node).toHaveProperty('ResTarget');
		const rt = (node as { ResTarget: { val: unknown; name?: string } })
			.ResTarget;
		expect(rt.name).toBe('user_id');
	});

	it('creates column target', () => {
		const node = columnTarget('id', 'userId', 'users');
		expect(node).toHaveProperty('ResTarget');
	});

	it('creates star target', () => {
		const node = starTarget('users');
		expect(node).toHaveProperty('ResTarget');
	});
});

describe('Binary Expressions', () => {
	it('creates equality expression', () => {
		const node = eqExpr(columnRef('id'), createParamRef(1));
		expect(node).toHaveProperty('A_Expr');
	});

	it('creates not-equal expression', () => {
		const node = neExpr(columnRef('status'), stringNode('deleted'));
		expect(node).toHaveProperty('A_Expr');
	});

	it('creates an IS DISTINCT FROM expression', () => {
		const node = distinctExpr(columnRef('status'), stringNode('deleted'));
		expect(node).toEqual({
			A_Expr: {
				kind: 'AEXPR_DISTINCT',
				name: [{ String: { sval: '=' } }],
				lexpr: columnRef('status'),
				rexpr: stringNode('deleted'),
			},
		});
	});

	it('creates comparison expressions', () => {
		expect(ltExpr(columnRef('age'), integerNode(18))).toHaveProperty('A_Expr');
		expect(lteExpr(columnRef('age'), integerNode(18))).toHaveProperty('A_Expr');
		expect(gtExpr(columnRef('age'), integerNode(18))).toHaveProperty('A_Expr');
		expect(gteExpr(columnRef('age'), integerNode(18))).toHaveProperty('A_Expr');
	});

	it('creates LIKE expression', () => {
		const node = likeExpr(columnRef('name'), stringNode('%test%'));
		expect(node).toHaveProperty('A_Expr');
	});

	it('creates ILIKE expression', () => {
		const node = ilikeExpr(columnRef('name'), stringNode('%test%'));
		expect(node).toHaveProperty('A_Expr');
	});
});

describe('Boolean Expressions', () => {
	it('creates AND expression', () => {
		const node = andExpr(
			eqExpr(columnRef('active'), booleanConstNode(true)),
			gtExpr(columnRef('age'), integerNode(18)),
		);
		expect(node).toHaveProperty('BoolExpr');
	});

	it('creates OR expression', () => {
		const node = orExpr(
			eqExpr(columnRef('role'), stringNode('admin')),
			eqExpr(columnRef('role'), stringNode('super')),
		);
		expect(node).toHaveProperty('BoolExpr');
	});

	it('creates NOT expression', () => {
		const node = notExpr(eqExpr(columnRef('deleted'), booleanConstNode(true)));
		expect(node).toHaveProperty('BoolExpr');
	});
});

describe('Type Casts', () => {
	it('creates simple type cast', () => {
		const node = typeCast(createParamRef(1), 'integer');
		expect(node).toHaveProperty('TypeCast');
	});

	it('creates array type cast', () => {
		const node = typeCast(createParamRef(1), 'int4', true);
		const tc = (node as { TypeCast: { typeName: { arrayBounds?: unknown[] } } })
			.TypeCast;
		expect(tc.typeName.arrayBounds).toBeDefined();
	});
});

describe('Function Calls', () => {
	it('creates simple function call', () => {
		const node = funcCall('lower', [columnRef('name')]);
		expect(node).toHaveProperty('FuncCall');
	});

	it('creates COUNT(*)', () => {
		const node = countStar();
		const fc = (node as { FuncCall: { agg_star?: boolean } }).FuncCall;
		expect(fc.agg_star).toBe(true);
	});

	it('creates COUNT(DISTINCT col)', () => {
		const node = countDistinct(columnRef('category'));
		const fc = (node as { FuncCall: { agg_distinct?: boolean } }).FuncCall;
		expect(fc.agg_distinct).toBe(true);
	});

	it('deparses COALESCE expression', () => {
		const node = selectStmt({
			targetList: [
				resTarget(coalesceExpr([columnRef('nickname'), columnRef('name')])),
			],
		});
		expect(deparseSync(node)).toContain('COALESCE(nickname, name)');
	});
});

describe('Sort/Order By', () => {
	it('creates default sort', () => {
		const node = sortBy(columnRef('id'));
		expect(node).toHaveProperty('SortBy');
	});

	it('creates ASC sort', () => {
		const node = sortBy(columnRef('id'), 'ASC');
		const sb = (node as { SortBy: { sortby_dir: string } }).SortBy;
		expect(sb.sortby_dir).toBe('SORTBY_ASC');
	});

	it('creates DESC sort with NULLS LAST', () => {
		const node = sortBy(columnRef('id'), 'DESC', 'LAST');
		const sb = (
			node as { SortBy: { sortby_dir: string; sortby_nulls: string } }
		).SortBy;
		expect(sb.sortby_dir).toBe('SORTBY_DESC');
		expect(sb.sortby_nulls).toBe('SORTBY_NULLS_LAST');
	});
});

describe('Joins', () => {
	it('creates INNER JOIN', () => {
		const node = innerJoin(
			rangeVar('users', 'u'),
			rangeVar('orders', 'o'),
			eqExpr(columnRef('id', 'u'), columnRef('user_id', 'o')),
		);
		expect(node).toHaveProperty('JoinExpr');
	});

	it('creates LEFT JOIN', () => {
		const node = leftJoin(
			rangeVar('users', 'u'),
			rangeVar('profiles', 'p'),
			eqExpr(columnRef('id', 'u'), columnRef('user_id', 'p')),
		);
		const je = (node as { JoinExpr: { jointype: string } }).JoinExpr;
		expect(je.jointype).toBe('JOIN_LEFT');
	});
});

describe('SELECT Statement', () => {
	it('creates simple SELECT', () => {
		const node = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('users')],
		});
		expect(node).toHaveProperty('SelectStmt');
	});

	it('creates SELECT with WHERE', () => {
		const node = selectStmt({
			targetList: [columnTarget('id'), columnTarget('name')],
			from: [rangeVar('users')],
			where: eqExpr(columnRef('active'), booleanConstNode(true)),
		});

		const sql = deparseSync(node);
		expect(sql.toLowerCase()).toContain('select');
		expect(sql.toLowerCase()).toContain('where');
	});

	it('creates SELECT with ORDER BY and LIMIT', () => {
		const node = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('users')],
			orderBy: [sortBy(columnRef('created_at'), 'DESC')],
			limit: createParamRef(1),
			offset: createParamRef(2),
		});

		const sql = deparseSync(node);
		expect(sql.toLowerCase()).toContain('order by');
		expect(sql).toContain('$1');
		expect(sql).toContain('$2');
	});

	it('creates SELECT with GROUP BY and HAVING', () => {
		const node = selectStmt({
			targetList: [columnTarget('category'), countStar()],
			from: [rangeVar('products')],
			groupBy: [columnRef('category')],
			having: gtExpr(countStar(), integerNode(5)),
		});

		const sql = deparseSync(node);
		expect(sql.toLowerCase()).toContain('group by');
		expect(sql.toLowerCase()).toContain('having');
	});

	it('creates SELECT DISTINCT', () => {
		const node = selectStmt({
			targetList: [columnTarget('category')],
			from: [rangeVar('products')],
			distinct: true,
		});

		const sql = deparseSync(node);
		expect(sql.toLowerCase()).toContain('distinct');
	});
});

describe('INSERT Statement', () => {
	it('creates simple INSERT', () => {
		const node = insertStmt({
			table: 'users',
			columns: ['name', 'email'],
			values: [[stringNode('John'), stringNode('john@example.com')]],
		});

		const sql = deparseSync(node);
		expect(sql.toLowerCase()).toContain('insert into');
		expect(sql.toLowerCase()).toContain('users');
	});

	it('creates INSERT with schema', () => {
		const node = insertStmt({
			table: 'users',
			schema: 'public',
			columns: ['name'],
			values: [[createParamRef(1)]],
		});

		const sql = deparseSync(node);
		expect(sql.toLowerCase()).toContain('public');
		expect(sql).toContain('$1');
	});

	it('applies naming plugin to INSERT', () => {
		const naming = new CamelCaseNamingPlugin();
		const node = insertStmt({
			table: 'userProfiles',
			columns: ['firstName', 'lastName'],
			values: [[createParamRef(1), createParamRef(2)]],
			naming,
		});

		const sql = deparseSync(node);
		expect(sql.toLowerCase()).toContain('user_profiles');
		expect(sql.toLowerCase()).toContain('first_name');
		expect(sql.toLowerCase()).toContain('last_name');
	});

	it('creates INSERT with RETURNING', () => {
		const node = insertStmt({
			table: 'users',
			columns: ['name'],
			values: [[createParamRef(1)]],
			returning: [columnTarget('id'), columnTarget('created_at')],
		});

		const sql = deparseSync(node);
		expect(sql.toLowerCase()).toContain('returning');
	});
});

describe('UPDATE Statement', () => {
	it('creates simple UPDATE', () => {
		const node = updateStmt({
			table: 'users',
			set: [{ column: 'name', value: createParamRef(1) }],
			where: eqExpr(columnRef('id'), createParamRef(2)),
		});

		const sql = deparseSync(node);
		expect(sql.toLowerCase()).toContain('update');
		expect(sql.toLowerCase()).toContain('set');
		expect(sql.toLowerCase()).toContain('where');
	});

	it('applies naming plugin to UPDATE', () => {
		const naming = new CamelCaseNamingPlugin();
		const node = updateStmt({
			table: 'userProfiles',
			set: [{ column: 'updatedAt', value: funcCall('now') }],
			where: eqExpr(columnRef('userId'), createParamRef(1)),
			naming,
		});

		const sql = deparseSync(node);
		expect(sql.toLowerCase()).toContain('user_profiles');
		expect(sql.toLowerCase()).toContain('updated_at');
	});

	it('creates UPDATE with RETURNING', () => {
		const node = updateStmt({
			table: 'users',
			set: [{ column: 'status', value: stringNode('active') }],
			where: eqExpr(columnRef('id'), createParamRef(1)),
			returning: [starTarget()],
		});

		const sql = deparseSync(node);
		expect(sql.toLowerCase()).toContain('returning');
	});
});

describe('DELETE Statement', () => {
	it('creates simple DELETE', () => {
		const node = deleteStmt({
			table: 'sessions',
			where: ltExpr(columnRef('expires_at'), funcCall('now')),
		});

		const sql = deparseSync(node);
		expect(sql.toLowerCase()).toContain('delete from');
		expect(sql.toLowerCase()).toContain('where');
	});

	it('applies naming plugin to DELETE', () => {
		const naming = new CamelCaseNamingPlugin();
		const node = deleteStmt({
			table: 'userSessions',
			where: eqExpr(columnRef('userId'), createParamRef(1)),
			naming,
		});

		const sql = deparseSync(node);
		expect(sql.toLowerCase()).toContain('user_sessions');
	});

	it('creates DELETE with RETURNING', () => {
		const node = deleteStmt({
			table: 'users',
			where: eqExpr(columnRef('id'), createParamRef(1)),
			returning: [columnTarget('id'), columnTarget('email')],
		});

		const sql = deparseSync(node);
		expect(sql.toLowerCase()).toContain('returning');
	});
});

describe('Complex queries with deparse', () => {
	it('deparses SELECT with JOIN', () => {
		const node = selectStmt({
			targetList: [
				columnTarget('name', undefined, 'u'),
				columnTarget('total', undefined, 'o'),
			],
			from: [
				innerJoin(
					rangeVar('users', 'u'),
					rangeVar('orders', 'o'),
					eqExpr(columnRef('id', 'u'), columnRef('user_id', 'o')),
				),
			],
			where: gtExpr(columnRef('total', 'o'), createParamRef(1)),
			orderBy: [sortBy(columnRef('total', 'o'), 'DESC')],
			limit: integerNode(10),
		});

		const sql = deparseSync(node);
		expect(sql.toLowerCase()).toContain('join');
		expect(sql.toLowerCase()).toContain('order by');
		expect(sql).toContain('$1');
	});

	it('deparses complete CRUD operations', () => {
		// INSERT
		const ins = insertStmt({
			table: 'users',
			columns: ['name', 'email'],
			values: [[createParamRef(1), createParamRef(2)]],
			returning: [columnTarget('id')],
		});
		expect(deparseSync(ins).toLowerCase()).toContain('insert');

		// SELECT
		const sel = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('users')],
			where: eqExpr(columnRef('id'), createParamRef(1)),
		});
		expect(deparseSync(sel).toLowerCase()).toContain('select');

		// UPDATE
		const upd = updateStmt({
			table: 'users',
			set: [{ column: 'name', value: createParamRef(1) }],
			where: eqExpr(columnRef('id'), createParamRef(2)),
			returning: [starTarget()],
		});
		expect(deparseSync(upd).toLowerCase()).toContain('update');

		// DELETE
		const del = deleteStmt({
			table: 'users',
			where: eqExpr(columnRef('id'), createParamRef(1)),
		});
		expect(deparseSync(del).toLowerCase()).toContain('delete');
	});
});
