import { createOrm, eq, plan, ref, schema } from '@dbsp/core';
import type { ModelIR, QueryIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	categories: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		parentId: ref('categories', {
			nullable: true,
			as: 'parent',
			inverse: 'children',
			roles: {
				parent: 'parent',
				children: 'children',
				ancestors: 'managementChain',
			},
		}),
	},
});
const adapter = createPgCompileOnlyAdapter({ model: db.model });
const orm = createOrm({ schema: db, adapter });
describe('#877 recursive includes', () => {
	for (const direction of ['ancestors', 'descendants'] as const)
		for (const maxDepth of [undefined, 3]) {
			it(`${direction} maxDepth=${maxDepth}`, () => {
				const query = orm
					.select('categories')
					.include(direction === 'ancestors' ? 'parent' : 'children', {
						recursive: true,
						direction,
						omitSelf: true,
						flat: true,
						...(maxDepth === undefined ? {} : { maxDepth }),
					})
					.dump();
				expect(query.sql).toMatchSnapshot();
				expect('params' in query && query.params).toEqual([]);
			});
		}
	it('exposes includeDepth under the public key without flat output', () => {
		const query = orm
			.select('categories')
			.include('children', {
				recursive: true,
				direction: 'descendants',
				omitSelf: true,
				includeDepth: true,
			})
			.dump();
		expect(query.sql).toMatchSnapshot();
	});
	it('NQL managementChain projection', () => {
		const query = orm.nql`categories | select name, managementChain.*`.dump();
		expect(query.sql).toMatchSnapshot();
		expect('params' in query && query.params).toEqual([]);
	});
});

describe('#877 recursive option refusals', () => {
	for (const [option, value] of [
		['foreignKey', 'parentId'],
		['track.path', true],
		['track.path', false],
		['track.depth.as', 'level'],
	] as const) {
		it(`refuses ${option}=${value}`, () => {
			const recursive =
				option === 'foreignKey'
					? { foreignKey: value as string }
					: option === 'track.path'
						? { track: { path: value as boolean } }
						: { track: { depth: { as: value as string } } };
			const plan = orm
				.select('categories')
				.include('children', { recursive: true, direction: 'descendants' })
				.plan();
			const intent = {
				...plan.intent!,
				include: [{ relation: 'children', recursive: { ...recursive } }],
			};
			const decisions = plan.decisions.map((d) =>
				d.type === 'include-strategy'
					? {
							...d,
							context: {
								...d.context,
								recursiveInclude: {
									...d.context.recursiveInclude!,
									...recursive,
								},
							},
						}
					: d,
			);
			expect(() => adapter.compile({ ...plan, intent, decisions })).toThrow(
				`Recursive include option ${option} is not supported`,
			);
		});
	}
	for (const maxDepth of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
		it(`refuses maxDepth ${maxDepth}`, () => {
			expect(() =>
				orm
					.select('categories')
					.include('children', {
						recursive: true,
						direction: 'descendants',
						maxDepth,
					})
					.dump(),
			).toThrow(
				'Recursive include option maxDepth must be a positive safe integer',
			);
		});
	it('refuses include', () => {
		expect(() =>
			orm
				.select('categories')
				.include('children', {
					recursive: true,
					direction: 'descendants',
					include: [{ relation: 'parent' }],
				})
				.dump(),
		).toThrow(/include/);
	});
	it('refuses select expressions', () => {
		expect(() =>
			orm
				.select('categories')
				.include('children', {
					recursive: true,
					direction: 'descendants',
					select: { type: 'expressions', columns: [] },
				})
				.dump(),
		).toThrow('Recursive include option select supports only fields or all');
	});
	it('refuses where', () => {
		expect(() =>
			orm
				.select('categories')
				.include('children', {
					recursive: true,
					direction: 'descendants',
					where: eq('id', 1),
				})
				.dump(),
		).toThrow(/where/);
	});
	it('refuses join', () => {
		expect(() =>
			orm
				.select('categories')
				.include('children', {
					recursive: true,
					direction: 'descendants',
					join: 'left',
				})
				.dump(),
		).toThrow(/join/);
	});
	for (const [option, value] of [
		['limit', 2],
		['orderBy', [{ field: 'name', direction: 'desc' }]],
	] as const)
		it(`refuses ${option}`, () => {
			const plan = orm
				.select('categories')
				.include('children', { recursive: true, direction: 'descendants' })
				.plan();
			const intent = {
				...plan.intent!,
				include: [{ ...plan.intent!.include![0]!, [option]: value }],
			};
			expect(() => adapter.compile({ ...plan, intent })).toThrow(
				`Recursive include option ${option} is not supported`,
			);
		});
});

describe('#877 shared plan/compile refusals', () => {
	const valid = () =>
		orm
			.select('categories')
			.include('children', { recursive: true, direction: 'descendants' })
			.plan();
	for (const [name, patch] of [
		['grouped or aggregated roots', { groupBy: ['id'] }],
		[
			'grouped or aggregated roots',
			{ select: { type: 'aggregate', aggregates: [{ function: 'count' }] } },
		],
		[
			'grouped or aggregated roots',
			{
				select: {
					type: 'expressions',
					columns: [
						{
							kind: 'function',
							name: 'abs',
							args: [{ kind: 'function', name: 'count', args: [] }],
						},
					],
				},
			},
		],
		['DISTINCT', { distinct: true }],
		['row locks', { lock: { strength: 'update', waitPolicy: 'block' } }],
	] as const)
		it(`refuses root ${JSON.stringify(patch)} in plan and compile`, () => {
			const report = valid();
			const intent = { ...report.intent!, ...patch };
			expect(() =>
				plan(intent as QueryIntent, db.model, {
					dialectCapabilities: adapter.dialectCapabilities,
				}),
			).toThrow(`Recursive include option ${name} is not supported`);
			expect(() =>
				adapter.compile({ ...report, intent: intent as QueryIntent }),
			).toThrow(`Recursive include option ${name} is not supported`);
		});
	for (const [name, patch] of [
		['where', { where: eq('id', 1) }],
		['limit', { limit: 2 }],
		['orderBy', { orderBy: [{ field: 'id', direction: 'asc' }] }],
		['include', { include: [{ relation: 'parent' }] }],
		[
			'select supports only fields or all',
			{ select: { type: 'expressions', columns: [] } },
		],
	] as const)
		it(`refuses include ${name} in plan and compile`, () => {
			const report = valid();
			const include = { ...report.intent!.include![0]!, ...patch };
			const intent = { ...report.intent!, include: [include] } as QueryIntent;
			expect(() =>
				plan(intent, db.model, {
					dialectCapabilities: adapter.dialectCapabilities,
				}),
			).toThrow(`Recursive include option ${name} is not supported`);
			expect(() => adapter.compile({ ...report, intent })).toThrow(
				`Recursive include option ${name} is not supported`,
			);
		});
	it('refuses a recursive include under an ordinary include', () => {
		const report = valid();
		const intent = {
			...report.intent!,
			include: [{ relation: 'parent', include: report.intent!.include }],
		} as QueryIntent;
		expect(() =>
			plan(intent, db.model, {
				dialectCapabilities: adapter.dialectCapabilities,
			}),
		).toThrow(
			'Recursive include option include does not support nested recursive includes is not supported',
		);
		const outer = orm.select('categories').include('parent').plan();
		expect(() =>
			adapter.compile({
				...outer,
				intent,
				decisions: [
					...outer.decisions,
					...report.decisions.map((d) => ({
						...d,
						context: { ...d.context, intentPath: 'include[0].include[0]' },
					})),
				],
			}),
		).toThrow(
			'Recursive include option include does not support nested recursive includes is not supported',
		);
	});
	it('refuses applicable traversed-node default filters in plan and dump', () => {
		const filtered = schema(
			{
				categories: {
					id: { type: 'integer', primaryKey: true },
					parentId: ref('categories', {
						nullable: true,
						roles: { parent: 'parent', children: 'children' },
					}),
				},
			},
			undefined,
			{ defaultFilters: { categories: eq('id', 1) } },
		);
		const query = createOrm({
			schema: filtered,
			adapter: createPgCompileOnlyAdapter({ model: filtered.model }),
		})
			.select('categories')
			.include('children', { recursive: true, direction: 'descendants' });
		expect(() => query.plan()).toThrow(
			'Recursive include with applicable defaultFilters on traversed nodes is not yet supported (#906).',
		);
		expect(() => query.dump()).toThrow(
			'Recursive include with applicable defaultFilters on traversed nodes is not yet supported (#906).',
		);
	});
	it('refuses set operations by name in NQL plan and adapter compile', () => {
		const query = orm.nql`categories | select managementChain.* | union (categories | select managementChain.*)`;
		expect(() => query.plan()).toThrow(
			'Recursive include option set operations is not supported',
		);
		expect(() => query.dump()).toThrow(
			'Recursive include option set operations is not supported',
		);
	});
	it('uses the declared non-id nullable referenced key and physical casing', () => {
		const keyed = schema({
			nodes: {
				id: { type: 'integer', primaryKey: true },
				nodeKey: { type: 'integer', nullable: true, unique: true },
				parentKey: ref('nodes', {
					references: ['nodeKey'],
					nullable: true,
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		});
		const result = createOrm({
			schema: keyed,
			adapter: createPgCompileOnlyAdapter({ model: keyed.model }),
		})
			.select('nodes')
			.include('tree', {
				via: 'children',
				recursive: true,
				direction: 'descendants',
				omitSelf: true,
				select: { type: 'fields', fields: ['id'] },
			})
			.dump();
		expect(result.sql).toMatchSnapshot();
		expect(result.sql).toContain('__n."parentKey" = nodes."nodeKey"');
		expect(result.sql).toContain('__n."nodeKey" IS NOT NULL');
	});
	it('refuses a missing referenced key instead of id fallback at both boundaries', () => {
		const relation = db.model.getRelation('categories.children')!;
		const model = {
			...db.model,
			getRelation: (name: string) =>
				name === 'categories.children'
					? { ...relation, sourceKey: undefined }
					: db.model.getRelation(name),
			getTable: db.model.getTable.bind(db.model),
			getRelationsFrom: db.model.getRelationsFrom.bind(db.model),
		} as ModelIR;
		const report = valid();
		expect(() =>
			plan(report.intent!, model, {
				dialectCapabilities: adapter.dialectCapabilities,
			}),
		).toThrow('Recursive include requires a declared referenced key');
		expect(() => createPgCompileOnlyAdapter({ model }).compile(report)).toThrow(
			'Recursive include requires a declared referenced key',
		);
	});
	it('refuses composite self references at both boundaries', () => {
		const relation = db.model.getRelation('categories.children')!;
		const model = {
			...db.model,
			getRelation: (name: string) =>
				name === 'categories.children'
					? {
							...relation,
							sourceKey: ['id', 'name'],
							foreignKey: ['parentId', 'name'],
						}
					: db.model.getRelation(name),
			getTable: db.model.getTable.bind(db.model),
			getRelationsFrom: db.model.getRelationsFrom.bind(db.model),
		} as ModelIR;
		const report = valid();
		expect(() =>
			plan(report.intent!, model, {
				dialectCapabilities: adapter.dialectCapabilities,
			}),
		).toThrow('Recursive include requires a single parentKey and foreignKey');
		expect(() => createPgCompileOnlyAdapter({ model }).compile(report)).toThrow(
			'Recursive include requires a single parentKey and foreignKey',
		);
	});
	it('refuses stored requested keys at root and every node, and supports via', () => {
		const colliding = schema({
			nodes: {
				id: { type: 'integer', primaryKey: true },
				children: 'string',
				parentId: ref('nodes', {
					nullable: true,
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		});
		const query = createOrm({
			schema: colliding,
			adapter: createPgCompileOnlyAdapter({ model: colliding.model }),
		}).select('nodes');
		expect(() =>
			query
				.include('children', { recursive: true, direction: 'descendants' })
				.dump(),
		).toThrow("conflicting public key 'children'");
		expect(() =>
			query
				.columns(['id'])
				.include('children', { recursive: true, direction: 'descendants' })
				.dump(),
		).toThrow("conflicting public key 'children'");
		expect(
			query
				.include('tree', {
					via: 'children',
					recursive: true,
					direction: 'descendants',
				})
				.dump().sql,
		).toMatchSnapshot();
	});
});

it('default nested ancestors includes a separate depth-zero self row and preserves root params', () => {
	const query = orm
		.select('categories')
		.where(eq('id', 4))
		.include('parent', { recursive: true, direction: 'ancestors' })
		.dump();
	expect(query.sql).toMatchSnapshot();
	expect(query.params).toEqual([4]);
});

it('default nested descendants includes a separate depth-zero self row and preserves root params', () => {
	const query = orm
		.select('categories')
		.where(eq('id', 4))
		.include('children', { recursive: true, direction: 'descendants' })
		.dump();
	expect(query.sql).toMatchSnapshot();
	expect(query.params).toEqual([4]);
});

it('preserves the ordinary non-recursive CTE include SQL and params', () => {
	const query = orm
		.select('categories')
		.withPlanOptions({ defaultIncludeStrategy: 'cte' })
		.include('children')
		.dump();
	expect(query.sql).toMatchSnapshot();
	expect(query.params).toEqual([]);
});

const storedDepth = schema({
	depthNodes: {
		id: { type: 'integer', primaryKey: true },
		depth: 'integer',
		__depth: 'integer',
		__visited: 'string',
		parentId: ref('depthNodes', {
			nullable: true,
			as: 'parent',
			inverse: 'children',
			roles: { parent: 'parent', children: 'children' },
		}),
	},
});
it('refuses a projected public depth collision by relation and column', () => {
	for (const options of [{ flat: true }, { includeDepth: true }])
		expect(() =>
			createOrm({
				schema: storedDepth,
				adapter: createPgCompileOnlyAdapter({ model: storedDepth.model }),
			})
				.select('depthNodes')
				.include('children', {
					recursive: true,
					direction: 'descendants',
					...options,
				})
				.dump(),
		).toThrow("conflicting public key 'depth'");
});

it('keeps stored depth and allocates internal columns around the complete model', () => {
	const query = createOrm({
		schema: storedDepth,
		adapter: createPgCompileOnlyAdapter({ model: storedDepth.model }),
	})
		.select('depthNodes')
		.include('children', {
			recursive: true,
			direction: 'descendants',
			omitSelf: true,
		})
		.dump();
	expect(query.sql).toMatchSnapshot();
	expect(query.params).toEqual([]);
});

it('allocates the inner alias when the root is __n', () => {
	const named = schema({
		__n: {
			id: { type: 'integer', primaryKey: true },
			name: 'string',
			parentId: ref('__n', {
				nullable: true,
				as: 'parent',
				inverse: 'children',
				roles: { parent: 'parent', children: 'children' },
			}),
		},
	});
	const query = createOrm({
		schema: named,
		adapter: createPgCompileOnlyAdapter({ model: named.model }),
	})
		.select('__n')
		.include('children', {
			recursive: true,
			direction: 'descendants',
			omitSelf: true,
			flat: true,
		})
		.dump();
	expect(query.sql).toMatchSnapshot();
	expect(query.params).toEqual([]);
});

it('uses the json_agg read policy to cast handled bigint ids and payload fields exactly', () => {
	const big = schema({
		categories: {
			id: { type: 'bigint', js: 'bigint', primaryKey: true },
			name: { type: 'bigint', js: 'string' },
			parentId: ref('categories', {
				js: 'bigint',
				nullable: true,
				as: 'parent',
				inverse: 'children',
				roles: { parent: 'parent', children: 'children' },
			}),
		},
	});
	const query = createOrm({
		schema: big,
		adapter: createPgCompileOnlyAdapter({ model: big.model }),
	})
		.select('categories')
		.include('children', {
			recursive: true,
			direction: 'descendants',
			omitSelf: true,
			flat: true,
		})
		.dump();
	expect(query.sql).toMatchSnapshot();
	expect(query.params).toEqual([]);
});

it('builds a 51-column payload in bounded chunks joined into one JSON object', () => {
	const fields = Object.fromEntries(
		Array.from({ length: 49 }, (_, i) => [`field${i}`, 'integer' as const]),
	);
	const wide = schema({
		wide: {
			id: { type: 'integer', primaryKey: true },
			...fields,
			parentId: ref('wide', {
				nullable: true,
				as: 'parent',
				inverse: 'children',
				roles: { parent: 'parent', children: 'children' },
			}),
		},
	});
	const query = createOrm({
		schema: wide,
		adapter: createPgCompileOnlyAdapter({ model: wide.model }),
	})
		.select('wide')
		.include('children', {
			recursive: true,
			direction: 'descendants',
			omitSelf: true,
			flat: true,
		})
		.dump();
	expect(query.sql).toMatchSnapshot();
	expect(query.params).toEqual([]);
});

it('refuses applicable default filters for NQL recursive pseudo-columns', () => {
	const filtered = schema(
		{
			nodes: {
				id: { type: 'integer', primaryKey: true },
				parentId: ref('nodes', {
					nullable: true,
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		},
		undefined,
		{ defaultFilters: { nodes: eq('id', 1) } },
	);
	const instance = createOrm({
		schema: filtered,
		adapter: createPgCompileOnlyAdapter({ model: filtered.model }),
	});
	expect(() => instance.nql`nodes | select ancestors.*`.plan()).toThrow(
		'Recursive include with applicable defaultFilters on traversed nodes is not yet supported (#906).',
	);
	expect(() => instance.nql`nodes | select ancestors.*`.dump()).toThrow(
		'Recursive include with applicable defaultFilters on traversed nodes is not yet supported (#906).',
	);
});
it('uses shared shortening for long requested keys and collision-free transport labels', () => {
	const query = orm
		.select('categories')
		.include('é'.repeat(40), {
			via: 'children',
			recursive: true,
			direction: 'descendants',
		})
		.include('é'.repeat(39) + 'a', {
			via: 'parent',
			recursive: true,
			direction: 'ancestors',
		});
	const compiled = adapter.compile(query.plan());
	const shapes = compiled.hydrationPlan!.includePayloads!;
	expect(shapes.map((shape) => shape.publicKey)).toEqual([
		'é'.repeat(40),
		'é'.repeat(39) + 'a',
	]);
	expect(new Set(shapes.map((shape) => shape.outputLabel)).size).toBe(2);
	for (const shape of shapes)
		expect(Buffer.byteLength(shape.outputLabel)).toBeLessThanOrEqual(63);
	expect(compiled.sql).toMatchSnapshot();
});

it('preserves different recursive public payloads using via for the same relation', () => {
	const read = orm
		.select('categories')
		.include('tree', {
			via: 'children',
			recursive: true,
			direction: 'descendants',
			omitSelf: true,
		})
		.include('list', {
			via: 'children',
			recursive: true,
			direction: 'descendants',
			omitSelf: true,
			flat: true,
		});
	const compiled = adapter.compile(read.plan());
	expect(
		compiled.hydrationPlan!.includePayloads!.map((shape) => [
			shape.publicKey,
			shape.recursive!.flat,
		]),
	).toEqual([
		['tree', false],
		['list', true],
	]);
	expect(compiled.sql).toMatchSnapshot();
});
it('refuses traversed filters supplied directly to createOrm', () => {
	const filtered = createOrm({
		schema: db,
		adapter,
		defaultFilters: { categories: eq('id', 1) },
	});
	expect(() =>
		filtered
			.select('categories')
			.include('children', { recursive: true, direction: 'descendants' })
			.plan(),
	).toThrow(
		'Recursive include with applicable defaultFilters on traversed nodes is not yet supported (#906).',
	);
	expect(() =>
		filtered.nql`categories | select managementChain.*`.dump(),
	).toThrow(
		'Recursive include with applicable defaultFilters on traversed nodes is not yet supported (#906).',
	);
});
