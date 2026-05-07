import type { QueryIntent } from '@dbsp/core';
/**
 * generate-builder-ts.test.ts
 *
 * Unit tests for the playground TypeScript output generator.
 * Each test builds a QueryIntent manually and asserts specific fragments
 * appear (or do not appear) in the generated code string.
 * We do not pin exact whitespace — fragment inclusion is sufficient.
 */
import { describe, expect, it } from 'vitest';
import { generateBuilderTs } from './generate-builder-ts';

// ---------------------------------------------------------------------------
// Helpers — inline intent shapes used across multiple tests
// ---------------------------------------------------------------------------

function makeSelectIntent(
	from: string,
	overrides: Partial<QueryIntent> = {},
): QueryIntent {
	return { type: 'select', from, ...overrides };
}

// ---------------------------------------------------------------------------
// 1. Simple WHERE eq
// ---------------------------------------------------------------------------

describe('generateBuilderTs — simple where eq', () => {
	const intent = makeSelectIntent('users', {
		where: { kind: 'comparison', field: 'active', operator: 'eq', value: true },
		select: { type: 'fields', fields: ['id', 'name'] },
	});

	it('emits .select(table)', () => {
		expect(generateBuilderTs(intent)).toContain(".select('users')");
	});

	it('emits .where(eq(...))', () => {
		expect(generateBuilderTs(intent)).toContain(".where(eq('active', true))");
	});

	it('emits .columns([field, field])', () => {
		expect(generateBuilderTs(intent)).toContain(".columns(['id', 'name'])");
	});

	it('emits .all()', () => {
		expect(generateBuilderTs(intent)).toContain('.all()');
	});

	it('imports eq on the import line', () => {
		const out = generateBuilderTs(intent);
		// Must appear on the import line specifically, not just anywhere in the file
		const importLine =
			out.split('\n').find((l) => l.startsWith('import {')) ?? '';
		expect(importLine).toContain('eq');
	});

	it('does not emit double trailing semicolon', () => {
		const out = generateBuilderTs(intent);
		expect(out).not.toMatch(/\.all\(\);;/);
	});

	it('terminates with semicolon on .all()', () => {
		const out = generateBuilderTs(intent);
		expect(out).toMatch(/\.all\(\);/);
	});
});

// ---------------------------------------------------------------------------
// 2. neq operator (not 'ne')
// ---------------------------------------------------------------------------

describe('generateBuilderTs — neq operator', () => {
	const intent = makeSelectIntent('orders', {
		where: {
			kind: 'comparison',
			field: 'status',
			operator: 'neq',
			value: 'deleted',
		},
	});

	it('emits neq (not ne)', () => {
		expect(generateBuilderTs(intent)).toContain("neq('status', 'deleted')");
	});

	it('imports neq on the import line', () => {
		const out = generateBuilderTs(intent);
		const importLine =
			out.split('\n').find((l) => l.startsWith('import {')) ?? '';
		expect(importLine).toContain('neq');
	});
});

// ---------------------------------------------------------------------------
// 3. include + relationColumn projection
// ---------------------------------------------------------------------------

describe('generateBuilderTs — include with relationColumn', () => {
	const intent = makeSelectIntent('products', {
		include: [{ relation: 'category' }],
		select: {
			type: 'expressions',
			columns: [
				{ kind: 'column', column: 'name' },
				{
					kind: 'relationColumn',
					relation: 'category',
					column: 'name',
					as: 'categoryName',
				},
			],
		},
	});

	it("emits .include('category')", () => {
		expect(generateBuilderTs(intent)).toContain(".include('category')");
	});

	it('emits relationColumn(rel, col, alias)', () => {
		expect(generateBuilderTs(intent)).toContain(
			"relationColumn('category', 'name', 'categoryName')",
		);
	});

	it('imports relationColumn on the import line', () => {
		const out = generateBuilderTs(intent);
		const importLine =
			out.split('\n').find((l) => l.startsWith('import {')) ?? '';
		expect(importLine).toContain('relationColumn');
	});
});

// ---------------------------------------------------------------------------
// 4. groupBy + aggregate (array form for groupBy, chained methods)
// ---------------------------------------------------------------------------

describe('generateBuilderTs — groupBy + aggregate', () => {
	const intent = makeSelectIntent('orders', {
		groupBy: ['status'],
		select: {
			type: 'aggregate',
			fields: ['status'],
			aggregates: [
				{ function: 'count', as: 'order_count' },
				{ function: 'sum', field: 'amount', as: 'total_amount' },
			],
		},
	});

	it('emits .groupBy([...]) — array form, not spread', () => {
		expect(generateBuilderTs(intent)).toContain(".groupBy(['status'])");
	});

	it('does NOT emit old .groupBy(status) spread form', () => {
		expect(generateBuilderTs(intent)).not.toContain(".groupBy('status')");
	});

	it('emits .columns([status]) for non-aggregate fields', () => {
		expect(generateBuilderTs(intent)).toContain(".columns(['status'])");
	});

	it('emits .count({ as: alias }) for COUNT(*) with alias — NOT .count(alias) which would count a column', () => {
		// AggregateIntent has no field (or field='*') + has alias → options-object form
		// .count('alias') would mean COUNT(alias) WHERE alias IS NOT NULL, NOT COUNT(*) AS alias
		// Verified against query-builder.ts:268: count({ as }) branch
		expect(generateBuilderTs(intent)).toContain(
			".count({ as: 'order_count' })",
		);
		expect(generateBuilderTs(intent)).not.toContain(".count('order_count')");
	});

	it('emits .sum(field, alias) for SUM', () => {
		expect(generateBuilderTs(intent)).toContain(
			".sum('amount', 'total_amount')",
		);
	});

	it('does NOT emit old .columns({...}) object form', () => {
		expect(generateBuilderTs(intent)).not.toContain('.columns({');
	});
});

// ---------------------------------------------------------------------------
// 5. Pagination: limit + offset + orderBy
// ---------------------------------------------------------------------------

describe('generateBuilderTs — pagination', () => {
	const intent = makeSelectIntent('posts', {
		orderBy: [{ field: 'createdAt', direction: 'desc' }],
		limit: 10,
		offset: 20,
	});

	it('emits .limit(N)', () => {
		expect(generateBuilderTs(intent)).toContain('.limit(10)');
	});

	it('emits .offset(N)', () => {
		expect(generateBuilderTs(intent)).toContain('.offset(20)');
	});

	it("emits .orderBy('field', 'direction')", () => {
		expect(generateBuilderTs(intent)).toContain(
			".orderBy('createdAt', 'desc')",
		);
	});
});

// ---------------------------------------------------------------------------
// 6. like — pattern is properly escape-quoted via formatValue
// ---------------------------------------------------------------------------

describe('generateBuilderTs — like', () => {
	it('emits like(field, pattern) and imports like on the import line', () => {
		const intent = makeSelectIntent('users', {
			where: { kind: 'like', field: 'email', pattern: '%@example.com' },
		});
		const out = generateBuilderTs(intent);
		expect(out).toContain("like('email', '%@example.com')");
		const importLine =
			out.split('\n').find((l) => l.startsWith('import {')) ?? '';
		expect(importLine).toContain('like');
	});
});

// ---------------------------------------------------------------------------
// 7. like — single quote in pattern is properly escaped
// ---------------------------------------------------------------------------

describe('generateBuilderTs — like with single quote in pattern', () => {
	it('escapes single quote so output is syntactically valid', () => {
		const intent = makeSelectIntent('users', {
			where: { kind: 'like', field: 'name', pattern: "O'Brien%" },
		});
		const out = generateBuilderTs(intent);
		// The pattern string in output should contain the escaped form
		expect(out).toContain("\\'Brien%");
		// Must NOT contain the raw unescaped form that would break JS string parsing
		expect(out).not.toMatch(/like\('name', 'O'Brien%'\)/);
	});
});

// ---------------------------------------------------------------------------
// 8. inArray
// ---------------------------------------------------------------------------

describe('generateBuilderTs — inArray', () => {
	const intent = makeSelectIntent('users', {
		where: {
			kind: 'in',
			field: 'role',
			values: ['admin', 'moderator'],
		},
	});

	it("emits inArray('field', [v1, v2])", () => {
		expect(generateBuilderTs(intent)).toContain(
			"inArray('role', ['admin', 'moderator'])",
		);
	});

	it('imports inArray on the import line', () => {
		const out = generateBuilderTs(intent);
		const importLine =
			out.split('\n').find((l) => l.startsWith('import {')) ?? '';
		expect(importLine).toContain('inArray');
	});
});

// ---------------------------------------------------------------------------
// 9. inSubquery — comment placeholder, NO inSubquery in imports
// ---------------------------------------------------------------------------

describe('generateBuilderTs — inSubquery (comment placeholder)', () => {
	const intent = makeSelectIntent('users', {
		where: {
			kind: 'in',
			field: 'id',
			// A truthy subquery shape — just needs to be present
			subquery: {
				type: 'select',
				from: 'posts',
			} as unknown as import('@dbsp/core').WhereInIntent['subquery'],
			values: [],
		},
	});

	it('emits a comment referencing inSubquery', () => {
		expect(generateBuilderTs(intent)).toContain('inSubquery(');
	});

	it('does NOT add inSubquery to the imports line', () => {
		const out = generateBuilderTs(intent);
		const importLine = out.split('\n').find((l) => l.startsWith('import {'));
		expect(importLine ?? '').not.toContain('inSubquery');
	});
});

// ---------------------------------------------------------------------------
// 10. Mutation intent — graceful fallback, no crash
// ---------------------------------------------------------------------------

describe('generateBuilderTs — mutation graceful fallback', () => {
	it('returns a fallback message for non-select intents without crashing', () => {
		const mutationIntent = {
			type: 'insert',
			from: 'users',
		} as unknown as QueryIntent;
		const out = generateBuilderTs(mutationIntent);
		expect(out).toContain('Mutation builder TS view not yet implemented');
	});
});

// ---------------------------------------------------------------------------
// 11. COUNT(*) AS alias — options-object form locks correct semantics
// ---------------------------------------------------------------------------

describe('generateBuilderTs — COUNT(*) AS alias uses options-object form', () => {
	const intent = makeSelectIntent('events', {
		select: {
			type: 'aggregate',
			aggregates: [{ function: 'count', as: 'total' }],
		},
	});

	it('emits .count({ as: alias }) NOT .count(alias)', () => {
		// .count('total') would mean COUNT(total) WHERE total IS NOT NULL
		// .count({ as: 'total' }) means COUNT(*) AS total — verified query-builder.ts:268
		const out = generateBuilderTs(intent);
		expect(out).toContain(".count({ as: 'total' })");
		expect(out).not.toMatch(/\.count\('total'\)/);
	});

	it('emits .count() with no args when no alias', () => {
		const noAlias = makeSelectIntent('events', {
			select: { type: 'aggregate', aggregates: [{ function: 'count' }] },
		});
		expect(generateBuilderTs(noAlias)).toContain('.count()');
	});
});

// ---------------------------------------------------------------------------
// 12. COUNT(DISTINCT field) — wraps field in distinct() helper
// ---------------------------------------------------------------------------

describe('generateBuilderTs — COUNT(DISTINCT field)', () => {
	const intent = makeSelectIntent('orders', {
		select: {
			type: 'aggregate',
			aggregates: [
				{
					function: 'count',
					field: 'customer_id',
					distinct: true,
					as: 'unique_customers',
				},
			],
		},
	});

	it('emits .count(distinct(field), alias)', () => {
		// distinct() helper verified at filters.ts:102: distinct(field: string): DistinctField
		const out = generateBuilderTs(intent);
		expect(out).toContain(
			".count(distinct('customer_id'), 'unique_customers')",
		);
	});

	it('imports distinct on the import line', () => {
		const out = generateBuilderTs(intent);
		const importLine =
			out.split('\n').find((l) => l.startsWith('import {')) ?? '';
		expect(importLine).toContain('distinct');
	});
});

// ---------------------------------------------------------------------------
// 13. SUM(DISTINCT field) — wraps field in distinct() helper
// ---------------------------------------------------------------------------

describe('generateBuilderTs — SUM(DISTINCT field)', () => {
	it('emits .sum(distinct(field), alias) and imports distinct', () => {
		const intent = makeSelectIntent('payments', {
			select: {
				type: 'aggregate',
				aggregates: [
					{
						function: 'sum',
						field: 'amount',
						distinct: true,
						as: 'unique_sum',
					},
				],
			},
		});
		const out = generateBuilderTs(intent);
		expect(out).toContain(".sum(distinct('amount'), 'unique_sum')");
		const importLine =
			out.split('\n').find((l) => l.startsWith('import {')) ?? '';
		expect(importLine).toContain('distinct');
	});
});

// ---------------------------------------------------------------------------
// 14. col(column, alias) — column alias helper used for aliased fields
// ---------------------------------------------------------------------------

describe('generateBuilderTs — col() helper for aliased columns in expressions', () => {
	it('emits col(column, alias) and imports col for aliased expression columns', () => {
		// col() helper verified at filters.ts:834: col(column: string, alias: string): ExpressionSpec
		const intent = makeSelectIntent('users', {
			select: {
				type: 'expressions',
				columns: [
					{ kind: 'column', column: 'name', as: 'userName' },
					{ kind: 'column', column: 'id' },
				],
			},
		});
		const out = generateBuilderTs(intent);
		expect(out).toContain("col('name', 'userName')");
		// Plain column without alias is still a plain string
		expect(out).toContain("'id'");
		const importLine =
			out.split('\n').find((l) => l.startsWith('import {')) ?? '';
		expect(importLine).toContain('col');
	});
});

// ---------------------------------------------------------------------------
// 15. like() with escape option
// ---------------------------------------------------------------------------

describe('generateBuilderTs — like with escape option', () => {
	it('emits like(field, pattern, { escape }) when escape is set', () => {
		// like() verified at filters.ts:230: options?: boolean | { caseInsensitive?, escape? }
		const intent = makeSelectIntent('products', {
			where: { kind: 'like', field: 'code', pattern: '50%OFF', escape: '\\' },
		});
		const out = generateBuilderTs(intent);
		expect(out).toContain("like('code', '50%OFF', { escape: '\\\\' })");
	});

	it('emits like(field, pattern, { caseInsensitive, escape }) when both set', () => {
		const intent = makeSelectIntent('products', {
			where: {
				kind: 'like',
				field: 'code',
				pattern: '50%OFF',
				escape: '\\',
				caseInsensitive: true,
			},
		});
		const out = generateBuilderTs(intent);
		expect(out).toContain('caseInsensitive: true');
		expect(out).toContain("escape: '\\\\'");
	});
});

// ---------------------------------------------------------------------------
// 16. include() with extra fields: via, join, recursive
// ---------------------------------------------------------------------------

describe('generateBuilderTs — include() extra fields', () => {
	it('emits via option when present', () => {
		const intent = makeSelectIntent('posts', {
			include: [{ relation: 'author', via: 'created_by_fk' }],
		});
		const out = generateBuilderTs(intent);
		expect(out).toContain("via: 'created_by_fk'");
	});

	it("emits join: 'inner' option when join is inner", () => {
		const intent = makeSelectIntent('posts', {
			include: [{ relation: 'author', join: 'inner' }],
		});
		const out = generateBuilderTs(intent);
		expect(out).toContain("join: 'inner'");
	});

	it('emits recursive: true option when recursive is set', () => {
		const intent = makeSelectIntent('categories', {
			include: [
				{
					relation: 'children',
					recursive: {
						maxDepth: 5,
					} as unknown as import('@dbsp/core').IncludeIntent['recursive'],
				},
			],
		});
		const out = generateBuilderTs(intent);
		expect(out).toContain('recursive: true');
	});
});

// ---------------------------------------------------------------------------
// 17. orderBy — nulls option and expression fallback
// ---------------------------------------------------------------------------

describe('generateBuilderTs — orderBy nulls and expression', () => {
	it('emits nulls option when set', () => {
		const intent = makeSelectIntent('events', {
			orderBy: [{ field: 'startDate', direction: 'asc', nulls: 'last' }],
		});
		const out = generateBuilderTs(intent);
		expect(out).toContain("{ nulls: 'last' }");
	});

	it('emits comment when orderBy has expression instead of field', () => {
		const intent = makeSelectIntent('events', {
			orderBy: [
				{
					expression: {
						kind: 'raw',
						sql: 'RANDOM()',
					} as unknown as import('@dbsp/core').OrderByIntent['expression'],
					direction: 'asc',
				},
			],
		});
		const out = generateBuilderTs(intent);
		expect(out).toContain('/* .orderBy(<expression>');
	});

	it('emits safe comment when neither field nor expression', () => {
		const intent = makeSelectIntent('events', {
			orderBy: [
				{ direction: 'desc' } as unknown as import('@dbsp/core').OrderByIntent,
			],
		});
		const out = generateBuilderTs(intent);
		expect(out).toContain('unsupported orderBy intent');
	});
});
