/**
 * Comparison tests for the internal pgsql-deparser.
 *
 * Each test verifies that our internal deparser produces identical output to
 * pgsql-deparser (deparseSync) for AST nodes the compiler actually emits.
 *
 * pgsql-deparser is the baseline (devDependency); our deparser must match it
 * exactly for all structures that dbsp produces.
 */

import type { Node } from '@pgsql/types';
import { deparseSync } from 'pgsql-deparser';
import { describe, expect, it } from 'vitest';
import {
	andExpr,
	binaryExpr,
	boolExpr,
	booleanConstNode,
	coalesceExpr,
	columnRef,
	columnRefStar,
	deleteStmt,
	distinctExpr,
	eqExpr,
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
	nullConstNode,
	orExpr,
	rangeVar,
	resTarget,
	selectStmt,
	sortBy,
	stringNode,
	typeCast,
	updateStmt,
} from '../ast-helpers.js';
import { createParamRef, createTypeCastParamRef } from '../param-ref.js';
import { deparse } from '../pgsql-deparser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize SQL for comparison: lowercase, collapse whitespace.
 * pgsql-deparser pretty-prints with newlines/indentation; our deparser uses
 * single-line output. Normalized comparison verifies semantic equivalence.
 */
function normalizeSQL(sql: string): string {
	return (
		sql
			.toLowerCase()
			.replace(/\s+/g, ' ')
			// Normalize spaces inside parentheses: ( x, y ) → (x, y)
			.replace(/\(\s+/g, '(')
			.replace(/\s+\)/g, ')')
			.trim()
	);
}

function compare(node: Node): void {
	const internal = deparse(node);
	const baseline = deparseSync(node);
	expect(normalizeSQL(internal)).toBe(normalizeSQL(baseline));
}

// ---------------------------------------------------------------------------
// Leaf nodes
// ---------------------------------------------------------------------------

describe('leaf nodes', () => {
	it('String node (identifier)', () => {
		compare(stringNode('my_table'));
	});

	it('Integer node', () => {
		compare(integerNode(42));
		compare(integerNode(-1));
		compare(integerNode(0));
	});

	it('ParamRef $1', () => {
		compare(createParamRef(1));
		compare(createParamRef(99));
	});

	it('A_Const null', () => {
		compare(nullConstNode());
	});

	it('A_Const boolean', () => {
		compare(booleanConstNode(true));
		compare(booleanConstNode(false));
	});

	it('A_Const integer', () => {
		compare({ A_Const: { ival: { ival: 42 } } });
	});

	it('A_Const string', () => {
		compare({ A_Const: { sval: { sval: 'hello' } } });
		compare({ A_Const: { sval: { sval: "it's a quote" } } });
	});
});

// ---------------------------------------------------------------------------
// ColumnRef
// ---------------------------------------------------------------------------

describe('ColumnRef', () => {
	it('simple column', () => {
		compare(columnRef('id'));
	});

	it('table.column', () => {
		compare(columnRef('id', 'users'));
	});

	it('schema.table.column', () => {
		compare(columnRef('id', 'users', 'public'));
	});

	it('star (table.*)', () => {
		compare(columnRefStar('users'));
	});

	it('plain star (*)', () => {
		compare(columnRefStar());
	});
});

// ---------------------------------------------------------------------------
// RangeVar
// ---------------------------------------------------------------------------

describe('RangeVar', () => {
	it('simple table', () => {
		compare(rangeVar('users'));
	});

	it('table with alias', () => {
		compare(rangeVar('users', 'u'));
	});

	it('schema.table with alias', () => {
		compare(rangeVar('users', 'u', 'public'));
	});
});

// ---------------------------------------------------------------------------
// ResTarget
// ---------------------------------------------------------------------------

describe('ResTarget', () => {
	it('column target with alias', () => {
		compare(resTarget(columnRef('id'), 'user_id'));
	});

	it('column target without alias', () => {
		compare(resTarget(columnRef('name')));
	});
});

// ---------------------------------------------------------------------------
// A_Expr binary operators
// ---------------------------------------------------------------------------

describe('A_Expr binary', () => {
	it('= equality', () => {
		compare(eqExpr(columnRef('id'), createParamRef(1)));
	});

	it('<> not equal', () => {
		compare(neExpr(columnRef('status'), createParamRef(1)));
	});

	it('IS DISTINCT FROM', () => {
		compare(distinctExpr(columnRef('status'), createParamRef(1)));
	});

	it('< less than', () => {
		compare(ltExpr(columnRef('age'), createParamRef(1)));
	});

	it('<= less than or equal', () => {
		compare(lteExpr(columnRef('age'), createParamRef(1)));
	});

	it('> greater than', () => {
		compare(gtExpr(columnRef('age'), createParamRef(1)));
	});

	it('>= greater than or equal', () => {
		compare(gteExpr(columnRef('age'), createParamRef(1)));
	});

	it('LIKE', () => {
		compare(likeExpr(columnRef('name'), createParamRef(1)));
	});

	it('ILIKE', () => {
		compare(ilikeExpr(columnRef('name'), createParamRef(1)));
	});

	it('|| concat operator', () => {
		compare(binaryExpr('||', columnRef('first_name'), columnRef('last_name')));
	});

	it('+ arithmetic', () => {
		compare(binaryExpr('+', columnRef('price'), createParamRef(1)));
	});
});

// ---------------------------------------------------------------------------
// BETWEEN
// ---------------------------------------------------------------------------

describe('BETWEEN', () => {
	it('BETWEEN', () => {
		const node: Node = {
			A_Expr: {
				kind: 'AEXPR_BETWEEN',
				name: [stringNode('BETWEEN')],
				lexpr: columnRef('age'),
				rexpr: { List: { items: [createParamRef(1), createParamRef(2)] } },
			},
		};
		compare(node);
	});
});

// ---------------------------------------------------------------------------
// = ANY / <> ALL
// ---------------------------------------------------------------------------

describe('A_Expr OP ANY/ALL', () => {
	it('= ANY($1)', () => {
		compare({
			A_Expr: {
				kind: 'AEXPR_OP_ANY',
				name: [stringNode('=')],
				lexpr: columnRef('id'),
				rexpr: createParamRef(1),
			},
		});
	});

	it('<> ALL($1)', () => {
		compare({
			A_Expr: {
				kind: 'AEXPR_OP_ALL',
				name: [stringNode('<>')],
				lexpr: columnRef('id'),
				rexpr: createParamRef(1),
			},
		});
	});
});

// ---------------------------------------------------------------------------
// BoolExpr
// ---------------------------------------------------------------------------

describe('BoolExpr', () => {
	it('AND', () => {
		compare(
			boolExpr('AND_EXPR', [
				eqExpr(columnRef('id'), createParamRef(1)),
				eqExpr(columnRef('status'), createParamRef(2)),
			]),
		);
	});

	it('OR', () => {
		compare(
			boolExpr('OR_EXPR', [
				eqExpr(columnRef('a'), createParamRef(1)),
				eqExpr(columnRef('b'), createParamRef(2)),
			]),
		);
	});

	it('NOT', () => {
		compare(
			boolExpr('NOT_EXPR', [
				eqExpr(columnRef('active'), booleanConstNode(true)),
			]),
		);
	});
});

// ---------------------------------------------------------------------------
// NullTest
// ---------------------------------------------------------------------------

describe('NullTest', () => {
	it('IS NULL', () => {
		compare({
			NullTest: {
				arg: columnRef('deleted_at'),
				nulltesttype: 'IS_NULL',
			},
		});
	});

	it('IS NOT NULL', () => {
		compare({
			NullTest: {
				arg: columnRef('email'),
				nulltesttype: 'IS_NOT_NULL',
			},
		});
	});
});

// ---------------------------------------------------------------------------
// TypeCast
// ---------------------------------------------------------------------------

describe('TypeCast', () => {
	it('CAST($1 AS text)', () => {
		const node = typeCast(createParamRef(1), 'text');
		compare(node);
	});

	it('CAST($1 AS integer[])', () => {
		const node = typeCast(createParamRef(1), 'integer', true);
		compare(node);
	});

	it('TypeCastParamRef', () => {
		const node = createTypeCastParamRef(1, 'text');
		compare(node);
	});
});

// ---------------------------------------------------------------------------
// FuncCall
// ---------------------------------------------------------------------------

describe('FuncCall', () => {
	it('count(*)', () => {
		compare({ FuncCall: { funcname: [stringNode('count')], agg_star: true } });
	});

	it('count(DISTINCT id)', () => {
		compare({
			FuncCall: {
				funcname: [stringNode('count')],
				args: [columnRef('id')],
				agg_distinct: true,
			},
		});
	});

	it('json_agg(x)', () => {
		compare(funcCall('json_agg', [columnRef('x')]));
	});

	it('coalesce(a, b)', () => {
		compare(funcCall('coalesce', [columnRef('a'), columnRef('b')]));
	});

	it('to_jsonb(x)', () => {
		compare(funcCall('to_jsonb', [columnRef('x')]));
	});

	it('jsonb_build_object(key, val)', () => {
		compare(
			funcCall('jsonb_build_object', [
				{ A_Const: { sval: { sval: 'id' } } },
				columnRef('id'),
			]),
		);
	});
});

// ---------------------------------------------------------------------------
// CoalesceExpr
// ---------------------------------------------------------------------------

describe('CoalesceExpr', () => {
	it('COALESCE(subquery, empty)', () => {
		compare(
			coalesceExpr([
				{
					SubLink: {
						subLinkType: 'EXPR_SUBLINK',
						subselect: selectStmt({
							targetList: [resTarget(columnRef('id'))],
							from: [rangeVar('users')],
						}),
					},
				},
				typeCast({ A_Const: { sval: { sval: '[]' } } }, 'json'),
			]),
		);
	});
});

// ---------------------------------------------------------------------------
// NullIfExpr
// ---------------------------------------------------------------------------

describe('NullIfExpr', () => {
	it('NULLIF(col, value)', () => {
		compare({
			NullIfExpr: {
				args: [columnRef('score'), { A_Const: { ival: { ival: 0 } } }],
			},
		});
	});

	it('NULLIF(col, string)', () => {
		compare({
			NullIfExpr: {
				args: [columnRef('status'), { A_Const: { sval: { sval: 'deleted' } } }],
			},
		});
	});
});

// ---------------------------------------------------------------------------
// MinMaxExpr
// ---------------------------------------------------------------------------

describe('MinMaxExpr', () => {
	it('GREATEST(a, b)', () => {
		compare({
			MinMaxExpr: {
				op: 'IS_GREATEST',
				args: [columnRef('a'), columnRef('b')],
			},
		});
	});

	it('LEAST(a, b, c)', () => {
		compare({
			MinMaxExpr: {
				op: 'IS_LEAST',
				args: [columnRef('a'), columnRef('b'), columnRef('c')],
			},
		});
	});

	it('GREATEST with param', () => {
		compare({
			MinMaxExpr: {
				op: 'IS_GREATEST',
				args: [columnRef('score'), createParamRef(1)],
			},
		});
	});
});

// ---------------------------------------------------------------------------
// SortBy
// ---------------------------------------------------------------------------

describe('SortBy', () => {
	it('ASC', () => {
		compare(sortBy(columnRef('created_at'), 'ASC'));
	});

	it('DESC', () => {
		compare(sortBy(columnRef('created_at'), 'DESC'));
	});

	it('DESC NULLS LAST', () => {
		compare(sortBy(columnRef('created_at'), 'DESC', 'LAST'));
	});

	it('DEFAULT (no direction)', () => {
		compare(sortBy(columnRef('name'), 'DEFAULT'));
	});
});

// ---------------------------------------------------------------------------
// JoinExpr
// ---------------------------------------------------------------------------

describe('JoinExpr', () => {
	it('INNER JOIN', () => {
		compare(
			innerJoin(
				rangeVar('users', 'u'),
				rangeVar('orders', 'o'),
				eqExpr(columnRef('id', 'u'), columnRef('user_id', 'o')),
			),
		);
	});

	it('LEFT JOIN', () => {
		compare(
			leftJoin(
				rangeVar('posts', 'p'),
				rangeVar('authors', 'a'),
				eqExpr(columnRef('author_id', 'p'), columnRef('id', 'a')),
			),
		);
	});
});

// ---------------------------------------------------------------------------
// SubLink
// ---------------------------------------------------------------------------

describe('SubLink', () => {
	it('EXPR_SUBLINK (scalar)', () => {
		compare({
			SubLink: {
				subLinkType: 'EXPR_SUBLINK',
				subselect: selectStmt({
					targetList: [resTarget(columnRef('count'), undefined)],
					from: [rangeVar('orders', 'o')],
					where: eqExpr(columnRef('user_id', 'o'), columnRef('id', 'u')),
				}),
			},
		});
	});

	it('EXISTS_SUBLINK', () => {
		compare({
			SubLink: {
				subLinkType: 'EXISTS_SUBLINK',
				subselect: selectStmt({
					targetList: [resTarget({ A_Const: { ival: { ival: 1 } } })],
					from: [rangeVar('orders', 'o')],
					where: eqExpr(columnRef('user_id', 'o'), columnRef('id', 'u')),
				}),
			},
		});
	});

	it('ANY_SUBLINK', () => {
		const subquery = selectStmt({
			targetList: [resTarget(columnRef('id'))],
			from: [rangeVar('active_users')],
		});
		compare({
			SubLink: {
				subLinkType: 'ANY_SUBLINK',
				testexpr: columnRef('user_id'),
				operName: [stringNode('=')],
				subselect: subquery,
			},
		});
	});
});

// ---------------------------------------------------------------------------
// SelectStmt
// ---------------------------------------------------------------------------

describe('SelectStmt', () => {
	it('simple SELECT', () => {
		compare(
			selectStmt({
				targetList: [resTarget(columnRefStar(), undefined)],
				from: [rangeVar('users')],
			}),
		);
	});

	it('SELECT with WHERE', () => {
		compare(
			selectStmt({
				targetList: [resTarget(columnRef('id')), resTarget(columnRef('name'))],
				from: [rangeVar('users', 'u')],
				where: eqExpr(columnRef('active', 'u'), booleanConstNode(true)),
			}),
		);
	});

	it('SELECT with ORDER BY and LIMIT', () => {
		compare(
			selectStmt({
				targetList: [resTarget(columnRefStar())],
				from: [rangeVar('posts')],
				orderBy: [sortBy(columnRef('created_at'), 'DESC')],
				limit: integerNode(10),
				offset: integerNode(20),
			}),
		);
	});

	it('SELECT with GROUP BY and HAVING', () => {
		compare(
			selectStmt({
				targetList: [
					resTarget(columnRef('category')),
					resTarget(funcCall('count', [], { star: true }), 'total'),
				],
				from: [rangeVar('products')],
				groupBy: [columnRef('category')],
				having: gtExpr(funcCall('count', [], { star: true }), integerNode(5)),
			}),
		);
	});

	it('SELECT DISTINCT', () => {
		compare(
			selectStmt({
				targetList: [resTarget(columnRef('status'))],
				from: [rangeVar('orders')],
				distinct: true,
			}),
		);
	});

	it('UNION ALL', () => {
		const s1 = selectStmt({
			targetList: [resTarget(columnRef('id'))],
			from: [rangeVar('users')],
		});
		const s2 = selectStmt({
			targetList: [resTarget(columnRef('id'))],
			from: [rangeVar('admins')],
		});
		if (!('SelectStmt' in s1) || !('SelectStmt' in s2)) {
			throw new Error('expected SELECT AST nodes');
		}
		compare({
			SelectStmt: {
				op: 'SETOP_UNION',
				all: true,
				larg: s1.SelectStmt,
				rarg: s2.SelectStmt,
			},
		});
	});
});

// ---------------------------------------------------------------------------
// InsertStmt
// ---------------------------------------------------------------------------

describe('InsertStmt', () => {
	it('INSERT INTO ... VALUES', () => {
		compare(
			insertStmt({
				table: 'users',
				columns: ['name', 'email'],
				values: [[createParamRef(1), createParamRef(2)]],
			}),
		);
	});

	it('INSERT with RETURNING', () => {
		compare(
			insertStmt({
				table: 'users',
				columns: ['name'],
				values: [[createParamRef(1)]],
				returning: [resTarget(columnRef('id'))],
			}),
		);
	});
});

// ---------------------------------------------------------------------------
// UpdateStmt
// ---------------------------------------------------------------------------

describe('UpdateStmt', () => {
	it('UPDATE SET ... WHERE', () => {
		compare(
			updateStmt({
				table: 'users',
				set: [{ column: 'name', value: createParamRef(1) }],
				where: eqExpr(columnRef('id'), createParamRef(2)),
			}),
		);
	});
});

// ---------------------------------------------------------------------------
// DeleteStmt
// ---------------------------------------------------------------------------

describe('DeleteStmt', () => {
	it('DELETE FROM ... WHERE', () => {
		compare(
			deleteStmt({
				table: 'users',
				where: eqExpr(columnRef('id'), createParamRef(1)),
			}),
		);
	});

	it('DELETE with RETURNING', () => {
		compare(
			deleteStmt({
				table: 'users',
				where: eqExpr(columnRef('id'), createParamRef(1)),
				returning: [resTarget(columnRefStar())],
			}),
		);
	});
});

// ---------------------------------------------------------------------------
// WindowDef / FuncCall with OVER
// ---------------------------------------------------------------------------

describe('Window functions', () => {
	it('ROW_NUMBER() OVER (PARTITION BY x ORDER BY y)', () => {
		const node: Node = {
			FuncCall: {
				funcname: [stringNode('row_number')],
				over: {
					partitionClause: [columnRef('status')],
					orderClause: [sortBy(columnRef('created_at'), 'DESC')],
					frameOptions: 1034,
				},
			},
		};
		compare(node);
	});
});

// ---------------------------------------------------------------------------
// CaseExpr
// ---------------------------------------------------------------------------

describe('CaseExpr', () => {
	it('CASE WHEN ... THEN ... ELSE ... END', () => {
		compare({
			CaseExpr: {
				args: [
					{
						CaseWhen: {
							expr: eqExpr(columnRef('status'), {
								A_Const: { sval: { sval: 'active' } },
							}),
							result: { A_Const: { ival: { ival: 1 } } },
						},
					},
				],
				defresult: { A_Const: { ival: { ival: 0 } } },
			},
		});
	});
});

// ---------------------------------------------------------------------------
// ARRAY[]
// ---------------------------------------------------------------------------

describe('A_ArrayExpr', () => {
	it('ARRAY[pk]', () => {
		compare({
			A_ArrayExpr: {
				elements: [columnRef('id', 'u')],
			},
		});
	});

	it('ARRAY[a, b]', () => {
		compare({
			A_ArrayExpr: {
				elements: [createParamRef(1), createParamRef(2)],
			},
		});
	});
});

// ---------------------------------------------------------------------------
// WITH RECURSIVE CTE
// ---------------------------------------------------------------------------

describe('CTE / WITH clause', () => {
	it('simple WITH clause', () => {
		const innerSelect = selectStmt({
			targetList: [resTarget(columnRefStar())],
			from: [rangeVar('orders')],
		});
		const node: Node = {
			SelectStmt: {
				withClause: {
					ctes: [
						{
							CommonTableExpr: {
								ctename: 'active_orders',
								ctequery: innerSelect,
							},
						},
					],
					recursive: false,
				},
				targetList: [resTarget(columnRefStar())],
				fromClause: [rangeVar('active_orders')],
			},
		};
		compare(node);
	});
});

// ---------------------------------------------------------------------------
// ON CONFLICT (UPSERT)
// ---------------------------------------------------------------------------

describe('OnConflictClause', () => {
	it('ON CONFLICT DO NOTHING', () => {
		const node: Node = insertStmt({
			table: 'users',
			columns: ['email'],
			values: [[createParamRef(1)]],
		});
		// Manually attach onConflict
		const insertInner = (node as Record<string, unknown>).InsertStmt as Record<
			string,
			unknown
		>;
		insertInner.onConflictClause = {
			action: 'ONCONFLICT_NOTHING',
		};
		compare(node);
	});

	it('ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name', () => {
		const node: Node = insertStmt({
			table: 'users',
			columns: ['id', 'name'],
			values: [[createParamRef(1), createParamRef(2)]],
		});
		const insertInner = (node as Record<string, unknown>).InsertStmt as Record<
			string,
			unknown
		>;
		insertInner.onConflictClause = {
			action: 'ONCONFLICT_UPDATE',
			infer: {
				indexElems: [{ IndexElem: { name: 'id' } }],
			},
			targetList: [
				{
					ResTarget: {
						name: 'name',
						val: {
							ColumnRef: {
								fields: [stringNode('excluded'), stringNode('name')],
							},
						},
					},
				},
			],
		};
		compare(node);
	});
});

// ---------------------------------------------------------------------------
// LockingClause (FOR UPDATE)
// ---------------------------------------------------------------------------

describe('LockingClause', () => {
	it('FOR UPDATE', () => {
		compare(
			selectStmt({
				targetList: [resTarget(columnRefStar())],
				from: [rangeVar('users')],
				lockingClause: {
					strength: 'LCS_FORUPDATE',
					waitPolicy: 'LockWaitBlock',
				},
			}),
		);
	});

	it('FOR SHARE SKIP LOCKED', () => {
		compare(
			selectStmt({
				targetList: [resTarget(columnRefStar())],
				from: [rangeVar('tasks')],
				lockingClause: {
					strength: 'LCS_FORSHARE',
					waitPolicy: 'LockWaitSkip',
				},
			}),
		);
	});
});

// ---------------------------------------------------------------------------
// NamedArgExpr
// ---------------------------------------------------------------------------

describe('NamedArgExpr', () => {
	it('deparses named arg with string literal value', () => {
		const node: Node = {
			NamedArgExpr: {
				arg: { A_Const: { sval: { sval: 'name_searchable' } } },
				name: 'field',
				argnumber: -1,
			},
		} as unknown as Node;
		const result = deparse(node);
		expect(result).toBe("field => 'name_searchable'");
	});

	it('deparses named arg with param ref value', () => {
		const node: Node = {
			NamedArgExpr: {
				arg: { ParamRef: { number: 1, location: -1 } },
				name: 'query_string',
				argnumber: -1,
			},
		} as unknown as Node;
		const result = deparse(node);
		expect(result).toBe('query_string => $1');
	});

	it('deparses named arg with integer literal value', () => {
		const node: Node = {
			NamedArgExpr: {
				arg: integerNode(42),
				name: 'limit',
				argnumber: -1,
			},
		} as unknown as Node;
		const result = deparse(node);
		expect(result).toBe('limit => 42');
	});

	it('deparses named arg inside a function call', () => {
		const node: Node = funcCall(
			['paradedb', 'parse'],
			[
				{
					NamedArgExpr: {
						arg: { A_Const: { sval: { sval: 'name' } } },
						name: 'field',
						argnumber: -1,
					},
				} as unknown as Node,
				{
					NamedArgExpr: {
						arg: { ParamRef: { number: 1, location: -1 } },
						name: 'query_string',
						argnumber: -1,
					},
				} as unknown as Node,
			],
		);
		const result = deparse(node);
		expect(result).toContain("field => 'name'");
		expect(result).toContain('query_string => $1');
		expect(result).toContain('paradedb.parse');
	});
});

// ---------------------------------------------------------------------------
// Operator precedence: OR inside AND must be parenthesized
// ---------------------------------------------------------------------------

describe('BoolExpr operator precedence', () => {
	it('OR child of AND is parenthesized', () => {
		// (a = $1 OR b = $2) AND c = $3
		const orNode = orExpr(
			eqExpr(columnRef('a'), createParamRef(1)),
			eqExpr(columnRef('b'), createParamRef(2)),
		);
		const andNode = andExpr(orNode, eqExpr(columnRef('c'), createParamRef(3)));

		const result = deparse(andNode);

		// The OR clause must be wrapped in parens to preserve precedence
		expect(result).toMatch(/^\(.*\) AND/);
		expect(result).toContain('(a = $1 OR b = $2)');
		expect(result).toContain('AND c = $3');
	});

	it('plain AND without OR children needs no extra parens', () => {
		const andNode = andExpr(
			eqExpr(columnRef('a'), createParamRef(1)),
			eqExpr(columnRef('b'), createParamRef(2)),
		);
		const result = deparse(andNode);
		expect(result).toBe('a = $1 AND b = $2');
	});

	it('plain OR needs no parens', () => {
		const orNode = orExpr(
			eqExpr(columnRef('a'), createParamRef(1)),
			eqExpr(columnRef('b'), createParamRef(2)),
		);
		const result = deparse(orNode);
		expect(result).toBe('a = $1 OR b = $2');
	});

	it('AND child of OR does not need extra parens (AND binds tighter)', () => {
		// a = $1 AND b = $2 is already correct when child of OR — no extra parens needed
		const andChild = andExpr(
			eqExpr(columnRef('a'), createParamRef(1)),
			eqExpr(columnRef('b'), createParamRef(2)),
		);
		const orNode = orExpr(andChild, eqExpr(columnRef('c'), createParamRef(3)));
		const result = deparse(orNode);
		// AND child of OR must NOT be wrapped in extra parens (AND already binds tighter)
		expect(result).toBe('a = $1 AND b = $2 OR c = $3');
	});
});

// ---------------------------------------------------------------------------
// M-3: Oracle round-trip tests for FetchStmt, DeclareCursorStmt, InferClause.whereClause
// ---------------------------------------------------------------------------

describe('FetchStmt', () => {
	// Note: deparseSync omits the optional FROM keyword; our internal deparser
	// emits it for clarity (both are valid SQL). These tests verify our deparser
	// produces correct SQL for all directional variants.
	it('FETCH FORWARD ALL FROM cursor', () => {
		// 9223372036854776000 is the float64 representation of LONG_MAX used as the "ALL" sentinel.
		// The deparser emits the cursor name unquoted when it is a simple lowercase identifier.
		const node: Node = {
			FetchStmt: {
				direction: 'FETCH_FORWARD',
				howMany: 9223372036854776000,
				portalname: 'c',
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('FETCH FORWARD ALL FROM c');
	});

	it('FETCH BACKWARD ALL FROM cursor', () => {
		const node: Node = {
			FetchStmt: {
				direction: 'FETCH_BACKWARD',
				howMany: 9223372036854776000,
				portalname: 'c',
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('FETCH BACKWARD ALL FROM c');
	});

	it('FETCH FORWARD 5 FROM cursor', () => {
		const node: Node = {
			FetchStmt: {
				direction: 'FETCH_FORWARD',
				howMany: 5,
				portalname: 'c',
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('FETCH FORWARD 5 FROM c');
	});
});

describe('DeclareCursorStmt', () => {
	it('DECLARE c CURSOR FOR SELECT 1', () => {
		const node: Node = {
			DeclareCursorStmt: {
				portalname: 'c',
				options: 0,
				query: selectStmt({
					targetList: [resTarget(integerNode(1))],
				}),
			},
		} as unknown as Node;
		compare(node);
	});
});

describe('InferClause with whereClause', () => {
	it('ON CONFLICT (a) WHERE a > 0 DO NOTHING', () => {
		const node: Node = insertStmt({
			table: 't',
			columns: ['a'],
			values: [[integerNode(1)]],
		});
		const insertInner = (node as Record<string, unknown>).InsertStmt as Record<
			string,
			unknown
		>;
		insertInner.onConflictClause = {
			action: 'ONCONFLICT_NOTHING',
			infer: {
				indexElems: [{ IndexElem: { name: 'a' } }],
				whereClause: gtExpr(columnRef('a'), integerNode(0)),
			},
		};
		compare(node);
	});
});
