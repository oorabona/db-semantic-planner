import { EXPRESSION_BRAND, NotYetSupportedError } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import type {
	ArrayExpressionIntent,
	CastExpressionIntent,
	CustomFnExpressionIntent,
	CustomOpExpressionIntent,
	LiteralExpressionIntent,
	NamedArgExpressionIntent,
	ParamExpressionIntent,
	RefExpressionIntent,
	StarExpressionIntent,
	UnaryExpressionIntent,
	WhereExpressionIntent,
} from '../intent-ast.js';
import { caseWhen } from './case-when-builder.js';
import { InvalidOperationError } from './errors.js';
import {
	array,
	arrayAgg,
	boolFn,
	cast,
	ExpressionRef,
	fn,
	literal,
	namedArg,
	op,
	param,
	ref,
	star,
	unary,
} from './expressions.js';
import { distinct, eq, sql } from './filters.js';
import { createOrm } from './orm.js';
import { schema, ref as schemaRef } from './schema.js';
import { outerRef } from './subquery-builder.js';
import { createMockAdapter } from './test-utils.js';

describe('Expression Primitives', () => {
	describe('ref()', () => {
		it('should create RefExpressionIntent', () => {
			const r = ref('column');
			expect(r.intent).toEqual({
				kind: 'ref',
				column: 'column',
			} satisfies RefExpressionIntent);
		});

		it('should set expression symbol marker', () => {
			expect(ref('col')[EXPRESSION_BRAND]).toBe(true);
		});

		it('should support table.column notation', () => {
			const r = ref('t.score');
			expect((r.intent as RefExpressionIntent).column).toBe('t.score');
		});

		it('should be instanceof ExpressionRef', () => {
			expect(ref('col')).toBeInstanceOf(ExpressionRef);
		});
	});

	describe('param()', () => {
		it('should create ParamExpressionIntent for number', () => {
			const p = param(42);
			expect(p.intent).toEqual({
				kind: 'param',
				value: 42,
			} satisfies ParamExpressionIntent);
		});

		it('should accept arrays (vectors)', () => {
			const p = param([0.1, 0.2, 0.3]);
			expect(p.intent).toEqual({ kind: 'param', value: [0.1, 0.2, 0.3] });
		});

		it('should accept null', () => {
			const p = param(null);
			expect((p.intent as ParamExpressionIntent).value).toBeNull();
		});

		it('should accept boolean', () => {
			const p = param(true);
			expect((p.intent as ParamExpressionIntent).value).toBe(true);
		});

		it('should accept string values', () => {
			const p = param('active');
			expect((p.intent as ParamExpressionIntent).value).toBe('active');
		});
	});

	describe('cast()', () => {
		it('should create CastExpressionIntent', () => {
			const c = cast(param([0.1]), 'vector');
			expect(c.intent).toEqual({
				kind: 'cast',
				expr: { kind: 'param', value: [0.1] },
				typeName: 'vector',
			} satisfies CastExpressionIntent);
		});

		it('should accept array types (int[])', () => {
			const c = cast(param([1, 2]), 'int[]');
			expect((c.intent as CastExpressionIntent).typeName).toBe('int[]');
		});

		it('should accept types with spaces (double precision)', () => {
			const c = cast(ref('val'), 'double precision');
			expect((c.intent as CastExpressionIntent).typeName).toBe(
				'double precision',
			);
		});

		it('should throw on invalid type name — SQL injection attempt', () => {
			expect(() => cast(param(1), "'); DROP TABLE users; --")).toThrow(
				'Invalid type',
			);
		});

		it('should throw on empty type name', () => {
			expect(() => cast(param(1), '')).toThrow('Invalid type');
		});

		it('should throw on type with semicolon', () => {
			expect(() => cast(param(1), 'vector; DROP TABLE')).toThrow(
				'Invalid type',
			);
		});
	});

	describe('op()', () => {
		it('should create CustomOpExpressionIntent', () => {
			const o = op('<=>', ref('vector'), cast(param([0.1]), 'vector'));
			expect(o.intent.kind).toBe('customOp');
			const intent = o.intent as CustomOpExpressionIntent;
			expect(intent.operator).toBe('<=>');
			expect(intent.left).toEqual({ kind: 'ref', column: 'vector' });
			expect(intent.right.kind).toBe('cast');
		});

		it('should apply implicit conversion: string → ref', () => {
			const o = op('<=>', 'vector', param([0.1]));
			expect((o.intent as CustomOpExpressionIntent).left).toEqual({
				kind: 'ref',
				column: 'vector',
			});
		});

		it('AC1 op-number: a number operand is an inlined literal', () => {
			const o = op('+', ref('col'), 1);
			expect((o.intent as CustomOpExpressionIntent).right).toEqual({
				kind: 'literal',
				value: 1,
			});
		});

		it('should apply implicit conversion: array → param', () => {
			const o = op('<=>', 'vector', [0.1, 0.2]);
			expect((o.intent as CustomOpExpressionIntent).right).toEqual({
				kind: 'param',
				value: [0.1, 0.2],
			});
		});

		it('should apply implicit conversion: boolean → inlined literal', () => {
			const o = op('=', 'active', true);
			expect((o.intent as CustomOpExpressionIntent).right).toEqual({
				kind: 'literal',
				value: true,
			});
		});

		it('should throw on empty operator', () => {
			expect(() => op('', ref('a'), ref('b'))).toThrow('Invalid operator');
		});

		it('should throw on SQL injection in operator', () => {
			expect(() => op("'; DROP TABLE users; --", ref('a'), ref('b'))).toThrow(
				'Invalid operator',
			);
		});

		it('should throw on operator with spaces', () => {
			expect(() => op('IS NOT', ref('a'), ref('b'))).toThrow(
				'Invalid operator',
			);
		});

		it('should support standard arithmetic operators', () => {
			expect(() => op('+', ref('a'), ref('b'))).not.toThrow();
			expect(() => op('-', ref('a'), ref('b'))).not.toThrow();
			expect(() => op('*', ref('a'), ref('b'))).not.toThrow();
			expect(() => op('/', ref('a'), ref('b'))).not.toThrow();
		});

		it('should support pgvector operators', () => {
			expect(() => op('<=>', ref('v'), ref('w'))).not.toThrow();
			expect(() => op('<->', ref('v'), ref('w'))).not.toThrow();
			expect(() => op('<#>', ref('v'), ref('w'))).not.toThrow();
		});
	});

	describe('fn()', () => {
		it('should create CustomFnExpressionIntent with no args', () => {
			const f = fn('now');
			expect(f.intent).toEqual({
				kind: 'customFn',
				name: 'now',
				args: [],
			} satisfies CustomFnExpressionIntent);
		});

		it('should handle schema-qualified names (paradedb.score)', () => {
			const f = fn('paradedb.score', ref('id'));
			const intent = f.intent as CustomFnExpressionIntent;
			expect(intent.name).toBe('paradedb.score');
			expect(intent.args).toHaveLength(1);
		});

		it('should apply implicit conversion on args: string → ref', () => {
			const f = fn('my_func', 'col');
			expect((f.intent as CustomFnExpressionIntent).args[0]).toEqual({
				kind: 'ref',
				column: 'col',
			});
		});

		it('should apply implicit conversion on args: number → inlined literal', () => {
			const f = fn('my_func', 42);
			expect((f.intent as CustomFnExpressionIntent).args[0]).toEqual({
				kind: 'literal',
				value: 42,
			});
		});

		it('should apply implicit conversion on multiple args', () => {
			const f = fn('my_func', 'col', 42);
			const args = (f.intent as CustomFnExpressionIntent).args;
			expect(args[0]).toEqual({ kind: 'ref', column: 'col' });
			expect(args[1]).toEqual({ kind: 'literal', value: 42 });
		});

		it('should throw on empty name', () => {
			expect(() => fn('')).toThrow('Invalid function');
		});

		it('should throw on name with SQL injection', () => {
			expect(() => fn("'; DROP TABLE users; --")).toThrow('Invalid function');
		});

		it('should throw on name starting with digit', () => {
			expect(() => fn('123func')).toThrow('Invalid function');
		});

		it('should support ST_ prefixed GIS functions', () => {
			expect(() => fn('ST_Distance', ref('geom'), param([0, 0]))).not.toThrow();
		});

		describe('fn(name, distinct(field)) — #247', () => {
			it('should route through customFn with distinct:true, not bind distinct() as a param', () => {
				const f = fn('count', distinct('id'));
				expect(f.intent).toEqual({
					kind: 'customFn',
					name: 'count',
					args: [{ kind: 'ref', column: 'id' }],
					distinct: true,
				} satisfies CustomFnExpressionIntent);
			});

			it('should work for sum/avg/min/max, not just count', () => {
				expect(fn('sum', distinct('amount')).intent).toMatchObject({
					kind: 'customFn',
					name: 'sum',
					distinct: true,
				});
				expect(fn('avg', distinct('amount')).intent).toMatchObject({
					kind: 'customFn',
					name: 'avg',
					distinct: true,
				});
				expect(fn('min', distinct('amount')).intent).toMatchObject({
					kind: 'customFn',
					name: 'min',
					distinct: true,
				});
				expect(fn('max', distinct('amount')).intent).toMatchObject({
					kind: 'customFn',
					name: 'max',
					distinct: true,
				});
			});

			it('should support distinct() combined with another arg (e.g. string_agg separator)', () => {
				const f = fn('string_agg', distinct('name'), literal(','));
				expect(f.intent).toEqual({
					kind: 'customFn',
					name: 'string_agg',
					args: [
						{ kind: 'ref', column: 'name' },
						{ kind: 'literal', value: ',' },
					],
					distinct: true,
				} satisfies CustomFnExpressionIntent);
			});

			it('should support distinct() with any function name — no whitelist (e.g. array_agg)', () => {
				expect(fn('array_agg', distinct('name')).intent).toMatchObject({
					kind: 'customFn',
					name: 'array_agg',
					distinct: true,
				});
			});

			it('should throw when distinct() appears more than once in the same call', () => {
				expect(() => fn('foo', distinct('a'), distinct('b'))).toThrow(
					/distinct\(\) is only supported as the first argument/,
				);
			});

			it('should throw when distinct() is not the first argument — SQL DISTINCT applies to the whole call, not one position', () => {
				expect(() => fn('string_agg', literal(','), distinct('name'))).toThrow(
					/distinct\(\) is only supported as the first argument/,
				);
			});

			it("should throw on distinct('*') — DISTINCT on '*' is not valid SQL for any function name (#247 finding 4)", () => {
				expect(() => fn('count', distinct('*'))).toThrow(
					/DISTINCT on '\*' is not valid SQL/,
				);
				expect(() => fn('array_agg', distinct('*'))).toThrow(
					/DISTINCT on '\*' is not valid SQL/,
				);
			});

			it('preserves the caller-supplied name verbatim (customFn is not handler-registry-keyed, unlike the old aggregate detour)', () => {
				expect(fn('Count', distinct('id')).intent).toMatchObject({
					name: 'Count',
				});
				expect(fn('SUM', distinct('amount')).intent).toMatchObject({
					name: 'SUM',
				});
			});
		});
	});

	describe('literal()', () => {
		it('should create LiteralExpressionIntent for number', () => {
			const l = literal(42);
			expect(l.intent).toEqual({
				kind: 'literal',
				value: 42,
			} satisfies LiteralExpressionIntent);
		});

		it('should handle null', () => {
			const l = literal(null);
			expect(l.intent).toEqual({ kind: 'literal', value: null });
		});

		it('should handle string (SQL string literal, not column ref)', () => {
			const l = literal('text');
			expect(l.intent).toEqual({ kind: 'literal', value: 'text' });
		});

		it('should handle boolean', () => {
			const l = literal(true);
			expect(l.intent).toEqual({ kind: 'literal', value: true });
		});

		it('should handle float', () => {
			const l = literal(3.14);
			expect((l.intent as LiteralExpressionIntent).value).toBe(3.14);
		});
	});

	describe('unary()', () => {
		it('should create UnaryExpressionIntent', () => {
			const u = unary('NOT', ref('active'));
			expect(u.intent).toEqual({
				kind: 'unary',
				operator: 'NOT',
				operand: { kind: 'ref', column: 'active' },
			} satisfies UnaryExpressionIntent);
		});

		it('should apply implicit conversion: string → ref', () => {
			const u = unary('-', 'score');
			expect((u.intent as UnaryExpressionIntent).operand).toEqual({
				kind: 'ref',
				column: 'score',
			});
		});

		it('should throw on empty operator', () => {
			expect(() => unary('', ref('col'))).toThrow('Invalid operator');
		});

		it('should throw on operator with spaces', () => {
			expect(() => unary('IS NOT', ref('col'))).toThrow('Invalid operator');
		});
	});

	describe('ExpressionRef chaining', () => {
		it('.as() should return new ExpressionRef with alias', () => {
			const r = ref('col');
			const aliased = r.as('my_alias');
			expect(aliased).not.toBe(r); // new instance
			expect(aliased).toBeInstanceOf(ExpressionRef);
			expect((aliased.intent as RefExpressionIntent & { as?: string }).as).toBe(
				'my_alias',
			);
		});

		it('.as() should not mutate original', () => {
			const r = ref('col');
			r.as('alias');
			expect(
				(r.intent as RefExpressionIntent & { as?: string }).as,
			).toBeUndefined();
		});

		it('.eq() should return WhereExpressionIntent', () => {
			const where = ref('status').eq('active');
			expect(where).toEqual({
				kind: 'expression',
				expr: { kind: 'ref', column: 'status' },
				operator: 'eq',
				value: 'active',
			} satisfies WhereExpressionIntent);
		});

		it('.neq() should return WhereExpressionIntent', () => {
			const where = ref('status').neq('deleted');
			expect(where.kind).toBe('expression');
			expect(where.operator).toBe('neq');
			expect(where.value).toBe('deleted');
		});

		it('.gt() should return WhereExpressionIntent', () => {
			const where = ref('score').gt(0);
			expect(where.operator).toBe('gt');
		});

		it('.gte() should return WhereExpressionIntent with correct fields', () => {
			const expr = op('<=>', ref('v'), cast(param([0.1]), 'vector'));
			const where = expr.gte(0.5);
			expect(where.kind).toBe('expression');
			expect(where.operator).toBe('gte');
			expect(where.value).toBe(0.5);
			expect(where.expr).toBe(expr.intent);
		});

		it('.lt() should return WhereExpressionIntent', () => {
			const where = op('<->', 'v', [0.1]).lt(1.0);
			expect(where.operator).toBe('lt');
		});

		it('.lte() should return WhereExpressionIntent', () => {
			const where = op('<->', 'v', [0.1]).lte(1.0);
			expect(where.operator).toBe('lte');
		});

		it('implements ExpressionSpec duck-type (symbol marker + intent)', () => {
			const r = ref('col');
			expect(r[EXPRESSION_BRAND]).toBe(true);
			expect('intent' in r).toBe(true);
		});
	});

	describe('nested expressions', () => {
		it('should build cosine similarity expression tree (1 - dist)', () => {
			// 1 - (vector <=> $1::vector)
			const expr = op(
				'-',
				literal(1),
				op('<=>', ref('vector'), cast(param([0.1, 0.2]), 'vector')),
			);
			expect(expr.intent.kind).toBe('customOp');
			const intent = expr.intent as CustomOpExpressionIntent;
			expect(intent.operator).toBe('-');
			expect(intent.left.kind).toBe('literal');
			expect((intent.left as LiteralExpressionIntent).value).toBe(1);
			expect(intent.right.kind).toBe('customOp');
			const innerOp = intent.right as CustomOpExpressionIntent;
			expect(innerOp.operator).toBe('<=>');
			expect(innerOp.left).toEqual({ kind: 'ref', column: 'vector' });
			expect(innerOp.right.kind).toBe('cast');
			const castIntent = innerOp.right as CastExpressionIntent;
			expect(castIntent.typeName).toBe('vector');
			expect((castIntent.expr as ParamExpressionIntent).value).toEqual([
				0.1, 0.2,
			]);
		});

		it('should support col-vs-col expression (no params)', () => {
			const expr = op('<=>', ref('e1.v'), ref('e2.v'));
			const intent = expr.intent as CustomOpExpressionIntent;
			expect(intent.left).toEqual({ kind: 'ref', column: 'e1.v' });
			expect(intent.right).toEqual({ kind: 'ref', column: 'e2.v' });
		});

		it('should support deeply nested fn wrapping op', () => {
			const dist = op('<=>', ref('vec'), cast(param([0.1]), 'vector'));
			const expr = fn('ABS', dist);
			const intent = expr.intent as CustomFnExpressionIntent;
			expect(intent.name).toBe('ABS');
			expect(intent.args[0]?.kind).toBe('customOp');
		});
	});
});

// ============================================================================
// namedArg()
// ============================================================================

describe('namedArg()', () => {
	it('creates a namedArg intent with the correct kind and name', () => {
		const expr = namedArg('field', literal('name_searchable'));
		const intent = expr.intent as NamedArgExpressionIntent;
		expect(intent.kind).toBe('namedArg');
		expect(intent.name).toBe('field');
	});

	it('returns an ExpressionRef', () => {
		expect(namedArg('query_string', param('hello'))).toBeInstanceOf(
			ExpressionRef,
		);
	});

	it('wraps a literal value — intent.value is LiteralExpressionIntent', () => {
		const expr = namedArg('field', literal('my_column'));
		const intent = expr.intent as NamedArgExpressionIntent;
		expect(intent.value.kind).toBe('literal');
		expect((intent.value as { kind: string; value: unknown }).value).toBe(
			'my_column',
		);
	});

	it('wraps a param value — intent.value is ParamExpressionIntent', () => {
		const expr = namedArg('query_string', param('search term'));
		const intent = expr.intent as NamedArgExpressionIntent;
		expect(intent.value.kind).toBe('param');
		expect((intent.value as { kind: string; value: unknown }).value).toBe(
			'search term',
		);
	});

	it('accepts an ExpressionRef as value (unwraps .intent)', () => {
		const inner = literal('col');
		const expr = namedArg('field', inner);
		const intent = expr.intent as NamedArgExpressionIntent;
		expect(intent.value.kind).toBe('literal');
	});

	it('accepts a string shorthand as value — becomes RefExpressionIntent', () => {
		const expr = namedArg('field', 'my_column');
		const intent = expr.intent as NamedArgExpressionIntent;
		expect(intent.value.kind).toBe('ref');
		expect((intent.value as { kind: string; column: string }).column).toBe(
			'my_column',
		);
	});

	it('can be used as fn() argument — composes correctly', () => {
		const expr = fn(
			'paradedb.parse',
			namedArg('field', literal('name')),
			namedArg('query_string', param('hello')),
		);
		const intent = expr.intent as CustomFnExpressionIntent;
		expect(intent.kind).toBe('customFn');
		expect(intent.name).toBe('paradedb.parse');
		expect(intent.args).toHaveLength(2);
		expect(intent.args[0]?.kind).toBe('namedArg');
		expect(intent.args[1]?.kind).toBe('namedArg');
	});

	it('throws on invalid name (injection guard)', () => {
		expect(() => namedArg("'; DROP TABLE--", literal(1))).toThrow(
			"namedArg: invalid argument name: '; DROP TABLE--",
		);
	});

	it('throws on empty name', () => {
		expect(() => namedArg('', literal(1))).toThrow(
			'namedArg: invalid argument name: ',
		);
	});
});

// ============================================================================
// star()
// ============================================================================

describe('star()', () => {
	it('should create StarExpressionIntent', () => {
		expect(star().intent).toEqual({
			kind: 'star',
		} satisfies StarExpressionIntent);
	});

	it('should return an ExpressionRef', () => {
		expect(star()).toBeInstanceOf(ExpressionRef);
	});

	it('should set expression symbol marker', () => {
		expect(star()[EXPRESSION_BRAND]).toBe(true);
	});

	it('composes with fn() for COUNT(*) pattern', () => {
		const expr = fn('count', star());
		const intent = expr.intent as CustomFnExpressionIntent;
		expect(intent.kind).toBe('customFn');
		expect(intent.name).toBe('count');
		expect(intent.args).toHaveLength(1);
		expect(intent.args[0]).toEqual({
			kind: 'star',
		} satisfies StarExpressionIntent);
	});
});

// ============================================================================
// array()
// ============================================================================

describe('array()', () => {
	it('should create ArrayExpressionIntent with elements', () => {
		const a = array(literal(1), literal(2));
		const intent = a.intent as ArrayExpressionIntent;
		expect(intent.kind).toBe('array');
		expect(intent.elements).toHaveLength(2);
	});

	it('should return an ExpressionRef', () => {
		expect(array(literal(1))).toBeInstanceOf(ExpressionRef);
	});

	it('should apply implicit conversion: string → ref', () => {
		const a = array('col');
		const elements = (a.intent as ArrayExpressionIntent).elements;
		expect(elements[0]).toEqual({ kind: 'ref', column: 'col' });
	});

	it('should apply implicit conversion: number → inlined literal', () => {
		const a = array(42);
		const elements = (a.intent as ArrayExpressionIntent).elements;
		expect(elements[0]).toEqual({ kind: 'literal', value: 42 });
	});

	it('should apply implicit conversion for mixed inputs', () => {
		const a = array('col', 42);
		const elements = (a.intent as ArrayExpressionIntent).elements;
		expect(elements[0]).toEqual({ kind: 'ref', column: 'col' });
		expect(elements[1]).toEqual({ kind: 'literal', value: 42 });
	});

	it('should wrap ExpressionRef elements directly', () => {
		const a = array(literal(1), literal(2), literal(3));
		const elements = (a.intent as ArrayExpressionIntent).elements;
		expect(elements[0]).toEqual({ kind: 'literal', value: 1 });
		expect(elements[1]).toEqual({ kind: 'literal', value: 2 });
		expect(elements[2]).toEqual({ kind: 'literal', value: 3 });
	});

	it('should accept zero elements', () => {
		const a = array();
		const intent = a.intent as ArrayExpressionIntent;
		expect(intent.elements).toHaveLength(0);
	});

	it('composes with fn() for unnest(ARRAY[...]) pattern', () => {
		const expr = fn('unnest', array(literal(1), literal(2)));
		const intent = expr.intent as CustomFnExpressionIntent;
		expect(intent.name).toBe('unnest');
		expect(intent.args[0]?.kind).toBe('array');
	});
});

// ============================================================================
// toExpressionIntent — duck-type path (factory-branded expression objects)
// ============================================================================

describe('coerceReference duck-type path', () => {
	it('should handle a factory-branded expression object as op() left operand', () => {
		// Use a factory-created operand.
		const plainExprSpec = ref('subq_col');
		const result = op('=', plainExprSpec as unknown as ExpressionRef, ref('x'));
		const intent =
			result.intent as import('../intent-ast.js').CustomOpExpressionIntent;
		expect(intent.left).toEqual({ kind: 'ref', column: 'subq_col' });
	});

	it('should handle a factory-branded expression object as op() right operand', () => {
		const plainExprSpec = param(42);
		const result = op(
			'=',
			ref('id'),
			plainExprSpec as unknown as ExpressionRef,
		);
		const intent =
			result.intent as import('../intent-ast.js').CustomOpExpressionIntent;
		expect(intent.right).toEqual({ kind: 'param', value: 42 });
	});

	it('should handle a factory-branded expression object as fn() argument', () => {
		const plainExprSpec = literal(99);
		const result = fn('abs', plainExprSpec as unknown as ExpressionRef);
		const intent =
			result.intent as import('../intent-ast.js').CustomFnExpressionIntent;
		expect(intent.args[0]).toEqual({ kind: 'literal', value: 99 });
	});

	it('should inline a finite number as a literal intent', () => {
		const result = op('=', ref('score'), 99);
		const intent =
			result.intent as import('../intent-ast.js').CustomOpExpressionIntent;
		expect(intent.right).toEqual({ kind: 'literal', value: 99 });
	});
});

// ============================================================================
// ExpressionRef.filter() — error path when called on non-customFn expression
// ============================================================================

describe('ExpressionRef.filter() on non-customFn', () => {
	it('should throw when called on a ref expression', () => {
		const r = ref('col');
		expect(() =>
			r.filter({} as unknown as Parameters<typeof r.filter>[0]),
		).toThrow(
			"filter() can only be used on function expressions created with fn(). Got kind: 'ref'",
		);
	});

	it('should throw when called on a param expression', () => {
		const p = param(1);
		expect(() =>
			p.filter({} as unknown as Parameters<typeof p.filter>[0]),
		).toThrow(
			"filter() can only be used on function expressions created with fn(). Got kind: 'param'",
		);
	});

	it('should throw when called on a cast expression', () => {
		const c = cast(param(1), 'int');
		expect(() =>
			c.filter({} as unknown as Parameters<typeof c.filter>[0]),
		).toThrow(
			"filter() can only be used on function expressions created with fn(). Got kind: 'cast'",
		);
	});

	it('should throw when called on an op expression', () => {
		const o = op('=', ref('a'), ref('b'));
		expect(() =>
			o.filter({} as unknown as Parameters<typeof o.filter>[0]),
		).toThrow(
			"filter() can only be used on function expressions created with fn(). Got kind: 'customOp'",
		);
	});

	it('should NOT throw when called on a fn(name, distinct(field)) expression — #247', () => {
		const a = fn('count', distinct('id'));
		const condition = {} as unknown as Parameters<typeof a.filter>[0];
		expect(() => a.filter(condition)).not.toThrow();
		expect(a.filter(condition).intent).toMatchObject({
			kind: 'customFn',
			filter: condition,
		});
	});
});

// ============================================================================
// Reference-leaf refusals (ADR 0011, delivery 1)
// ============================================================================

describe('expression-constructor leaf refusals (ADR 0011)', () => {
	const leafDb = schema({
		users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			score: 'integer',
			user_id: schemaRef('users', { as: 'author' }),
		},
	});
	const orm = createOrm({ schema: leafDb, adapter: createMockAdapter() });
	const posts = orm.tables.posts;
	const OBJECT_HINT =
		'is not an expression argument; use literal(null), param(value) or an expression';

	function thrown(build: () => unknown): unknown {
		try {
			build();
		} catch (error) {
			return error;
		}
		throw new Error('expected a refusal, got none');
	}

	function expectNotYet(
		build: () => unknown,
		construct: string,
		issue: number,
		position = 'expression argument',
	): void {
		const error = thrown(build);
		expect(error).toBeInstanceOf(NotYetSupportedError);
		expect(error).toMatchObject({
			construct,
			position,
			issue,
			message: `${construct} in ${position === 'expression argument' ? 'an' : 'a'} ${position} is not supported yet (#${issue}).`,
		});
	}

	function expectInvalid(build: () => unknown, message: string): void {
		const error = thrown(build);
		expect(error).toBeInstanceOf(InvalidOperationError);
		expect((error as Error).message).toBe(message);
	}

	it('R1 outerref: outerRef() in fn() is not yet supported (#1029)', () => {
		expectNotYet(() => fn('abs', outerRef('id') as never), 'outerRef()', 1029);
	});

	it('R7 outerRef in CASE and cast: not yet supported (#1029, #1034)', () => {
		expectNotYet(
			() => caseWhen(eq('score', 1), outerRef('id') as never),
			'outerRef()',
			1029,
		);
		expectNotYet(
			() => cast(outerRef('id') as never, 'text'),
			'outerRef()',
			1029,
		);
	});

	it('R2 relation-columnref: a relation-reached ColumnRef in fn() is not yet supported (#1052)', () => {
		expectNotYet(
			() => fn('upper', posts.author.name),
			'a relation-reached ColumnRef',
			1052,
		);
	});

	const NOT_A_SUBQUERY =
		'this builder is not a subquery; use orm.select(...), subquery(table) or a SubqueryExpression';
	const bodyIntent = {
		type: 'select' as const,
		from: 'posts',
		select: { type: 'fields' as const, fields: ['id'] },
	};

	it.each([
		['update', () => orm.update('posts').set({ title: 'x' })],
		['insert', () => orm.insert('posts').values({ id: 1, title: 'x' })],
		['upsert', () => orm.upsert('posts').values({ id: 1, title: 'x' })],
		['delete', () => orm.delete('posts').where(eq('id', 1))],
		[
			'union',
			() =>
				orm
					.select('posts')
					.columns(['id'])
					.union(orm.select('posts').columns(['id'])),
		],
		[
			'recursive',
			() =>
				orm.recursive('t', {
					base: orm.select('posts').columns(['id']),
					step: orm.select('posts').columns(['id']),
				}),
		],
	] as const)(
		'R1 non-select builder (%s): refused by name in fn() (ADR 0011 delivery 5)',
		(_name, builder) => {
			expectInvalid(
				() => fn('abs', builder() as never),
				`Invalid fn: ${NOT_A_SUBQUERY}`,
			);
		},
	);

	it('R3 structural builder objects: refused by name in fn(), never compiled (ADR 0011 delivery 5)', () => {
		expectInvalid(
			() => fn('abs', { buildIntent: () => bodyIntent } as never),
			`Invalid fn: ${NOT_A_SUBQUERY}`,
		);
		expectInvalid(
			() =>
				fn('abs', {
					buildIntent: () => bodyIntent,
					buildSubqueryIntent: () => bodyIntent,
				} as never),
			`Invalid fn: ${NOT_A_SUBQUERY}`,
		);
	});

	it('R4 sql-marker: a sql() marker in fn() is refused by name', () => {
		expectInvalid(
			() => fn('f', sql('now()') as never),
			'Invalid fn: sql() is only accepted as an update or upsert value; use literal(), param() or an expression here',
		);
	});

	it('R5 null: null in fn() is refused', () => {
		expectInvalid(
			() => fn('coalesce', ref('title'), null as never),
			`Invalid fn: null ${OBJECT_HINT}`,
		);
	});

	it('R5 undefined: undefined in fn() is refused', () => {
		expectInvalid(
			() => fn('f', undefined as never),
			`Invalid fn: undefined ${OBJECT_HINT}`,
		);
	});

	it('R5 plain-object: a plain object in fn() is refused', () => {
		expectInvalid(
			() => fn('f', { a: 1 } as never),
			`Invalid fn: a plain object ${OBJECT_HINT}`,
		);
	});

	it('R7 hand-built-intent: a hand-built intent in fn() is refused as a plain object', () => {
		expectInvalid(
			() => fn('f', { kind: 'param', value: 1 } as never),
			`Invalid fn: a plain object ${OBJECT_HINT}`,
		);
	});

	it('R6 op: a plain object operand in op() is refused', () => {
		expectInvalid(
			() => op('+', ref('score'), { a: 1 } as never),
			`Invalid op: a plain object ${OBJECT_HINT}`,
		);
	});

	it('R6 boolFn: a sql() marker in boolFn() is refused', () => {
		expectInvalid(
			() => boolFn('f', sql('now()') as never),
			'Invalid boolFn: sql() is only accepted as an update or upsert value; use literal(), param() or an expression here',
		);
	});

	it('R6 unary: null in unary() is refused', () => {
		expectInvalid(
			() => unary('-', null as never),
			`Invalid unary: null ${OBJECT_HINT}`,
		);
	});

	it('R6 namedArg: a plain object in namedArg() is refused', () => {
		expectInvalid(
			() => namedArg('x', { a: 1 } as never),
			`Invalid namedArg: a plain object ${OBJECT_HINT}`,
		);
	});

	it('R6 array: undefined in array() is refused', () => {
		expectInvalid(
			() => array(1, undefined as never),
			`Invalid array: undefined ${OBJECT_HINT}`,
		);
	});

	it('R6 cast: null in cast() is an InvalidOperationError, not a TypeError', () => {
		expectInvalid(
			() => cast(null as never, 'text'),
			`Invalid cast: null ${OBJECT_HINT}`,
		);
	});

	it('R6 arrayAgg: a plain object in arrayAgg() is refused', () => {
		expectInvalid(
			() => arrayAgg({ a: 1 } as never),
			`Invalid arrayAgg: a plain object ${OBJECT_HINT}`,
		);
	});

	it('R6 case-undefined: an undefined CASE result is refused instead of NULL', () => {
		expectInvalid(
			() => caseWhen(eq('score', 1), undefined as never),
			`Invalid caseWhen: undefined ${OBJECT_HINT}`,
		);
		expectInvalid(
			() =>
				caseWhen(eq('score', 1), 'title').when(
					eq('score', 2),
					undefined as never,
				),
			`Invalid caseWhen().when: undefined ${OBJECT_HINT}`,
		);
		expectInvalid(
			() => caseWhen(eq('score', 1), 'title').else(undefined as never),
			`Invalid caseWhen().else: undefined ${OBJECT_HINT}`,
		);
	});

	it.each(['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const)(
		'AC2x six ExpressionRef methods intents: %s stores a ColumnRef value as an ExpressionRef',
		(method) => {
			const intent = ref('score')[method](posts.id);
			expect(intent.value).toBeInstanceOf(ExpressionRef);
			expect((intent.value as ExpressionRef).intent).toEqual({
				kind: 'ref',
				column: 'posts.id',
			});
		},
	);

	it('R2 ExpressionRef method entry: non-select builders, sql() and relation ColumnRefs are refused', () => {
		expectInvalid(
			() => ref('score').eq(orm.update('posts').set({ title: 'x' }) as never),
			`Invalid ExpressionRef.eq: ${NOT_A_SUBQUERY}`,
		);
		expectInvalid(
			() => ref('score').gt(sql('now()')),
			'Invalid ExpressionRef.gt: sql() is only accepted as an update or upsert value; use literal(), param() or an expression here',
		);
		expectNotYet(
			() => ref('score').lt(posts.author.name),
			'a relation-reached ColumnRef',
			1052,
			'comparison value',
		);
	});
});
