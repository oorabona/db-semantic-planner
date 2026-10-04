import {
	createOrm,
	ResultHydrator,
	ref,
	relationColumn,
	schema,
} from '@dbsp/core';
import type { IncludePayloadShape } from '@dbsp/types';
import { expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const manyModel = schema({
	roots: { id: { type: 'integer', primaryKey: true } },
	children: {
		id: { type: 'integer', primaryKey: true },
		rootId: ref('roots', { inverse: 'children' }),
		amount: { type: 'bigint', js: 'number' },
	},
	leaves: {
		id: { type: 'integer', primaryKey: true },
		childId: ref('children', { inverse: 'leaves' }),
	},
}).model;
const model = manyModel;
const oneModel = schema({
	roots: { id: { type: 'integer', primaryKey: true } },
	children: {
		id: { type: 'integer', primaryKey: true },
		rootId: ref('roots', { inverse: 'children', unique: true }),
		amount: { type: 'bigint', js: 'number' },
	},
	leaves: {
		id: { type: 'integer', primaryKey: true },
		childId: ref('children', { inverse: 'leaves', unique: true }),
	},
}).model;
function compiled(
	from: 'roots' | 'children',
	relation: string,
	strategy: 'join' | 'json_agg' = 'json_agg',
) {
	const model = strategy === 'join' ? oneModel : manyModel;
	const adapter = createPgCompileOnlyAdapter({ model });
	const report = createOrm({ model, adapter })
		.select(from)
		.withPlanOptions({ defaultIncludeStrategy: strategy })
		.include(relation)
		.plan();
	const query = adapter.compile(report, { model });
	return {
		report,
		query,
		hydrate(rows: unknown[]) {
			const supply = (
				shape: IncludePayloadShape,
				row: Record<string, unknown>,
			) => {
				if (shape.presence)
					row[shape.presence.outputLabel] = row[`${shape.path}.id`] ?? null;
				for (const child of shape.children) supply(child, row);
			};
			for (const row of rows)
				if (row && typeof row === 'object')
					for (const shape of query.hydrationPlan?.includePayloads ?? [])
						supply(shape, row as Record<string, unknown>);
			const hydrator = new ResultHydrator(model, from);
			hydrator.hydrateJsonAggIncludes(rows, report, query);
			hydrator.hydrateJoinIncludes(rows, report, query);
			return rows;
		},
	};
}
for (const [name, value] of [
	['null', null],
	['undefined', undefined],
	['empty', []],
	['malformed JSON', '{'],
] as const) {
	it(`to-many ${name} has an empty collection`, () => {
		expect(
			compiled('roots', 'children').hydrate([{ children_json: value }]),
		).toEqual([{ children: [] }]);
	});
	it(`to-one ${name} has no related object`, () => {
		expect(
			compiled('children', 'roots').hydrate([{ root_json: value }]),
		).toEqual([{ roots: null }]);
	});
}
it('a to-one singleton collection becomes its related object', () => {
	expect(
		compiled('children', 'roots').hydrate([{ root_json: [{ id: 1 }] }]),
	).toEqual([{ roots: { id: 1 } }]);
});
it('JSON text retains exact related rows', () => {
	expect(
		compiled('roots', 'children').hydrate([
			{ children_json: '[{"id":2,"amount":"42"}]' },
		]),
	).toEqual([{ children: [{ id: 2, amount: 42 }] }]);
});
it('nested number overflow is refused', () => {
	expect(() =>
		compiled('roots', 'children').hydrate([
			{ children_json: [{ amount: '9007199254740993' }] },
		]),
	).toThrow(
		new RangeError(
			'Cannot convert PostgreSQL bigint column "children.amount" output key "amount" value "9007199254740993" to number: outside Number.MAX_SAFE_INTEGER; use js:\'bigint\' or omit js.',
		),
	);
});
it('unmatched joins have no related object', () => {
	expect(
		compiled('roots', 'children', 'join').hydrate([{ 'children.id': null }]),
	).toEqual([{ children: null }]);
});
it('an absent parent stays absent despite deeper related values', () => {
	expect(
		compiled('roots', 'children.leaves', 'join').hydrate([
			{
				'children.id': null,
				'children.leaves.id': 3,
			},
		]),
	).toEqual([{ children: null }]);
});
it('special relation names are own data properties', () => {
	const specialModel = schema({
		roots: { id: { type: 'integer', primaryKey: true } },
		children: {
			id: { type: 'integer', primaryKey: true },
			rootId: ref('roots', { inverse: '__proto__' }),
		},
	}).model;
	const adapter = createPgCompileOnlyAdapter({ model: specialModel });
	const report = createOrm({ model: specialModel, adapter })
		.select('roots')
		.include('__proto__')
		.plan();
	const query = adapter.compile(report, { model: specialModel });
	const rows = [{ __proto___json: [{ id: 2, rootId: 1 }] }];
	new ResultHydrator(specialModel, 'roots').hydrateJsonAggIncludes(
		rows,
		report,
		query,
	);
	expect(Object.getOwnPropertyDescriptor(rows[0], '__proto__')).toEqual({
		value: [{ id: 2, rootId: 1 }],
		enumerable: true,
		configurable: true,
		writable: true,
	});
	expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);
});

it('only owned JSON labels hydrate and absent labels leave rows unchanged', () => {
	const inherited = Object.assign(
		Object.create({ children_json: '[{"id":2}]' }),
		{ id: 1 },
	);
	const rows = [{ id: 1 }, inherited];
	expect(compiled('roots', 'children').hydrate(rows)).toEqual([
		{ id: 1 },
		{ id: 1 },
	]);
	expect(Object.hasOwn(inherited, 'children')).toBe(false);
});
it('only owned public scalar keys receive read conversions', () => {
	const child = Object.assign(Object.create({ amount: 'invalid' }), { id: 2 });
	expect(
		compiled('roots', 'children').hydrate([{ children_json: [child] }]),
	).toEqual([{ children: [{ id: 2 }] }]);
	expect(Object.hasOwn(child, 'amount')).toBe(false);
});
it('non-included child payloads and unowned scalar fields retain their values', () => {
	const children = [
		{
			id: 2,
			amount: '42',
			arbitrary: '9007199254740993',
			leaves: [{ id: 3, child_id: 2 }],
		},
	];
	expect(
		compiled('roots', 'children').hydrate([{ children_json: children }]),
	).toEqual([
		{
			children: [
				{
					id: 2,
					amount: 42,
					arbitrary: '9007199254740993',
					leaves: [{ id: 3, child_id: 2 }],
				},
			],
		},
	]);
});
it('nested to-one collections unwrap under the requested child key', () => {
	expect(
		compiled('roots', 'children.roots').hydrate([
			{ children_json: [{ id: 2, roots: [{ id: 1 }] }] },
		]),
	).toEqual([{ children: [{ id: 2, roots: { id: 1 } }] }]);
});
it('scalar payloads retain their values', () => {
	expect(compiled('roots', 'children').hydrate([{ children_json: 7 }])).toEqual(
		[{ children: 7 }],
	);
});
it('non-record rows remain untouched', () => {
	expect(compiled('roots', 'children').hydrate([null, 7])).toEqual([null, 7]);
});
it('a query without includes leaves every row untouched', () => {
	const adapter = createPgCompileOnlyAdapter({ model });
	const report = createOrm({ model, adapter }).select('roots').plan();
	const query = adapter.compile(report, { model });
	const rows = [{ id: 1, children_json: '[]', 'children.id': 2 }, null, 7];
	const hydrator = new ResultHydrator(model, 'roots');
	hydrator.hydrateJsonAggIncludes(rows, report, query);
	hydrator.hydrateJoinIncludes(rows, report, query);
	expect(rows).toEqual([
		{ id: 1, children_json: '[]', 'children.id': 2 },
		null,
		7,
	]);
});
it('unowned flat labels remain independent of included values', () => {
	expect(
		compiled('roots', 'children', 'join').hydrate([
			{ 'children.id': 2, 'other.id': 3, 'children.unowned': 4 },
		]),
	).toEqual([{ children: { id: 2 }, 'other.id': 3, 'children.unowned': 4 }]);
});
it('matched joins retain mixed null and present fields', () => {
	const model = oneModel;
	const adapter = createPgCompileOnlyAdapter({ model });
	const report = createOrm({ model, adapter })
		.select('roots')
		.withPlanOptions({ defaultIncludeStrategy: 'join' })
		.include('children.leaves')
		.columns([
			relationColumn('children', 'id', 'id'),
			relationColumn('children', 'amount', 'amount'),
			relationColumn('children.leaves', 'id', 'id'),
		])
		.plan();
	const query = adapter.compile(report, { model });
	const rows = [
		{
			'children.id': 2,
			'children.amount': null,
			'children.leaves.id': null,
			__dbsp_presence_children: 2,
			'__dbsp_presence_children.leaves': null,
		},
	];
	new ResultHydrator(model, 'roots').hydrateJoinIncludes(rows, report, query);
	expect(rows).toEqual([{ children: { id: 2, amount: null, leaves: null } }]);
});
it('several join and JSON includes coexist in one row', () => {
	const multiModel = schema({
		roots: { id: { type: 'integer', primaryKey: true } },
		a: {
			id: { type: 'integer', primaryKey: true },
			rootId: ref('roots', { inverse: 'a', unique: true }),
		},
		b: {
			id: { type: 'integer', primaryKey: true },
			rootId: ref('roots', { inverse: 'b', unique: true }),
		},
		c: {
			id: { type: 'integer', primaryKey: true },
			rootId: ref('roots', { inverse: 'c' }),
		},
		d: {
			id: { type: 'integer', primaryKey: true },
			rootId: ref('roots', { inverse: 'd' }),
		},
	}).model;
	const adapter = createPgCompileOnlyAdapter({ model: multiModel });
	const report = createOrm({ model: multiModel, adapter })
		.select('roots')
		.include('a', { join: 'left' })
		.include('b', { join: 'left' })
		.include('c')
		.include('d')
		.plan();
	const query = adapter.compile(report, { model: multiModel });
	const rows = [
		{
			id: 1,
			'a.id': 2,
			__dbsp_presence_a: 2,
			'b.id': null,
			__dbsp_presence_b: null,
			c_json: [{ id: 3, rootId: 1 }],
			d_json: '[{"id":4,"rootId":1}]',
		},
	];
	const hydrator = new ResultHydrator(multiModel, 'roots');
	hydrator.hydrateJsonAggIncludes(rows, report, query);
	hydrator.hydrateJoinIncludes(rows, report, query);
	expect(rows).toEqual([
		{
			id: 1,
			a: { id: 2 },
			b: null,
			c: [{ id: 3, rootId: 1 }],
			d: [{ id: 4, rootId: 1 }],
		},
	]);
});

it('root star and relation star retain distinct public labels', () => {
	const adapter = createPgCompileOnlyAdapter({ model });
	const report = createOrm({ model, adapter })
		.nql`roots | select *, children.* | flat`.plan();
	const query = adapter.compile(report, { model });
	expect(query.sql).toBe(
		'SELECT roots.*, children.id AS "children.id", children."rootId" AS "children.rootId", children.amount AS "children.amount" FROM roots LEFT JOIN children AS children ON roots.id = children."rootId"',
	);
	const rows = [
		{ id: 1, 'children.id': 2, 'children.rootId': 1, 'children.amount': '42' },
	];
	new ResultHydrator(model, 'roots').hydrateJoinIncludes(rows, report, query);
	expect(rows).toEqual([{ id: 1, children: { id: 2, rootId: 1, amount: 42 } }]);
});
it('explicit root output and relation star retain distinct public labels', () => {
	const adapter = createPgCompileOnlyAdapter({ model });
	const report = createOrm({ model, adapter })
		.nql`roots | select id, children.* | flat`.plan();
	const query = adapter.compile(report, { model });
	expect(query.sql).toBe(
		'SELECT roots.id, children.id AS "children.id", children."rootId" AS "children.rootId", children.amount AS "children.amount" FROM roots LEFT JOIN children AS children ON roots.id = children."rootId"',
	);
	const rows = [
		{ id: 1, 'children.id': 2, 'children.rootId': 1, 'children.amount': '42' },
	];
	new ResultHydrator(model, 'roots').hydrateJoinIncludes(rows, report, query);
	expect(rows).toEqual([{ id: 1, children: { id: 2, rootId: 1, amount: 42 } }]);
});
it('root star expands independently of include projection', () => {
	const adapter = createPgCompileOnlyAdapter({ model });
	expect(createOrm({ model, adapter }).nql`roots | select *`.dump().sql).toBe(
		'SELECT roots.* FROM roots',
	);
});

it('duplicate flat output labels are refused by their final key', () => {
	const adapter = createPgCompileOnlyAdapter({ model });
	expect(() =>
		createOrm({ model, adapter })
			.nql`roots | select children.id as x, children.amount as x | flat`.dump(),
	).toThrow(
		new Error(
			"Include payload 'children' has conflicting public key 'x' (column:id and column:amount).",
		),
	);
});
it('an explicit output colliding with a relation star label is refused', () => {
	const adapter = createPgCompileOnlyAdapter({ model });
	expect(() =>
		createOrm({ model, adapter })
			.nql`roots | select id as "children.id", children.* | flat`.dump(),
	).toThrow(
		new Error(
			"Include payload '$' has conflicting public key 'children.id' (column:id and generated:children:id).",
		),
	);
});
it('exotic declared scalar keys retain exact bigint values', () => {
	const exotic = schema({
		roots: { id: { type: 'integer', primaryKey: true } },
		children: {
			id: { type: 'integer', primaryKey: true },
			rootId: ref('roots', { inverse: 'children' }),
			parseJSON: { type: 'bigint', js: 'bigint' },
			toString: { type: 'bigint', js: 'bigint' },
		},
	}).model;
	const adapter = createPgCompileOnlyAdapter({
		model: exotic,
		dbCasing: 'snake_case',
	});
	const report = createOrm({ model: exotic, adapter })
		.select('roots')
		.include('children')
		.plan();
	const query = adapter.compile(report, { model: exotic });
	const rows = [
		{
			children_json: [
				{ parseJSON: '9007199254740993', toString: '9007199254740995' },
			],
		},
	];
	new ResultHydrator(exotic, 'roots').hydrateJsonAggIncludes(
		rows,
		report,
		query,
	);
	expect(rows).toEqual([
		{
			children: [{ parseJSON: 9007199254740993n, toString: 9007199254740995n }],
		},
	]);
});
it('non-bigint scalar keys retain their text despite stray js metadata', () => {
	const textModel = schema({
		roots: { id: { type: 'integer', primaryKey: true } },
		children: {
			id: { type: 'integer', primaryKey: true },
			rootId: ref('roots', { inverse: 'children' }),
			code: 'text',
		},
	}).model;
	const code = textModel
		.getTable('children')!
		.columns.find((column) => column.name === 'code')!;
	Object.assign(code, { js: 'bigint' });
	const adapter = createPgCompileOnlyAdapter({ model: textModel });
	const report = createOrm({ model: textModel, adapter })
		.select('roots')
		.include('children')
		.plan();
	const query = adapter.compile(report, { model: textModel });
	const rows = [{ children_json: [{ code: 'not-a-bigint' }] }];
	new ResultHydrator(textModel, 'roots').hydrateJsonAggIncludes(
		rows,
		report,
		query,
	);
	expect(rows).toEqual([{ children: [{ code: 'not-a-bigint' }] }]);
});

for (const strategy of ['json_agg', 'join', 'lateral'] as const) {
	it(`one source requested under two aliases returns both keys with ${strategy}`, () => {
		const model = strategy === 'join' ? oneModel : manyModel;
		const adapter = createPgCompileOnlyAdapter({ model });
		const report = createOrm({ model, adapter })
			.select('roots')
			.withPlanOptions({ defaultIncludeStrategy: strategy })
			.include('children')
			.columns([
				relationColumn('children', 'amount', 'a'),
				relationColumn('children', 'amount', 'b'),
			])
			.plan();
		const query = adapter.compile(report, { model });
		const rows: unknown[] =
			strategy === 'json_agg'
				? [{ children_json: [{ a: '42', b: '42' }] }]
				: [
						{
							'children.a': '42',
							'children.b': '42',
							__dbsp_presence_children: 1,
						},
					];
		const hydrator = new ResultHydrator(model, 'roots');
		hydrator.hydrateJsonAggIncludes(rows, report, query);
		hydrator.hydrateJoinIncludes(rows, report, query);
		expect(rows).toEqual(
			strategy === 'json_agg'
				? [{ children: [{ a: 42, b: 42 }] }]
				: [{ children: { a: 42, b: 42 } }],
		);
	});
}

it('unselected public scalar keys retain their raw values', () => {
	const adapter = createPgCompileOnlyAdapter({ model });
	const report = createOrm({ model, adapter })
		.select('roots')
		.include('children')
		.columns([relationColumn('children', 'id', 'id')])
		.plan();
	const query = adapter.compile(report, { model });
	const rows = [{ children_json: [{ id: 2, amount: '42' }] }];
	new ResultHydrator(model, 'roots').hydrateJsonAggIncludes(
		rows,
		report,
		query,
	);
	expect(rows).toEqual([{ children: [{ id: 2, amount: '42' }] }]);
});
it('top-level labels resembling nested relation outputs remain untouched', () => {
	expect(
		compiled('roots', 'children.leaves').hydrate([
			{
				children_json: [{ id: 2, leaves: [{ id: 3 }] }],
				leaves_json: 'independent',
			},
		]),
	).toEqual([
		{ children: [{ id: 2, leaves: [{ id: 3 }] }], leaves_json: 'independent' },
	]);
});
