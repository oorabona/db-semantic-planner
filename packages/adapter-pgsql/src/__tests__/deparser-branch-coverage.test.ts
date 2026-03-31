/**
 * Branch coverage tests for pgsql-deparser.ts.
 *
 * Focus: edge cases and error paths for all exported/internal functions.
 * Strategy: drive coverage via the public `deparse()` entry point.
 * All assertions use .toBe() or .toEqual() — never .toContain().
 */

import type { Node } from '@pgsql/types';
import { describe, expect, it } from 'vitest';
import { deparse } from '../pgsql-deparser.js';

// ---------------------------------------------------------------------------
// Helpers: build raw AST nodes directly so we can target specific branches
// ---------------------------------------------------------------------------

function aConst(value: unknown): Node {
	return { A_Const: value } as Node;
}

function columnRef(fields: unknown[]): Node {
	return { ColumnRef: { fields } } as Node;
}

function paramRef(number: number): Node {
	return { ParamRef: { number } } as Node;
}

function aExpr(kind: string, op: string | string[], lexpr?: Node, rexpr?: unknown): Node {
	return {
		A_Expr: {
			kind,
			name: typeof op === 'string' ? [{ String: { sval: op } }] : op.map((o) => ({ String: { sval: o } })),
			lexpr,
			rexpr,
		},
	} as Node;
}

function typeCast(arg: Node, typeName: unknown): Node {
	return { TypeCast: { arg, typeName } } as Node;
}

function subLink(subLinkType: string, extra?: Record<string, unknown>): Node {
	const subselect: Node = {
		SelectStmt: {
			targetList: [{ ResTarget: { val: { A_Const: { ival: 1 } } } }],
		},
	} as Node;
	return { SubLink: { subLinkType, subselect, ...extra } } as Node;
}

function nullTest(arg: Node, nulltesttype: string): Node {
	return { NullTest: { arg, nulltesttype } } as Node;
}

function rangeVar(relname: string, schemaname?: string, alias?: string): Node {
	return {
		RangeVar: {
			relname,
			...(schemaname ? { schemaname } : {}),
			...(alias ? { alias: { aliasname: alias } } : {}),
		},
	} as Node;
}

function boolExpr(boolop: string, args: Node[]): Node {
	return { BoolExpr: { boolop, args } } as Node;
}

function funcCall(name: string[], args?: Node[], extra?: Record<string, unknown>): Node {
	return {
		FuncCall: {
			funcname: name.map((n) => ({ String: { sval: n } })),
			...(args ? { args } : {}),
			...extra,
		},
	} as Node;
}

function selectStmt(fields?: unknown): Node {
	return {
		SelectStmt: {
			targetList: [{ ResTarget: { val: { A_Const: { ival: 1 } } } }],
			...(typeof fields === 'object' && fields !== null ? fields : {}),
		},
	} as Node;
}

// ---------------------------------------------------------------------------
// deparse() — top-level dispatch
// ---------------------------------------------------------------------------

describe('deparse: top-level dispatch', () => {
	it('returns NULL for null input', () => {
		expect(deparse(null as unknown as Node)).toBe('NULL');
	});

	it('returns NULL for undefined input', () => {
		expect(deparse(undefined as unknown as Node)).toBe('NULL');
	});

	it('returns empty string for empty object', () => {
		expect(deparse({} as Node)).toBe('');
	});

	it('handles A_Star node', () => {
		expect(deparse({ A_Star: {} } as Node)).toBe('*');
	});

	it('handles Null node', () => {
		expect(deparse({ Null: {} } as Node)).toBe('NULL');
	});

	it('handles NamedArgExpr', () => {
		const node: Node = {
			NamedArgExpr: {
				name: 'timeout',
				arg: aConst({ ival: 5 }),
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('timeout => 5');
	});

	it('handles RawSQL passthrough', () => {
		const node: Node = { RawSQL: { sql: 'NOW()' } } as unknown as Node;
		expect(deparse(node)).toBe('NOW()');
	});

	it('throws on unknown node type', () => {
		const node: Node = { UnknownNodeXYZ: {} } as unknown as Node;
		expect(() => deparse(node)).toThrow('deparse: unsupported AST node type: UnknownNodeXYZ');
	});
});

// ---------------------------------------------------------------------------
// deparseAConst — all branches
// ---------------------------------------------------------------------------

describe('deparseAConst', () => {
	it('isnull → NULL', () => {
		expect(deparse(aConst({ isnull: true }))).toBe('NULL');
	});

	it('integer literal — nested object form', () => {
		expect(deparse(aConst({ ival: { ival: 42 } }))).toBe('42');
	});

	it('integer literal — direct number form', () => {
		expect(deparse(aConst({ ival: 7 }))).toBe('7');
	});

	it('float literal — nested object form', () => {
		expect(deparse(aConst({ fval: { fval: '3.14' } }))).toBe('3.14');
	});

	it('float literal — direct string form', () => {
		expect(deparse(aConst({ fval: '2.71' }))).toBe('2.71');
	});

	it('boolean true — nested object form', () => {
		expect(deparse(aConst({ boolval: { boolval: true } }))).toBe('true');
	});

	it('boolean false — nested object form', () => {
		expect(deparse(aConst({ boolval: { boolval: false } }))).toBe('false');
	});

	it('boolean true — direct form', () => {
		expect(deparse(aConst({ boolval: true }))).toBe('true');
	});

	it('boolean false — direct form', () => {
		expect(deparse(aConst({ boolval: false }))).toBe('false');
	});

	it('string literal — nested object form', () => {
		expect(deparse(aConst({ sval: { sval: 'hello' } }))).toBe("'hello'");
	});

	it('string literal — direct string form', () => {
		expect(deparse(aConst({ sval: 'world' }))).toBe("'world'");
	});

	it('string with single quotes escaped', () => {
		expect(deparse(aConst({ sval: "it's" }))).toBe("'it''s'");
	});

	it('fallback → NULL when no known key', () => {
		expect(deparse(aConst({}))).toBe('NULL');
	});
});

// ---------------------------------------------------------------------------
// deparseColumnRef — all branches
// ---------------------------------------------------------------------------

describe('deparseColumnRef', () => {
	it('simple lowercase identifier (no quoting)', () => {
		const node = columnRef([{ String: { sval: 'id' } }]);
		expect(deparse(node)).toBe('id');
	});

	it('identifier requiring quoting (reserved word)', () => {
		const node = columnRef([{ String: { sval: 'order' } }]);
		expect(deparse(node)).toBe('"order"');
	});

	it('identifier with uppercase requires quoting', () => {
		const node = columnRef([{ String: { sval: 'MyCol' } }]);
		expect(deparse(node)).toBe('"MyCol"');
	});

	it('A_Star field → wildcard', () => {
		const node = columnRef([{ A_Star: {} }]);
		expect(deparse(node)).toBe('*');
	});

	it('schema.table.column three-part reference', () => {
		const node = columnRef([{ String: { sval: 'public' } }, { String: { sval: 'users' } }, { String: { sval: 'id' } }]);
		expect(deparse(node)).toBe('public.users.id');
	});

	it('empty fields array → empty string', () => {
		const node = columnRef([]);
		expect(deparse(node)).toBe('');
	});

	it('empty fields (undefined) → empty string', () => {
		const node = { ColumnRef: {} } as Node;
		expect(deparse(node)).toBe('');
	});
});

// ---------------------------------------------------------------------------
// deparseRangeVar — all branches
// ---------------------------------------------------------------------------

describe('deparseRangeVar', () => {
	it('bare table name', () => {
		expect(deparse(rangeVar('users'))).toBe('users');
	});

	it('schema-qualified table', () => {
		expect(deparse(rangeVar('users', 'public'))).toBe('public.users');
	});

	it('table with alias', () => {
		expect(deparse(rangeVar('users', undefined, 'u'))).toBe('users AS u');
	});

	it('schema + alias', () => {
		expect(deparse(rangeVar('orders', 'sales', 'o'))).toBe('sales.orders AS o');
	});
});

// ---------------------------------------------------------------------------
// deparseAExpr — all kind branches
// ---------------------------------------------------------------------------

describe('deparseAExpr: AEXPR_OP', () => {
	it('binary op with both sides', () => {
		const left = columnRef([{ String: { sval: 'age' } }]);
		const right = aConst({ ival: 18 });
		const node = aExpr('AEXPR_OP', '>', left, right);
		expect(deparse(node)).toBe('age > 18');
	});

	it('unary prefix op (no lexpr)', () => {
		const right = aConst({ ival: 0 });
		const node = aExpr('AEXPR_OP', '-', undefined, right);
		expect(deparse(node)).toBe('- 0');
	});

	it('parenthesizes nested A_Expr on the left', () => {
		const inner = aExpr('AEXPR_OP', '+', aConst({ ival: 1 }), aConst({ ival: 2 }));
		const innerRaw = (inner as Record<string, unknown>).A_Expr as Node;
		const left = { A_Expr: innerRaw } as Node;
		const right = aConst({ ival: 3 });
		const outer = aExpr('AEXPR_OP', '*', left, right);
		expect(deparse(outer)).toBe('(1 + 2) * 3');
	});

	it('parenthesizes nested A_Expr on the right', () => {
		const inner = aExpr('AEXPR_OP', '+', aConst({ ival: 1 }), aConst({ ival: 2 }));
		const innerRaw = (inner as Record<string, unknown>).A_Expr as Node;
		const right = { A_Expr: innerRaw } as Node;
		const left = aConst({ ival: 5 });
		const outer = aExpr('AEXPR_OP', '*', left, right);
		expect(deparse(outer)).toBe('5 * (1 + 2)');
	});
});

describe('deparseAExpr: AEXPR_OP_ANY', () => {
	it('produces X op ANY (Y)', () => {
		const left = columnRef([{ String: { sval: 'id' } }]);
		const right = { A_ArrayExpr: { elements: [aConst({ ival: 1 }), aConst({ ival: 2 })] } } as Node;
		const node = aExpr('AEXPR_OP_ANY', '=', left, right);
		expect(deparse(node)).toBe('id = ANY (ARRAY[1, 2])');
	});

	it('handles missing lexpr/rexpr', () => {
		const node = aExpr('AEXPR_OP_ANY', '=', undefined, undefined);
		expect(deparse(node)).toBe(' = ANY ()');
	});
});

describe('deparseAExpr: AEXPR_OP_ALL', () => {
	it('produces X op ALL (Y)', () => {
		const left = columnRef([{ String: { sval: 'score' } }]);
		const right = { A_ArrayExpr: { elements: [aConst({ ival: 90 })] } } as Node;
		const node = aExpr('AEXPR_OP_ALL', '>', left, right);
		expect(deparse(node)).toBe('score > ALL (ARRAY[90])');
	});
});

describe('deparseAExpr: AEXPR_BETWEEN / AEXPR_NOT_BETWEEN', () => {
	it('BETWEEN produces correct syntax', () => {
		const left = columnRef([{ String: { sval: 'age' } }]);
		const rexpr = {
			List: {
				items: [aConst({ ival: 18 }), aConst({ ival: 65 })],
			},
		};
		const node = aExpr('AEXPR_BETWEEN', 'BETWEEN', left, rexpr);
		expect(deparse(node)).toBe('age BETWEEN 18 AND 65');
	});

	it('NOT BETWEEN produces correct syntax', () => {
		const left = columnRef([{ String: { sval: 'age' } }]);
		const rexpr = {
			List: {
				items: [aConst({ ival: 18 }), aConst({ ival: 65 })],
			},
		};
		const node = aExpr('AEXPR_NOT_BETWEEN', 'NOT BETWEEN', left, rexpr);
		expect(deparse(node)).toBe('age NOT BETWEEN 18 AND 65');
	});

	it('BETWEEN with empty items list produces BETWEEN  AND ', () => {
		const left = columnRef([{ String: { sval: 'x' } }]);
		const rexpr = { List: {} };
		const node = aExpr('AEXPR_BETWEEN', 'BETWEEN', left, rexpr);
		expect(deparse(node)).toBe('x BETWEEN  AND ');
	});
});

describe('deparseAExpr: AEXPR_LIKE / AEXPR_ILIKE', () => {
	it('LIKE (~~)', () => {
		const left = columnRef([{ String: { sval: 'name' } }]);
		const right = aConst({ sval: '%foo%' });
		const node = aExpr('AEXPR_LIKE', '~~', left, right);
		expect(deparse(node)).toBe("name LIKE '%foo%'");
	});

	it('NOT LIKE (!~~)', () => {
		const left = columnRef([{ String: { sval: 'name' } }]);
		const right = aConst({ sval: '%bar%' });
		const node = aExpr('AEXPR_LIKE', '!~~', left, right);
		expect(deparse(node)).toBe("name NOT LIKE '%bar%'");
	});

	it('LIKE with ESCAPE clause', () => {
		const left = columnRef([{ String: { sval: 'path' } }]);
		const right = aConst({ sval: '50\\%%' });
		const escapeNode = aConst({ sval: '\\' });
		const baseNode = aExpr('AEXPR_LIKE', '~~', left, right);
		// Inject escape into A_Expr inner
		const inner = (baseNode as Record<string, unknown>).A_Expr as Record<string, unknown>;
		inner.escape = escapeNode;
		expect(deparse(baseNode)).toBe("path LIKE '50\\%%' ESCAPE '\\'");
	});

	it('ILIKE (~~*)', () => {
		const left = columnRef([{ String: { sval: 'email' } }]);
		const right = aConst({ sval: '%@example.com' });
		const node = aExpr('AEXPR_ILIKE', '~~*', left, right);
		expect(deparse(node)).toBe("email ILIKE '%@example.com'");
	});

	it('NOT ILIKE (!~~*)', () => {
		const left = columnRef([{ String: { sval: 'email' } }]);
		const right = aConst({ sval: '%@spam.com' });
		const node = aExpr('AEXPR_ILIKE', '!~~*', left, right);
		expect(deparse(node)).toBe("email NOT ILIKE '%@spam.com'");
	});
});

describe('deparseAExpr: AEXPR_IN', () => {
	it('IN with List rexpr', () => {
		const left = columnRef([{ String: { sval: 'status' } }]);
		const rexpr = {
			List: { items: [aConst({ sval: 'active' }), aConst({ sval: 'pending' })] },
		};
		const node = aExpr('AEXPR_IN', '=', left, rexpr);
		expect(deparse(node)).toBe("status IN ('active', 'pending')");
	});

	it('NOT IN with op <>', () => {
		const left = columnRef([{ String: { sval: 'status' } }]);
		const rexpr = {
			List: { items: [aConst({ sval: 'deleted' })] },
		};
		const node = aExpr('AEXPR_IN', '<>', left, rexpr);
		expect(deparse(node)).toBe("status NOT IN ('deleted')");
	});

	it('IN with non-List rexpr (no extra parens)', () => {
		const left = columnRef([{ String: { sval: 'id' } }]);
		const rexpr = paramRef(1);
		const node = aExpr('AEXPR_IN', '=', left, rexpr);
		expect(deparse(node)).toBe('id IN $1');
	});
});

describe('deparseAExpr: AEXPR_NULLIF', () => {
	it('NULLIF produces correct syntax', () => {
		const left = columnRef([{ String: { sval: 'score' } }]);
		const right = aConst({ ival: 0 });
		const node = aExpr('AEXPR_NULLIF', '=', left, right);
		expect(deparse(node)).toBe('NULLIF(score, 0)');
	});
});

describe('deparseAExpr: fallback branch', () => {
	it('unknown kind falls back to binary operator', () => {
		const left = columnRef([{ String: { sval: 'a' } }]);
		const right = aConst({ ival: 1 });
		const node = aExpr('UNKNOWN_KIND', '??', left, right);
		expect(deparse(node)).toBe('a ?? 1');
	});

	it('unknown kind with no lexpr falls back to unary prefix', () => {
		const right = aConst({ ival: 1 });
		const node = aExpr('UNKNOWN_KIND', '??', undefined, right);
		expect(deparse(node)).toBe('?? 1');
	});
});

// ---------------------------------------------------------------------------
// deparseTypeCast — A_Const vs non-A_Const branches
// ---------------------------------------------------------------------------

describe('deparseTypeCast', () => {
	it('A_Const arg uses :: shorthand', () => {
		const arg = aConst({ sval: '2024-01-01' });
		const typNameNode = {
			names: [{ String: { sval: 'date' } }],
		};
		const node = typeCast(arg, typNameNode);
		expect(deparse(node)).toBe("'2024-01-01'::date");
	});

	it('non-A_Const arg uses CAST(... AS ...) form', () => {
		const arg = columnRef([{ String: { sval: 'created_at' } }]);
		const typNameNode = {
			names: [{ String: { sval: 'text' } }],
		};
		const node = typeCast(arg, typNameNode);
		expect(deparse(node)).toBe('CAST(created_at AS text)');
	});

	it('missing arg uses empty string', () => {
		const typNameNode = { names: [{ String: { sval: 'int4' } }] };
		const node = { TypeCast: { typeName: typNameNode } } as Node;
		expect(deparse(node)).toBe('CAST( AS int4)');
	});
});

// ---------------------------------------------------------------------------
// deparseTypeName — pg_catalog filtering, array bounds
// ---------------------------------------------------------------------------

describe('deparseTypeName', () => {
	it('filters out pg_catalog prefix', () => {
		const node: Node = {
			TypeName: {
				names: [{ String: { sval: 'pg_catalog' } }, { String: { sval: 'int4' } }],
			},
		} as Node;
		expect(deparse(node)).toBe('int4');
	});

	it('adds [] suffix when arrayBounds present', () => {
		const node: Node = {
			TypeName: {
				names: [{ String: { sval: 'text' } }],
				arrayBounds: [{ Integer: { ival: -1 } }],
			},
		} as Node;
		expect(deparse(node)).toBe('text[]');
	});

	it('no arrayBounds — no suffix', () => {
		const node: Node = {
			TypeName: {
				names: [{ String: { sval: 'boolean' } }],
			},
		} as Node;
		expect(deparse(node)).toBe('boolean');
	});

	it('empty names array → empty string', () => {
		const node: Node = { TypeName: { names: [] } } as Node;
		expect(deparse(node)).toBe('');
	});
});

// ---------------------------------------------------------------------------
// deparseNullTest
// ---------------------------------------------------------------------------

describe('deparseNullTest', () => {
	it('IS NULL', () => {
		const arg = columnRef([{ String: { sval: 'email' } }]);
		const node = nullTest(arg, 'IS_NULL');
		expect(deparse(node)).toBe('email IS NULL');
	});

	it('IS NOT NULL (non-IS_NULL)', () => {
		const arg = columnRef([{ String: { sval: 'email' } }]);
		const node = nullTest(arg, 'IS_NOT_NULL');
		expect(deparse(node)).toBe('email IS NOT NULL');
	});

	it('null arg → empty prefix', () => {
		const node = { NullTest: { nulltesttype: 'IS_NULL' } } as Node;
		expect(deparse(node)).toBe(' IS NULL');
	});
});

// ---------------------------------------------------------------------------
// deparseSubLink — all subLinkType branches
// ---------------------------------------------------------------------------

describe('deparseSubLink', () => {
	it('EXISTS_SUBLINK', () => {
		const node = subLink('EXISTS_SUBLINK');
		expect(deparse(node)).toBe('EXISTS (SELECT 1)');
	});

	it('ANY_SUBLINK with testexpr and operName', () => {
		const testExpr = columnRef([{ String: { sval: 'id' } }]);
		const node = subLink('ANY_SUBLINK', {
			testexpr: testExpr,
			operName: [{ String: { sval: '=' } }],
		});
		expect(deparse(node)).toBe('id = ANY (SELECT 1)');
	});

	it('ANY_SUBLINK without testexpr falls back to bare ANY', () => {
		const node = subLink('ANY_SUBLINK');
		expect(deparse(node)).toBe('ANY (SELECT 1)');
	});

	it('ANY_SUBLINK with testexpr but empty operName falls back to bare ANY', () => {
		const testExpr = columnRef([{ String: { sval: 'id' } }]);
		const node = subLink('ANY_SUBLINK', { testexpr: testExpr, operName: [] });
		expect(deparse(node)).toBe('ANY (SELECT 1)');
	});

	it('ALL_SUBLINK with testexpr and operName', () => {
		const testExpr = columnRef([{ String: { sval: 'score' } }]);
		const node = subLink('ALL_SUBLINK', {
			testexpr: testExpr,
			operName: [{ String: { sval: '>' } }],
		});
		expect(deparse(node)).toBe('score > ALL (SELECT 1)');
	});

	it('ALL_SUBLINK without testexpr falls back to bare ALL', () => {
		const node = subLink('ALL_SUBLINK');
		expect(deparse(node)).toBe('ALL (SELECT 1)');
	});

	it('EXPR_SUBLINK → scalar subquery in parens', () => {
		const node = subLink('EXPR_SUBLINK');
		expect(deparse(node)).toBe('(SELECT 1)');
	});

	it('EXPR_SUBLINK without subselect → empty parens', () => {
		const node: Node = { SubLink: { subLinkType: 'EXPR_SUBLINK' } } as Node;
		expect(deparse(node)).toBe('()');
	});
});

// ---------------------------------------------------------------------------
// deparseSelectStmt — set operations, VALUES, DISTINCT, clauses
// ---------------------------------------------------------------------------

describe('deparseSelectStmt: set operations', () => {
	it('UNION (not ALL)', () => {
		const node: Node = {
			SelectStmt: {
				op: 'SETOP_UNION',
				all: false,
				larg: { targetList: [{ ResTarget: { val: { A_Const: { ival: 1 } } } }] },
				rarg: { targetList: [{ ResTarget: { val: { A_Const: { ival: 2 } } } }] },
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('SELECT 1 UNION SELECT 2');
	});

	it('UNION ALL', () => {
		const node: Node = {
			SelectStmt: {
				op: 'SETOP_UNION',
				all: true,
				larg: { targetList: [{ ResTarget: { val: { A_Const: { ival: 1 } } } }] },
				rarg: { targetList: [{ ResTarget: { val: { A_Const: { ival: 2 } } } }] },
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('SELECT 1 UNION ALL SELECT 2');
	});

	it('INTERSECT', () => {
		const node: Node = {
			SelectStmt: {
				op: 'SETOP_INTERSECT',
				all: false,
				larg: { targetList: [{ ResTarget: { val: { A_Const: { ival: 1 } } } }] },
				rarg: { targetList: [{ ResTarget: { val: { A_Const: { ival: 2 } } } }] },
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('SELECT 1 INTERSECT SELECT 2');
	});

	it('INTERSECT ALL', () => {
		const node: Node = {
			SelectStmt: {
				op: 'SETOP_INTERSECT',
				all: true,
				larg: { targetList: [{ ResTarget: { val: { A_Const: { ival: 1 } } } }] },
				rarg: { targetList: [{ ResTarget: { val: { A_Const: { ival: 2 } } } }] },
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('SELECT 1 INTERSECT ALL SELECT 2');
	});

	it('EXCEPT', () => {
		const node: Node = {
			SelectStmt: {
				op: 'SETOP_EXCEPT',
				all: false,
				larg: { targetList: [{ ResTarget: { val: { A_Const: { ival: 1 } } } }] },
				rarg: { targetList: [{ ResTarget: { val: { A_Const: { ival: 2 } } } }] },
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('SELECT 1 EXCEPT SELECT 2');
	});

	it('EXCEPT ALL', () => {
		const node: Node = {
			SelectStmt: {
				op: 'SETOP_EXCEPT',
				all: true,
				larg: { targetList: [{ ResTarget: { val: { A_Const: { ival: 1 } } } }] },
				rarg: { targetList: [{ ResTarget: { val: { A_Const: { ival: 2 } } } }] },
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('SELECT 1 EXCEPT ALL SELECT 2');
	});

	it('unknown set op passes through as-is', () => {
		const node: Node = {
			SelectStmt: {
				op: 'SETOP_CUSTOM',
				all: false,
				larg: { targetList: [{ ResTarget: { val: { A_Const: { ival: 1 } } } }] },
				rarg: { targetList: [{ ResTarget: { val: { A_Const: { ival: 2 } } } }] },
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('SELECT 1 SETOP_CUSTOM SELECT 2');
	});

	it('missing larg/rarg gives empty sides', () => {
		const node: Node = {
			SelectStmt: { op: 'SETOP_UNION', all: false },
		} as unknown as Node;
		expect(deparse(node)).toBe(' UNION ');
	});
});

describe('deparseSelectStmt: VALUES clause', () => {
	it('single-row VALUES', () => {
		const node: Node = {
			SelectStmt: {
				valuesLists: [{ List: { items: [aConst({ ival: 1 }), aConst({ sval: 'a' })] } }],
			},
		} as unknown as Node;
		expect(deparse(node)).toBe("VALUES (1, 'a')");
	});

	it('multi-row VALUES', () => {
		const node: Node = {
			SelectStmt: {
				valuesLists: [{ List: { items: [aConst({ ival: 1 })] } }, { List: { items: [aConst({ ival: 2 })] } }],
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('VALUES (1), (2)');
	});

	it('VALUES row with no items → empty parens', () => {
		const node: Node = {
			SelectStmt: {
				valuesLists: [{ List: {} }],
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('VALUES ()');
	});
});

describe('deparseSelectStmt: DISTINCT variants', () => {
	it('SELECT DISTINCT (empty distinctClause array)', () => {
		const node: Node = {
			SelectStmt: {
				distinctClause: [],
				targetList: [{ ResTarget: { val: columnRef([{ String: { sval: 'id' } }]) } }],
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('SELECT DISTINCT id');
	});

	it('SELECT DISTINCT ON (...) with columns', () => {
		const node: Node = {
			SelectStmt: {
				distinctClause: [columnRef([{ String: { sval: 'dept' } }])],
				targetList: [{ ResTarget: { val: columnRef([{ String: { sval: 'id' } }]) } }],
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('SELECT DISTINCT ON (dept) id');
	});
});

describe('deparseSelectStmt: individual clauses', () => {
	it('WHERE clause', () => {
		const node: Node = {
			SelectStmt: {
				targetList: [{ ResTarget: { val: aConst({ ival: 1 }) } }],
				whereClause: aExpr('AEXPR_OP', '=', columnRef([{ String: { sval: 'x' } }]), aConst({ ival: 5 })),
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('SELECT 1 WHERE x = 5');
	});

	it('GROUP BY clause', () => {
		const node: Node = {
			SelectStmt: {
				targetList: [{ ResTarget: { val: columnRef([{ String: { sval: 'dept' } }]) } }],
				fromClause: [rangeVar('employees')],
				groupClause: [columnRef([{ String: { sval: 'dept' } }])],
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('SELECT dept FROM employees GROUP BY dept');
	});

	it('HAVING clause', () => {
		const node: Node = {
			SelectStmt: {
				targetList: [{ ResTarget: { val: aConst({ ival: 1 }) } }],
				fromClause: [rangeVar('t')],
				havingClause: aExpr('AEXPR_OP', '>', columnRef([{ String: { sval: 'cnt' } }]), aConst({ ival: 0 })),
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('SELECT 1 FROM t HAVING cnt > 0');
	});

	it('LIMIT clause', () => {
		const node: Node = {
			SelectStmt: {
				targetList: [{ ResTarget: { val: aConst({ ival: 1 }) } }],
				limitCount: aConst({ ival: 10 }),
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('SELECT 1 LIMIT 10');
	});

	it('OFFSET clause', () => {
		const node: Node = {
			SelectStmt: {
				targetList: [{ ResTarget: { val: aConst({ ival: 1 }) } }],
				limitOffset: aConst({ ival: 5 }),
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('SELECT 1 OFFSET 5');
	});

	it('WITH clause (non-recursive)', () => {
		const cte: Node = {
			CommonTableExpr: {
				ctename: 'cte1',
				ctequery: {
					SelectStmt: {
						targetList: [{ ResTarget: { val: aConst({ ival: 1 }) } }],
					},
				},
			},
		} as Node;
		const node: Node = {
			SelectStmt: {
				withClause: { recursive: false, ctes: [cte] },
				targetList: [{ ResTarget: { val: aConst({ ival: 1 }) } }],
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('WITH cte1 AS (SELECT 1) SELECT 1');
	});

	it('WITH RECURSIVE clause', () => {
		const cte: Node = {
			CommonTableExpr: {
				ctename: 'tree',
				ctequery: {
					SelectStmt: {
						targetList: [{ ResTarget: { val: aConst({ ival: 1 }) } }],
					},
				},
			},
		} as Node;
		const node: Node = {
			SelectStmt: {
				withClause: { recursive: true, ctes: [cte] },
				targetList: [{ ResTarget: { val: aConst({ ival: 1 }) } }],
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('WITH RECURSIVE tree AS (SELECT 1) SELECT 1');
	});
});

// ---------------------------------------------------------------------------
// deparseBoolExpr — all branches
// ---------------------------------------------------------------------------

describe('deparseBoolExpr', () => {
	it('NOT_EXPR wraps single arg', () => {
		const arg = aExpr('AEXPR_OP', '=', columnRef([{ String: { sval: 'a' } }]), aConst({ ival: 1 }));
		const node = boolExpr('NOT_EXPR', [arg]);
		expect(deparse(node)).toBe('NOT (a = 1)');
	});

	it('AND_EXPR joins with AND', () => {
		const a = aExpr('AEXPR_OP', '=', columnRef([{ String: { sval: 'a' } }]), aConst({ ival: 1 }));
		const b = aExpr('AEXPR_OP', '=', columnRef([{ String: { sval: 'b' } }]), aConst({ ival: 2 }));
		const node = boolExpr('AND_EXPR', [a, b]);
		expect(deparse(node)).toBe('a = 1 AND b = 2');
	});

	it('OR_EXPR joins with OR', () => {
		const a = aExpr('AEXPR_OP', '=', columnRef([{ String: { sval: 'a' } }]), aConst({ ival: 1 }));
		const b = aExpr('AEXPR_OP', '=', columnRef([{ String: { sval: 'b' } }]), aConst({ ival: 2 }));
		const node = boolExpr('OR_EXPR', [a, b]);
		expect(deparse(node)).toBe('a = 1 OR b = 2');
	});

	it('AND wrapping OR children parenthesizes them', () => {
		const orChild: Node = {
			BoolExpr: {
				boolop: 'OR_EXPR',
				args: [
					aExpr('AEXPR_OP', '=', columnRef([{ String: { sval: 'a' } }]), aConst({ ival: 1 })),
					aExpr('AEXPR_OP', '=', columnRef([{ String: { sval: 'b' } }]), aConst({ ival: 2 })),
				],
			},
		} as Node;
		const other = aExpr('AEXPR_OP', '=', columnRef([{ String: { sval: 'c' } }]), aConst({ ival: 3 }));
		const node = boolExpr('AND_EXPR', [orChild, other]);
		expect(deparse(node)).toBe('(a = 1 OR b = 2) AND c = 3');
	});
});

// ---------------------------------------------------------------------------
// deparseFuncCall — all branches
// ---------------------------------------------------------------------------

describe('deparseFuncCall', () => {
	it('count(*) — agg_star branch', () => {
		const node = funcCall(['count'], undefined, { agg_star: true });
		expect(deparse(node)).toBe('count(*)');
	});

	it('simple function call with args', () => {
		const node = funcCall(['lower'], [columnRef([{ String: { sval: 'name' } }])]);
		expect(deparse(node)).toBe('lower(name)');
	});

	it('DISTINCT aggregate', () => {
		const node = funcCall(['count'], [columnRef([{ String: { sval: 'id' } }])], { agg_distinct: true });
		expect(deparse(node)).toBe('count(DISTINCT id)');
	});

	it('aggregate with ORDER BY', () => {
		const arg = columnRef([{ String: { sval: 'score' } }]);
		const orderBy: Node = {
			SortBy: {
				node: arg,
				sortby_dir: 'SORTBY_DESC',
			},
		} as Node;
		const node = funcCall(['array_agg'], [arg], { agg_order: [orderBy] });
		expect(deparse(node)).toBe('array_agg(score ORDER BY score DESC)');
	});

	it('function with FILTER (WHERE ...)', () => {
		const arg = columnRef([{ String: { sval: 'amount' } }]);
		const filter = aExpr('AEXPR_OP', '>', arg, aConst({ ival: 0 }));
		const node = funcCall(['sum'], [arg], { agg_filter: filter });
		expect(deparse(node)).toBe('sum(amount) FILTER (WHERE amount > 0)');
	});

	it('function with OVER clause (window)', () => {
		const node = funcCall(['row_number'], [], {
			over: { partitionClause: [columnRef([{ String: { sval: 'dept' } }])] },
		});
		expect(deparse(node)).toBe('row_number() OVER (PARTITION BY dept)');
	});

	it('schema-qualified function name', () => {
		const node: Node = {
			FuncCall: {
				funcname: [{ String: { sval: 'pg_catalog' } }, { String: { sval: 'now' } }],
			},
		} as Node;
		expect(deparse(node)).toBe('pg_catalog.now()');
	});

	it('empty funcname', () => {
		const node: Node = { FuncCall: {} } as Node;
		expect(deparse(node)).toBe('()');
	});
});

// ---------------------------------------------------------------------------
// deparseWindowDef — all frame option branches
// ---------------------------------------------------------------------------

describe('deparseWindowDef', () => {
	// Bit flag values from pgsql-deparser.ts:
	// FRAMEOPTION_NONDEFAULT               = 0x00001
	// FRAMEOPTION_RANGE                    = 0x00002
	// FRAMEOPTION_ROWS                     = 0x00004
	// FRAMEOPTION_GROUPS                   = 0x00008
	// FRAMEOPTION_BETWEEN                  = 0x00010
	// FRAMEOPTION_START_UNBOUNDED_PRECEDING = 0x00020
	// FRAMEOPTION_END_UNBOUNDED_PRECEDING   = 0x00040 (actually END_UNBOUNDED_PRECEDING=0x00100 in code)
	// Note: checking exact constant values from source:
	// L785: START_UNBOUNDED_PRECEDING = 0x00020
	// L786: END_UNBOUNDED_PRECEDING   = 0x00040 (but source shows L786: END_UNBOUNDED_PRECEDING)
	// L787: START_UNBOUNDED_FOLLOWING = 0x00080 (but source shows L787: START_UNBOUNDED_FOLLOWING)
	// L788: END_UNBOUNDED_FOLLOWING   = 0x00100 (but source shows L788: END_UNBOUNDED_FOLLOWING)
	// L789: START_CURRENT_ROW         = 0x00200 (but source shows L789: START_CURRENT_ROW)
	// L790: END_CURRENT_ROW           = 0x00400 (but source shows L790: END_CURRENT_ROW)

	it('RANGE UNBOUNDED PRECEDING frame', () => {
		// NONDEFAULT | RANGE | START_UNBOUNDED_PRECEDING
		const frameOptions = 0x00001 | 0x00002 | 0x00020;
		const node: Node = { WindowDef: { frameOptions } } as Node;
		expect(deparse(node)).toBe('RANGE UNBOUNDED PRECEDING');
	});

	it('ROWS frame', () => {
		// NONDEFAULT | ROWS | START_UNBOUNDED_PRECEDING
		const frameOptions = 0x00001 | 0x00004 | 0x00020;
		const node: Node = { WindowDef: { frameOptions } } as Node;
		expect(deparse(node)).toBe('ROWS UNBOUNDED PRECEDING');
	});

	it('GROUPS frame', () => {
		// NONDEFAULT | GROUPS | START_UNBOUNDED_PRECEDING
		const frameOptions = 0x00001 | 0x00008 | 0x00020;
		const node: Node = { WindowDef: { frameOptions } } as Node;
		expect(deparse(node)).toBe('GROUPS UNBOUNDED PRECEDING');
	});

	it('RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW', () => {
		// NONDEFAULT | RANGE | BETWEEN | START_UNBOUNDED_PRECEDING | END_CURRENT_ROW
		const frameOptions = 0x00001 | 0x00002 | 0x00010 | 0x00020 | 0x00400;
		const node: Node = { WindowDef: { frameOptions } } as Node;
		expect(deparse(node)).toBe('RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW');
	});

	it('RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING', () => {
		// NONDEFAULT | RANGE | BETWEEN | START_UNBOUNDED_PRECEDING | END_UNBOUNDED_FOLLOWING
		const frameOptions = 0x00001 | 0x00002 | 0x00010 | 0x00020 | 0x00100;
		const node: Node = { WindowDef: { frameOptions } } as Node;
		expect(deparse(node)).toBe('RANGE BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING');
	});

	it('RANGE BETWEEN CURRENT ROW AND UNBOUNDED PRECEDING (end unbounded preceding)', () => {
		// NONDEFAULT | RANGE | BETWEEN | START_CURRENT_ROW | END_UNBOUNDED_PRECEDING
		const frameOptions = 0x00001 | 0x00002 | 0x00010 | 0x00200 | 0x00040;
		const node: Node = { WindowDef: { frameOptions } } as Node;
		expect(deparse(node)).toBe('RANGE BETWEEN CURRENT ROW AND UNBOUNDED PRECEDING');
	});

	it('RANGE BETWEEN UNBOUNDED FOLLOWING AND CURRENT ROW (start unbounded following)', () => {
		// NONDEFAULT | RANGE | BETWEEN | START_UNBOUNDED_FOLLOWING | END_CURRENT_ROW
		const frameOptions = 0x00001 | 0x00002 | 0x00010 | 0x00080 | 0x00400;
		const node: Node = { WindowDef: { frameOptions } } as Node;
		expect(deparse(node)).toBe('RANGE BETWEEN UNBOUNDED FOLLOWING AND CURRENT ROW');
	});

	it('frameOptions=0 produces no frame clause', () => {
		const node: Node = { WindowDef: { frameOptions: 0 } } as Node;
		expect(deparse(node)).toBe('');
	});

	it('frameOptions undefined produces no frame clause', () => {
		const node: Node = { WindowDef: {} } as Node;
		expect(deparse(node)).toBe('');
	});

	it('window with PARTITION BY and ORDER BY', () => {
		const node: Node = {
			WindowDef: {
				partitionClause: [columnRef([{ String: { sval: 'dept' } }])],
				orderClause: [{ SortBy: { node: columnRef([{ String: { sval: 'salary' } }]), sortby_dir: 'SORTBY_DESC' } }],
			},
		} as Node;
		expect(deparse(node)).toBe('PARTITION BY dept ORDER BY salary DESC');
	});
});

// ---------------------------------------------------------------------------
// deparseJoinExpr — all join type branches
// ---------------------------------------------------------------------------

describe('deparseJoinExpr', () => {
	function joinExpr(jointype: string, quals?: Node, alias?: string): Node {
		return {
			JoinExpr: {
				larg: rangeVar('a'),
				rarg: rangeVar('b'),
				jointype,
				...(quals ? { quals } : {}),
				...(alias ? { alias: { aliasname: alias } } : {}),
			},
		} as Node;
	}

	it('JOIN_INNER → JOIN', () => {
		expect(deparse(joinExpr('JOIN_INNER'))).toBe('a JOIN b');
	});

	it('JOIN_LEFT → LEFT JOIN', () => {
		expect(deparse(joinExpr('JOIN_LEFT'))).toBe('a LEFT JOIN b');
	});

	it('JOIN_FULL → FULL JOIN', () => {
		expect(deparse(joinExpr('JOIN_FULL'))).toBe('a FULL JOIN b');
	});

	it('JOIN_RIGHT → RIGHT JOIN', () => {
		expect(deparse(joinExpr('JOIN_RIGHT'))).toBe('a RIGHT JOIN b');
	});

	it('JOIN_SEMI → SEMI JOIN', () => {
		expect(deparse(joinExpr('JOIN_SEMI'))).toBe('a SEMI JOIN b');
	});

	it('JOIN_ANTI → ANTI JOIN', () => {
		expect(deparse(joinExpr('JOIN_ANTI'))).toBe('a ANTI JOIN b');
	});

	it('unknown join type falls back to JOIN', () => {
		expect(deparse(joinExpr('JOIN_UNKNOWN'))).toBe('a JOIN b');
	});

	it('no jointype defaults to JOIN', () => {
		const node: Node = {
			JoinExpr: { larg: rangeVar('x'), rarg: rangeVar('y') },
		} as Node;
		expect(deparse(node)).toBe('x JOIN y');
	});

	it('JOIN with ON quals', () => {
		const quals = aExpr(
			'AEXPR_OP',
			'=',
			columnRef([{ String: { sval: 'a' } }, { String: { sval: 'id' } }]),
			columnRef([{ String: { sval: 'b' } }, { String: { sval: 'a_id' } }]),
		);
		expect(deparse(joinExpr('JOIN_INNER', quals))).toBe('a JOIN b ON a.id = b.a_id');
	});

	it('JOIN with outer alias wraps in parens', () => {
		expect(deparse(joinExpr('JOIN_INNER', undefined, 'j'))).toBe('(a JOIN b) j');
	});
});

// ---------------------------------------------------------------------------
// deparseSortBy — all direction/nulls combinations
// ---------------------------------------------------------------------------

describe('deparseSortBy', () => {
	function sortBy(dir?: string, nulls?: string): Node {
		return {
			SortBy: {
				node: columnRef([{ String: { sval: 'col' } }]),
				...(dir ? { sortby_dir: dir } : {}),
				...(nulls ? { sortby_nulls: nulls } : {}),
			},
		} as Node;
	}

	it('no direction, no nulls', () => {
		expect(deparse(sortBy())).toBe('col');
	});

	it('SORTBY_ASC', () => {
		expect(deparse(sortBy('SORTBY_ASC'))).toBe('col ASC');
	});

	it('SORTBY_DESC', () => {
		expect(deparse(sortBy('SORTBY_DESC'))).toBe('col DESC');
	});

	it('SORTBY_NULLS_FIRST', () => {
		expect(deparse(sortBy(undefined, 'SORTBY_NULLS_FIRST'))).toBe('col NULLS FIRST');
	});

	it('SORTBY_NULLS_LAST', () => {
		expect(deparse(sortBy(undefined, 'SORTBY_NULLS_LAST'))).toBe('col NULLS LAST');
	});

	it('DESC NULLS LAST', () => {
		expect(deparse(sortBy('SORTBY_DESC', 'SORTBY_NULLS_LAST'))).toBe('col DESC NULLS LAST');
	});

	it('no node → empty prefix', () => {
		const node: Node = { SortBy: { sortby_dir: 'SORTBY_ASC' } } as Node;
		expect(deparse(node)).toBe(' ASC');
	});
});

// ---------------------------------------------------------------------------
// deparseResTarget — all branches
// ---------------------------------------------------------------------------

describe('deparseResTarget', () => {
	it('val with no name', () => {
		const node: Node = {
			ResTarget: { val: aConst({ ival: 1 }) },
		} as Node;
		expect(deparse(node)).toBe('1');
	});

	it('val with name alias', () => {
		const node: Node = {
			ResTarget: { val: aConst({ ival: 42 }), name: 'result' },
		} as Node;
		expect(deparse(node)).toBe('42 AS result');
	});

	it('no val, only name (update target)', () => {
		const node: Node = {
			ResTarget: { name: 'col' },
		} as Node;
		expect(deparse(node)).toBe('col');
	});

	it('no val, no name → empty string', () => {
		const node: Node = { ResTarget: {} } as Node;
		expect(deparse(node)).toBe('');
	});
});

// ---------------------------------------------------------------------------
// deparseCoalesceExpr
// ---------------------------------------------------------------------------

describe('deparseCoalesceExpr', () => {
	it('COALESCE with multiple args', () => {
		const node: Node = {
			CoalesceExpr: {
				args: [columnRef([{ String: { sval: 'email' } }]), aConst({ sval: '' })],
			},
		} as Node;
		expect(deparse(node)).toBe("COALESCE(email, '')");
	});

	it('COALESCE with empty args', () => {
		const node: Node = { CoalesceExpr: {} } as Node;
		expect(deparse(node)).toBe('COALESCE()');
	});
});

// ---------------------------------------------------------------------------
// deparseNullIfExpr — error branch
// ---------------------------------------------------------------------------

describe('deparseNullIfExpr', () => {
	it('NULLIF with exactly 2 args', () => {
		const node: Node = {
			NullIfExpr: {
				args: [aConst({ ival: 5 }), aConst({ ival: 0 })],
			},
		} as Node;
		expect(deparse(node)).toBe('NULLIF(5, 0)');
	});

	it('throws when arg count != 2', () => {
		const node: Node = {
			NullIfExpr: { args: [aConst({ ival: 1 })] },
		} as Node;
		expect(() => deparse(node)).toThrow('NullIfExpr requires exactly 2 arguments, got 1');
	});

	it('throws for empty args', () => {
		const node: Node = { NullIfExpr: { args: [] } } as Node;
		expect(() => deparse(node)).toThrow('NullIfExpr requires exactly 2 arguments, got 0');
	});
});

// ---------------------------------------------------------------------------
// deparseMinMaxExpr
// ---------------------------------------------------------------------------

describe('deparseMinMaxExpr', () => {
	it('IS_GREATEST → GREATEST', () => {
		const node: Node = {
			MinMaxExpr: {
				op: 'IS_GREATEST',
				args: [aConst({ ival: 1 }), aConst({ ival: 2 })],
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('GREATEST(1, 2)');
	});

	it('any other op → LEAST', () => {
		const node: Node = {
			MinMaxExpr: {
				op: 'IS_LEAST',
				args: [aConst({ ival: 1 }), aConst({ ival: 2 })],
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('LEAST(1, 2)');
	});

	it('no op → LEAST (undefined falls to else)', () => {
		const node: Node = {
			MinMaxExpr: {
				args: [aConst({ ival: 1 })],
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('LEAST(1)');
	});
});

// ---------------------------------------------------------------------------
// deparseCaseExpr — with/without arg, with/without defresult
// ---------------------------------------------------------------------------

describe('deparseCaseExpr', () => {
	function caseWhenNode(cond: Node, result: Node): Node {
		return { CaseWhen: { expr: cond, result } } as Node;
	}

	it('simple CASE WHEN ... THEN ... END (no arg, no else)', () => {
		const node: Node = {
			CaseExpr: {
				args: [
					caseWhenNode(
						aExpr('AEXPR_OP', '=', columnRef([{ String: { sval: 'status' } }]), aConst({ sval: 'active' })),
						aConst({ sval: 'yes' }),
					),
				],
			},
		} as Node;
		expect(deparse(node)).toBe("CASE WHEN status = 'active' THEN 'yes' END");
	});

	it('CASE with arg (switched form)', () => {
		const node: Node = {
			CaseExpr: {
				arg: columnRef([{ String: { sval: 'status' } }]),
				args: [caseWhenNode(aConst({ sval: 'a' }), aConst({ sval: 'Active' }))],
				defresult: aConst({ sval: 'Other' }),
			},
		} as Node;
		expect(deparse(node)).toBe("CASE status WHEN 'a' THEN 'Active' ELSE 'Other' END");
	});

	it('CASE with ELSE branch', () => {
		const node: Node = {
			CaseExpr: {
				args: [
					caseWhenNode(
						aExpr('AEXPR_OP', '=', columnRef([{ String: { sval: 'x' } }]), aConst({ ival: 1 })),
						aConst({ sval: 'one' }),
					),
				],
				defresult: aConst({ sval: 'other' }),
			},
		} as Node;
		expect(deparse(node)).toBe("CASE WHEN x = 1 THEN 'one' ELSE 'other' END");
	});
});

// ---------------------------------------------------------------------------
// deparseRangeSubselect
// ---------------------------------------------------------------------------

describe('deparseRangeSubselect', () => {
	it('subquery without lateral or alias', () => {
		const node: Node = {
			RangeSubselect: {
				subquery: selectStmt(),
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('(SELECT 1)');
	});

	it('LATERAL prefix when lateral=true', () => {
		const node: Node = {
			RangeSubselect: {
				lateral: true,
				subquery: selectStmt(),
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('LATERAL (SELECT 1)');
	});

	it('alias without lateral', () => {
		const node: Node = {
			RangeSubselect: {
				subquery: selectStmt(),
				alias: { aliasname: 'sub' },
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('(SELECT 1) AS sub');
	});

	it('LATERAL with alias', () => {
		const node: Node = {
			RangeSubselect: {
				lateral: true,
				subquery: selectStmt(),
				alias: { aliasname: 'lsub' },
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('LATERAL (SELECT 1) AS lsub');
	});
});

// ---------------------------------------------------------------------------
// deparseArrayExpr
// ---------------------------------------------------------------------------

describe('deparseArrayExpr', () => {
	it('ARRAY[...] with elements', () => {
		const node: Node = {
			A_ArrayExpr: {
				elements: [aConst({ ival: 1 }), aConst({ ival: 2 }), aConst({ ival: 3 })],
			},
		} as Node;
		expect(deparse(node)).toBe('ARRAY[1, 2, 3]');
	});

	it('ARRAY[] with no elements', () => {
		const node: Node = { A_ArrayExpr: {} } as Node;
		expect(deparse(node)).toBe('ARRAY[]');
	});
});

// ---------------------------------------------------------------------------
// deparseListNode
// ---------------------------------------------------------------------------

describe('deparseListNode', () => {
	it('joins items with comma separator', () => {
		const node: Node = {
			List: {
				items: [aConst({ ival: 1 }), aConst({ ival: 2 })],
			},
		} as Node;
		expect(deparse(node)).toBe('1, 2');
	});

	it('empty items → empty string', () => {
		const node: Node = { List: { items: [] } } as Node;
		expect(deparse(node)).toBe('');
	});

	it('missing items → empty string', () => {
		const node: Node = { List: {} } as Node;
		expect(deparse(node)).toBe('');
	});
});

// ---------------------------------------------------------------------------
// deparseCommonTableExpr — with/without columns, with/without cycle clause
// ---------------------------------------------------------------------------

describe('deparseCommonTableExpr', () => {
	it('simple CTE without column list', () => {
		const node: Node = {
			CommonTableExpr: {
				ctename: 'my_cte',
				ctequery: selectStmt(),
			},
		} as Node;
		expect(deparse(node)).toBe('my_cte AS (SELECT 1)');
	});

	it('CTE with explicit column list', () => {
		const node: Node = {
			CommonTableExpr: {
				ctename: 'my_cte',
				cte_cols: [{ String: { sval: 'id' } }, { String: { sval: 'name' } }],
				ctequery: selectStmt(),
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('my_cte(id, name) AS (SELECT 1)');
	});

	it('CTE with cycle clause', () => {
		const node: Node = {
			CommonTableExpr: {
				ctename: 'tree',
				ctequery: selectStmt(),
				cycle_clause: {
					cycle_col_list: [{ String: { sval: 'id' } }],
					cycle_mark_column: 'is_cycle',
					cycle_path_column: 'path',
				},
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('tree AS (SELECT 1) CYCLE id SET is_cycle USING path');
	});

	it('CTE without ctequery uses empty parens', () => {
		const node: Node = {
			CommonTableExpr: { ctename: 'empty' },
		} as Node;
		expect(deparse(node)).toBe('empty AS ()');
	});
});

// ---------------------------------------------------------------------------
// deparseRangeFunction
// ---------------------------------------------------------------------------

describe('deparseRangeFunction', () => {
	it('simple function in FROM', () => {
		const node: Node = {
			RangeFunction: {
				functions: [
					{
						List: {
							items: [funcCall(['generate_series'], [aConst({ ival: 1 }), aConst({ ival: 5 })])],
						},
					},
				],
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('generate_series(1, 5)');
	});

	it('WITH ORDINALITY', () => {
		const node: Node = {
			RangeFunction: {
				functions: [
					{
						List: {
							items: [funcCall(['unnest'], [columnRef([{ String: { sval: 'arr' } }])])],
						},
					},
				],
				ordinality: true,
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('unnest(arr) WITH ORDINALITY');
	});

	it('function with alias', () => {
		const node: Node = {
			RangeFunction: {
				functions: [
					{
						List: {
							items: [funcCall(['generate_series'], [aConst({ ival: 1 }), aConst({ ival: 3 })])],
						},
					},
				],
				alias: { aliasname: 'gs' },
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('generate_series(1, 3) AS gs');
	});

	it('function with alias and column names', () => {
		const node: Node = {
			RangeFunction: {
				functions: [
					{
						List: {
							items: [funcCall(['unnest'], [columnRef([{ String: { sval: 'arr' } }])])],
						},
					},
				],
				alias: {
					aliasname: 'u',
					colnames: [{ String: { sval: 'val' } }],
				},
			},
		} as unknown as Node;
		expect(deparse(node)).toBe('unnest(arr) AS u(val)');
	});
});

// ---------------------------------------------------------------------------
// deparseStringNode — quoteIdent branch
// ---------------------------------------------------------------------------

describe('deparseStringNode (via String node)', () => {
	it('lowercase plain identifier — no quotes', () => {
		const node: Node = { String: { sval: 'id' } } as Node;
		expect(deparse(node)).toBe('id');
	});

	it('uppercase identifier requires quoting', () => {
		const node: Node = { String: { sval: 'MyTable' } } as Node;
		expect(deparse(node)).toBe('"MyTable"');
	});

	it('reserved word requires quoting', () => {
		const node: Node = { String: { sval: 'order' } } as Node;
		expect(deparse(node)).toBe('"order"');
	});
});

// ---------------------------------------------------------------------------
// deparseParamRef
// ---------------------------------------------------------------------------

describe('deparseParamRef', () => {
	it('produces $N placeholder', () => {
		const node = paramRef(3);
		expect(deparse(node)).toBe('$3');
	});

	it('number=1 produces $1', () => {
		const node = paramRef(1);
		expect(deparse(node)).toBe('$1');
	});
});
