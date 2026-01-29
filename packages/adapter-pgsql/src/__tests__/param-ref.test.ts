/**
 * ParamRef validation tests
 *
 * Block 1: BLOCKING GATE - ParamRef validation must pass before other blocks
 *
 * Tests cover:
 * 1. Basic ParamRef validation (number property)
 * 2. ParamRef in WHERE clause (col = $1)
 * 3. ParamRef in LIMIT/OFFSET ($1, $2)
 * 4. ParamRef in array context (ANY($1))
 * 5. ParamRef with TypeCast ($1::integer, $1::text[])
 * 6. AST collection and batch validation
 * 7. Deparse roundtrip verification
 */

import type { A_Expr_Kind, Node, SelectStmt } from '@pgsql/types';
import { deparseSync } from 'pgsql-deparser';
import { parseSync } from 'pgsql-parser';
import { describe, expect, it } from 'vitest';

import {
	collectAndValidateParamRefs,
	createAnyExpr,
	createEqualityExpr,
	createParamRef,
	createTypeCastParamRef,
	validateParamRef,
} from '../param-ref.js';

describe('ParamRef validation', () => {
	describe('validateParamRef', () => {
		it('validates a correct ParamRef', () => {
			const result = validateParamRef({ number: 1 });
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it('validates ParamRef with high number', () => {
			const result = validateParamRef({ number: 100 });
			expect(result.valid).toBe(true);
		});

		it('rejects undefined number', () => {
			const result = validateParamRef({});
			expect(result.valid).toBe(false);
			expect(result.errors).toContain('ParamRef.number is required');
		});

		it('rejects zero (0-based is invalid)', () => {
			const result = validateParamRef({ number: 0 });
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain('must be >= 1');
		});

		it('rejects negative numbers', () => {
			const result = validateParamRef({ number: -1 });
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain('must be >= 1');
		});

		it('rejects non-integer numbers', () => {
			const result = validateParamRef({ number: 1.5 });
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain('must be an integer');
		});

		it('rejects excessively large numbers', () => {
			const result = validateParamRef({ number: 100000 });
			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain('exceeds maximum');
		});
	});

	describe('createParamRef', () => {
		it('creates a valid ParamRef node', () => {
			const node = createParamRef(1);
			expect(node).toEqual({ ParamRef: { number: 1 } });
		});

		it('creates ParamRef with location', () => {
			const node = createParamRef(2, 42);
			expect(node).toEqual({ ParamRef: { number: 2, location: 42 } });
		});

		it('throws on invalid number', () => {
			expect(() => createParamRef(0)).toThrow('Invalid ParamRef');
			expect(() => createParamRef(-1)).toThrow('must be >= 1');
		});
	});

	describe('createTypeCastParamRef', () => {
		it('creates $1::integer TypeCast', () => {
			const node = createTypeCastParamRef(1, 'integer');
			expect(node).toHaveProperty('TypeCast');

			const typeCast = (
				node as { TypeCast: { arg: Node; typeName: { names: Node[] } } }
			).TypeCast;
			expect(typeCast.arg).toEqual({ ParamRef: { number: 1 } });
			expect(typeCast.typeName.names).toEqual([
				{ String: { sval: 'integer' } },
			]);
		});

		it('creates $1::text[] array TypeCast', () => {
			const node = createTypeCastParamRef(1, 'text', true);
			expect(node).toHaveProperty('TypeCast');

			const typeCast = (
				node as { TypeCast: { typeName: { arrayBounds?: unknown[] } } }
			).TypeCast;
			expect(typeCast.typeName.arrayBounds).toBeDefined();
		});
	});

	describe('createEqualityExpr', () => {
		it('creates col = $1 expression', () => {
			const node = createEqualityExpr('id', 1);
			expect(node).toHaveProperty('A_Expr');

			const expr = (node as { A_Expr: { lexpr: Node; rexpr: Node } }).A_Expr;
			expect(expr.lexpr).toHaveProperty('ColumnRef');
			expect(expr.rexpr).toEqual({ ParamRef: { number: 1 } });
		});

		it('creates table.col = $2 expression', () => {
			const node = createEqualityExpr('name', 2, 'users');
			const expr = (
				node as {
					A_Expr: { lexpr: { ColumnRef: { fields: Node[] } }; rexpr: Node };
				}
			).A_Expr;

			expect(expr.lexpr.ColumnRef.fields).toHaveLength(2);
			expect(expr.rexpr).toEqual({ ParamRef: { number: 2 } });
		});
	});

	describe('createAnyExpr', () => {
		it('creates col = ANY($1) expression', () => {
			const node = createAnyExpr('status', 1);
			expect(node).toHaveProperty('A_Expr');

			const expr = (
				node as { A_Expr: { rexpr: { FuncCall: { args: Node[] } } } }
			).A_Expr;
			expect(expr.rexpr).toHaveProperty('FuncCall');
			expect(expr.rexpr.FuncCall.args[0]).toEqual({ ParamRef: { number: 1 } });
		});
	});

	describe('collectAndValidateParamRefs', () => {
		it('collects all ParamRefs from nested AST', () => {
			// Build a simple SELECT with multiple ParamRefs
			const selectStmt: SelectStmt = {
				targetList: [
					{ ResTarget: { val: { ColumnRef: { fields: [{ A_Star: {} }] } } } },
				],
				fromClause: [
					{ RangeVar: { relname: 'users', inh: true, relpersistence: 'p' } },
				],
				whereClause: createEqualityExpr('id', 1),
				limitCount: createParamRef(2),
				limitOffset: createParamRef(3),
			};

			const result = collectAndValidateParamRefs({ SelectStmt: selectStmt });

			expect(result.paramRefs).toHaveLength(3);
			expect(result.allValid).toBe(true);
			expect(result.paramRefs.map((p) => p.paramRef.number)).toEqual([1, 2, 3]);
		});

		it('detects invalid ParamRefs in nested AST', () => {
			// Manually construct an invalid AST (bypassing createParamRef)
			const kind: A_Expr_Kind = 'AEXPR_OP';
			const badNode: Node = {
				A_Expr: {
					kind,
					name: [{ String: { sval: '=' } }],
					lexpr: { ColumnRef: { fields: [{ String: { sval: 'id' } }] } },
					rexpr: { ParamRef: { number: 0 } }, // Invalid: 0 is not allowed
				},
			};

			const result = collectAndValidateParamRefs(badNode);

			expect(result.paramRefs).toHaveLength(1);
			expect(result.allValid).toBe(false);
			expect(result.validationResults[0]?.errors[0]).toContain('must be >= 1');
		});
	});
});

describe('ParamRef deparse roundtrip', () => {
	it('deparses simple WHERE clause with $1', () => {
		const kind: A_Expr_Kind = 'AEXPR_OP';
		const selectStmt: SelectStmt = {
			targetList: [
				{
					ResTarget: {
						val: { ColumnRef: { fields: [{ String: { sval: 'id' } }] } },
					},
				},
			],
			fromClause: [
				{ RangeVar: { relname: 'users', inh: true, relpersistence: 'p' } },
			],
			whereClause: {
				A_Expr: {
					kind,
					name: [{ String: { sval: '=' } }],
					lexpr: { ColumnRef: { fields: [{ String: { sval: 'id' } }] } },
					rexpr: { ParamRef: { number: 1 } },
				},
			},
		};

		const sql = deparseSync({ SelectStmt: selectStmt });
		expect(sql).toContain('$1');
		expect(sql.toLowerCase()).toContain('where');
		expect(sql.toLowerCase()).toContain('id');
	});

	it('deparses LIMIT $1 OFFSET $2', () => {
		const selectStmt: SelectStmt = {
			targetList: [
				{ ResTarget: { val: { ColumnRef: { fields: [{ A_Star: {} }] } } } },
			],
			fromClause: [
				{ RangeVar: { relname: 'items', inh: true, relpersistence: 'p' } },
			],
			limitCount: { ParamRef: { number: 1 } },
			limitOffset: { ParamRef: { number: 2 } },
		};

		const sql = deparseSync({ SelectStmt: selectStmt });
		expect(sql).toContain('$1');
		expect(sql).toContain('$2');
		expect(sql.toLowerCase()).toContain('limit');
		expect(sql.toLowerCase()).toContain('offset');
	});

	it('deparses TypeCast $1::integer', () => {
		const typeCastNode = createTypeCastParamRef(1, 'int4');

		const selectStmt: SelectStmt = {
			targetList: [{ ResTarget: { val: typeCastNode } }],
		};

		const sql = deparseSync({ SelectStmt: selectStmt });
		expect(sql).toContain('$1');
		expect(sql.toLowerCase()).toMatch(/int4|integer/);
	});

	it('roundtrip: parse SQL → AST → deparse → parse again → compare', async () => {
		const originalSql =
			'SELECT id, name FROM users WHERE status = $1 AND age > $2';

		// Parse original SQL to AST
		const parseResult1 = parseSync(originalSql);
		expect(parseResult1.stmts).toHaveLength(1);

		// Validate all ParamRefs in parsed AST
		const validation = collectAndValidateParamRefs(parseResult1);
		expect(validation.allValid).toBe(true);
		expect(validation.paramRefs).toHaveLength(2);

		// Deparse back to SQL
		const deparsedSql = deparseSync(parseResult1);
		expect(deparsedSql).toContain('$1');
		expect(deparsedSql).toContain('$2');

		// Parse deparsed SQL
		const parseResult2 = parseSync(deparsedSql);
		expect(parseResult2.stmts).toHaveLength(1);

		// Validate ParamRefs in re-parsed AST
		const validation2 = collectAndValidateParamRefs(parseResult2);
		expect(validation2.allValid).toBe(true);
		expect(validation2.paramRefs).toHaveLength(2);
	});

	it('roundtrip: LIMIT/OFFSET with params', () => {
		const originalSql = 'SELECT * FROM products LIMIT $1 OFFSET $2';

		const parseResult = parseSync(originalSql);
		const validation = collectAndValidateParamRefs(parseResult);

		expect(validation.allValid).toBe(true);
		expect(validation.paramRefs.map((p) => p.paramRef.number).sort()).toEqual([
			1, 2,
		]);

		const deparsedSql = deparseSync(parseResult);
		expect(deparsedSql).toContain('$1');
		expect(deparsedSql).toContain('$2');
	});

	it('roundtrip: IN clause with array param', () => {
		const originalSql = 'SELECT * FROM users WHERE id = ANY($1::int4[])';

		const parseResult = parseSync(originalSql);
		const validation = collectAndValidateParamRefs(parseResult);

		expect(validation.allValid).toBe(true);
		expect(validation.paramRefs).toHaveLength(1);
		expect(validation.paramRefs[0]?.paramRef.number).toBe(1);

		const deparsedSql = deparseSync(parseResult);
		expect(deparsedSql).toContain('$1');
	});

	it('roundtrip: multiple TypeCast params', () => {
		const originalSql =
			'SELECT * FROM events WHERE starts_at > $1::timestamp AND ends_at < $2::timestamp';

		const parseResult = parseSync(originalSql);
		const validation = collectAndValidateParamRefs(parseResult);

		expect(validation.allValid).toBe(true);
		expect(validation.paramRefs).toHaveLength(2);

		const deparsedSql = deparseSync(parseResult);
		expect(deparsedSql).toContain('$1');
		expect(deparsedSql).toContain('$2');
	});
});

describe('Edge cases', () => {
	it('handles deeply nested ParamRefs', () => {
		// Subquery with ParamRef
		const originalSql = `
			SELECT * FROM orders
			WHERE customer_id IN (
				SELECT id FROM customers WHERE region = $1
			)
			AND total > $2
		`;

		const parseResult = parseSync(originalSql);
		const validation = collectAndValidateParamRefs(parseResult);

		expect(validation.allValid).toBe(true);
		expect(validation.paramRefs).toHaveLength(2);
	});

	it('handles CASE WHEN with ParamRef', () => {
		const originalSql = `
			SELECT
				CASE WHEN status = $1 THEN 'active' ELSE 'inactive' END as label
			FROM users
		`;

		const parseResult = parseSync(originalSql);
		const validation = collectAndValidateParamRefs(parseResult);

		expect(validation.allValid).toBe(true);
		expect(validation.paramRefs).toHaveLength(1);
	});

	it('handles INSERT with ParamRef values', () => {
		const originalSql = 'INSERT INTO users (name, email) VALUES ($1, $2)';

		const parseResult = parseSync(originalSql);
		const validation = collectAndValidateParamRefs(parseResult);

		expect(validation.allValid).toBe(true);
		expect(validation.paramRefs).toHaveLength(2);
	});

	it('handles UPDATE with ParamRef', () => {
		const originalSql =
			'UPDATE users SET name = $1, updated_at = $2 WHERE id = $3';

		const parseResult = parseSync(originalSql);
		const validation = collectAndValidateParamRefs(parseResult);

		expect(validation.allValid).toBe(true);
		expect(validation.paramRefs).toHaveLength(3);
	});

	it('handles DELETE with ParamRef', () => {
		const originalSql =
			'DELETE FROM sessions WHERE user_id = $1 AND expires_at < $2';

		const parseResult = parseSync(originalSql);
		const validation = collectAndValidateParamRefs(parseResult);

		expect(validation.allValid).toBe(true);
		expect(validation.paramRefs).toHaveLength(2);
	});
});
