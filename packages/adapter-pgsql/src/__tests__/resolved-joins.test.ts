import {
	and,
	batchValues,
	createOrm,
	eq,
	exists,
	exprRef,
	like,
	ModelIRImpl,
	manyToMany,
	outerRef,
	ref,
	relationColumn,
	schema,
	type TableIR,
} from '@dbsp/core';
import type { RelationIR } from '@dbsp/core/internal';
import type { ModelIR, PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
	calls: {
		id: { type: 'integer', primaryKey: true },
		callerId: ref('users', { as: 'caller' }),
	},
});
const adapter = createPgCompileOnlyAdapter({ model: db.model });
const orm = createOrm({ schema: db, adapter });
function poison(model: ModelIR): ModelIR {
	return new Proxy(model, {
		get(target, property) {
			if (property === 'getRelation' || property === 'getRelationsFrom')
				return () => {
					throw new Error('join relation lookup after planning');
				};
			const member = Reflect.get(target, property);
			return typeof member === 'function' ? member.bind(target) : member;
		},
	});
}
describe('resolved joins authority', () => {
	it('relation joins compile with poisoned relation methods after planning', () => {
		for (const options of [{}, { as: 'c' }, { type: 'left' as const }]) {
			const report = orm.select('calls').join('caller', options).plan();
			const expected = adapter.compile(report);
			const actual = adapter.compile(report, { model: poison(db.model) });
			expect(actual.sql).toBe(expected.sql);
			expect(actual.parameters).toEqual(expected.parameters);
			expect(actual.sql).toContain(
				`AS ${report.execution!.joins[0]!.range.alias}`,
			);
			expect(Object.isFrozen(report.execution!.joins)).toBe(true);
			expect(Object.isFrozen(report.execution!.joins[0]!.range)).toBe(true);
		}
	});
	it('duplicate, root, unknown and many-to-many joins refuse at plan', () => {
		expect
			.soft(() => orm.select('calls').join('caller').join('caller').plan())
			.toThrow("Query scope already binds qualifier 'caller'.");
		expect
			.soft(() => orm.select('calls').join('caller', { as: 'calls' }).plan())
			.toThrow("Query scope already binds qualifier 'calls'.");
		expect
			.soft(() => orm.select('calls').join('missing').plan())
			.toThrow(
				"join('missing'): relation not found on table 'calls'. Available: caller",
			);
		const m = schema(
			{
				posts: { id: 'integer' },
				tags: { id: 'integer' },
				postTags: { postId: ref('posts'), tagId: ref('tags') },
			},
			undefined,
			{
				relations: {
					posts: {
						tags: manyToMany('tags', {
							through: 'postTags',
							inverse: 'posts',
							sourceForeignKey: ['postId'],
							targetForeignKey: ['tagId'],
						}),
					},
				},
			},
		);
		const o = createOrm({
			schema: m,
			adapter: createPgCompileOnlyAdapter({ model: m.model }),
		});
		expect
			.soft(() => o.select('posts').join('tags').plan())
			.toThrow(
				"Invalid relation: Relation 'posts.tags': many-to-many traversal is not supported yet (#787).",
			);
	});
	it('copied reports with and without joins refuse', () => {
		for (const report of [
			orm.select('calls').join('caller').plan(),
			orm.select('calls').plan(),
		]) {
			for (const copy of [{ ...report }, JSON.parse(JSON.stringify(report))])
				expect(() => adapter.compile(copy)).toThrow(
					'Adapter compilation requires a report planned by this loaded copy of dbsp (plan(), the ORM or NQL)',
				);
		}
	});
	it('join-free issued reports compile; copies refuse', () => {
		const issued = orm.select('calls').plan();
		expect(adapter.compile(issued).sql).toBe('SELECT calls.* FROM calls');
		for (const copy of [{ ...issued }, JSON.parse(JSON.stringify(issued))])
			expect(() => adapter.compile(copy)).toThrow(
				'Adapter compilation requires a report planned by this loaded copy of dbsp (plan(), the ORM or NQL)',
			);
	});
	it('unissued reports with only join decisions refuse', () => {
		const plain = orm.select('calls').plan();
		const report = {
			...plain,
			decisions: [{ type: 'join' }],
		} as unknown as PlanReport;
		expect(() => adapter.compile(report)).toThrow(
			'Adapter compilation requires a report planned by this loaded copy of dbsp (plan(), the ORM or NQL); plan the query with this loaded copy, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation',
		);
	});

	it('issued reports refuse absent or mismatched resolved joins', () => {
		// The execution snapshot is frozen, but authored intent remains inspectable.
		for (const count of [1, 2]) {
			const report = orm.select('calls').plan();
			Object.assign(report.intent, {
				joins: Array.from({ length: count }, () => ({ relation: 'caller' })),
			});
			expect(() => adapter.compile(report)).toThrow(
				expect.objectContaining({ name: 'InvalidResolvedJoinsError' }),
			);
		}
	});
	it('joins and includes share ranges and preserve the authored join qualifier', () => {
		const report = orm
			.select('calls')
			.join('caller')
			.include('caller', { join: 'left' })
			.plan();
		const execution = report.execution!;
		expect(execution.joins[0]!.range.alias).toBe('caller');
		expect(execution.includes[0]!.targetRange.alias).toBe('caller_1');
		expect(
			new Set([
				execution.rootRange.id,
				execution.joins[0]!.range.id,
				execution.includes[0]!.targetRange.id,
			]).size,
		).toBe(3);
		const compiled = adapter.compile(report);
		expect(compiled.sql).toContain('AS caller ON');
		expect(compiled.sql).toContain('AS caller_1 ON');
	});
	it('table and values ON use resolved ranges, including outerRef', () => {
		const values = batchValues([[1, 2]], ['id'], ['integer'], { alias: 'v' });
		for (const report of [
			orm
				.select('calls')
				.join('users', { as: 'u', on: eq('calls.callerId', outerRef('id')) })
				.plan(),
			orm
				.select('calls')
				.join(values, { on: eq('calls.callerId', outerRef('id')) })
				.plan(),
		]) {
			const join = report.execution!.joins[0]!;
			const canonical = adapter.compile(report);
			const actual = adapter.compile(report, { model: poison(db.model) });
			expect(actual.sql).toBe(canonical.sql);
			expect(actual.parameters).toEqual(canonical.parameters);
			expect(actual.sql).toContain(`${join.range.alias}.id`);
		}
	});
});

describe('left-to-right ON visibility', () => {
	const db = schema({
		a: { id: 'integer' },
		b: { id: 'integer', aId: 'integer' },
		c: { bId: 'integer' },
	});
	const orm = createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	it('table ON sees a preceding table alias', () => {
		expect(
			orm
				.select('a')
				.join('b', { as: 'b1', on: eq('a.id', exprRef('b1.aId')) })
				.join('c', { as: 'c1', on: eq('b1.id', exprRef('c1.bId')) })
				.join('b', { as: 'b2', on: eq('c1.bId', exprRef('b2.id')) })
				.dump().sql,
		).toBe(
			'SELECT a.* FROM a JOIN b AS b1 ON a.id = b1."aId" JOIN c AS c1 ON b1.id = c1."bId" JOIN b AS b2 ON c1."bId" = b2.id',
		);
		expect(
			orm
				.select('a')
				.join('b', { as: 'b1', on: eq('a.id', exprRef('b1.aId')) })
				.join('c', { as: 'c1', on: eq('b1.id', exprRef('c1.bId')) })
				.dump().sql,
		).toBe(
			'SELECT a.* FROM a JOIN b AS b1 ON a.id = b1."aId" JOIN c AS c1 ON b1.id = c1."bId"',
		);
	});
	it('values ON sees a preceding table alias', () => {
		const values = batchValues([[1, 2]], ['bId'], ['integer'], { alias: 'v' });
		expect(
			orm
				.select('a')
				.join('b', { as: 'b1', on: eq('a.id', exprRef('b1.aId')) })
				.join(values, { on: eq('b1.id', exprRef('v.bId')) })
				.dump().sql,
		).toBe(
			'SELECT a.* FROM a JOIN b AS b1 ON a.id = b1."aId" JOIN unnest(CAST($1 AS integer[])) AS v("bId") ON b1.id = v."bId"',
		);
	});
});

describe('ON planning contract (#891)', () => {
	it('refuses a later join qualifier by name during planning', () => {
		expect(() =>
			orm
				.select('calls')
				.join('users', { as: 'u', on: eq('id', exprRef('later.id')) })
				.join('users', { as: 'later', on: eq('id', 1) })
				.plan(),
		).toThrow("WHERE qualifier 'later' is not visible in this query.");
	});
	it('root fields and relation predicates retain their owner', () => {
		const report = orm
			.select('calls')
			.join('users', {
				as: 'u',
				on: and(like('callerId', 'x%'), exists('caller')),
			})
			.plan();
		expect(adapter.compile(report, { model: poison(db.model) }).sql).toBe(
			'SELECT calls.* FROM calls JOIN users AS u ON calls."callerId" LIKE $1 AND EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE calls."callerId" = users_exists_0.id)',
		);
	});
	it('table and BatchValues subqueries refuse during planning with their exact messages', () => {
		const on = {
			kind: 'subquery' as const,
			field: 'id',
			operator: 'eq' as const,
			subquery: { type: 'select' as const, from: 'users' },
		};
		expect
			.soft(() => orm.select('calls').join('users', { as: 'u', on }).plan())
			.toThrow('Subquery in JOIN ON condition is not supported.');
		const values = batchValues([[1]], ['id'], ['integer'], { alias: 'v' });
		expect(() => orm.select('calls').join(values, { on }).plan()).toThrow(
			'Subquery in BatchValues JOIN ON condition is not supported.',
		);
	});
	it('recursive relation predicates refuse during planning with the root WHERE message', () => {
		expect(() =>
			orm
				.select('calls')
				.join('users', {
					as: 'u',
					on: exists('caller', {
						recursive: { direction: 'up', through: 'caller' },
					}),
				})
				.plan(),
		).toThrow(
			"WHERE exists('caller'): recursive relation predicates are not supported inside WHERE.",
		);
	});
	it('values ON parameters splice before root WHERE and include parameters', () => {
		const values = batchValues([[7]], ['id'], ['integer'], { alias: 'v' });
		const compiled = orm
			.select('calls')
			.join(values, {
				on: and(eq('calls.callerId', outerRef('id')), like('v.id', 'on%')),
			})
			.where(like('id', 'root%'))
			.include('caller', { join: 'left', where: like('name', 'include%') })
			.dump();
		expect(compiled.params).toEqual(['root%', 'include%', [7], 'on%']);
		expect(compiled.sql).toBe(
			'SELECT calls.*, caller.id AS "caller.id", caller.name AS "caller.name", caller.id AS __dbsp_presence_caller FROM calls JOIN unnest(CAST($3 AS integer[])) AS v(id) ON calls."callerId" = v.id AND v.id LIKE $4 LEFT JOIN users AS caller ON calls."callerId" = caller.id WHERE calls.id LIKE $1 AND caller.name LIKE $2',
		);
	});
});

it('values ON sees root, self, every prior alias and its outerRef target', () => {
	const values = batchValues([[1]], ['id'], ['integer'], { alias: 'v' });
	const report = orm
		.select('calls')
		.join('users', { as: 'u1', on: eq('calls.callerId', exprRef('u1.id')) })
		.join('users', { as: 'u2', on: eq('u1.id', exprRef('u2.id')) })
		.join(values, {
			on: and(
				eq('callerId', exprRef('v.id')),
				eq('u1.id', outerRef('id')),
				eq('u2.id', exprRef('calls.callerId')),
			),
		})
		.plan();
	expect(adapter.compile(report, { model: poison(db.model) }).sql).toBe(
		'SELECT calls.* FROM calls JOIN users AS u1 ON calls."callerId" = u1.id JOIN users AS u2 ON u1.id = u2.id JOIN unnest(CAST($1 AS integer[])) AS v(id) ON calls."callerId" = v.id AND u1.id = v.id AND u2.id = calls."callerId"',
	);
});

it('a later alias refuses even when it names a declared root relation', () => {
	expect(() =>
		orm
			.select('calls')
			.join('users', { as: 'u', on: eq('caller.id', 1) })
			.join('caller')
			.plan(),
	).toThrow("WHERE qualifier 'caller' is not visible in this query.");
});

it('rawExists modifier refusals happen during ON planning', () => {
	const on = {
		kind: 'rawExists' as const,
		subquery: {
			type: 'select' as const,
			from: 'users',
			orderBy: [{ field: 'id', direction: 'asc' as const }],
			limit: 1,
		},
	};
	const values = batchValues([[1]], ['id'], ['integer'], { alias: 'v' });
	for (const query of [
		orm.select('calls').join('users', { as: 'u', on }),
		orm.select('calls').join(values, { on }),
	]) {
		expect(() => query.plan()).toThrow(
			'rawExists subquery with LIMIT, ORDER BY is not supported — it would silently change which rows match; restructure the query or use a CTE.',
		);
	}
});
it('table ON sees root, self, every prior alias and its outerRef target', () => {
	const report = orm
		.select('calls')
		.join('users', { as: 'u1', on: eq('calls.callerId', exprRef('u1.id')) })
		.join('users', { as: 'u2', on: eq('u1.id', exprRef('u2.id')) })
		.join('users', {
			as: 'u3',
			on: and(
				eq('callerId', exprRef('u3.id')),
				eq('u1.id', outerRef('id')),
				eq('u2.id', exprRef('calls.callerId')),
			),
		})
		.plan();
	expect(adapter.compile(report, { model: poison(db.model) }).sql).toBe(
		'SELECT calls.* FROM calls JOIN users AS u1 ON calls."callerId" = u1.id JOIN users AS u2 ON u1.id = u2.id JOIN users AS u3 ON calls."callerId" = u3.id AND u1.id = u3.id AND u2.id = calls."callerId"',
	);
});

it('rawExists preserves the legacy outerRef-only correlation refusal', () => {
	for (const [value, error] of [
		[
			outerRef('id'),
			'rawExists: correlated subqueries (outerRef inside the inner WHERE) are not yet supported. Workaround: use exists("relation", { where: ... }) when a schema relation exists, or wait for the rawExists correlation pipeline (tracked in TODO).',
		],
		[
			{ kind: 'fieldRef', scope: 'outer', column: 'id' },
			'Subquery in JOIN ON condition is not supported.',
		],
	] as const) {
		const on = {
			kind: 'rawExists' as const,
			subquery: {
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'comparison' as const,
					field: 'id',
					operator: 'eq' as const,
					value,
				},
			},
		};
		expect(() =>
			orm.select('calls').join('users', { as: 'u', on }).plan(),
		).toThrow(new Error(error));
	}
});

describe('#982: multi-hop relation joins', () => {
	const hopTables = {
		projects: { id: { type: 'integer', primaryKey: true }, name: 'string' },
		files: {
			id: { type: 'integer', primaryKey: true },
			path: 'string',
			lang: 'string',
			project_id: ref('projects', { as: 'project' }),
		},
		symbols: {
			id: { type: 'integer', primaryKey: true },
			name: 'string',
			kind: 'string',
			file_id: ref('files', { as: 'file' }),
		},
		calls: {
			id: { type: 'integer', primaryKey: true },
			callee_id: ref('symbols', { as: 'callee' }),
		},
	} as const;
	const hopDb = schema(hopTables);
	const hopOrm = createOrm({
		schema: hopDb,
		adapter: createPgCompileOnlyAdapter(),
	});
	const filteredDb = schema(hopTables, undefined, {
		defaultFilters: {
			symbols: eq('kind', 'function'),
			files: eq('lang', 'ts'),
		},
	});
	const filteredOrm = createOrm({
		schema: filteredDb,
		adapter: createPgCompileOnlyAdapter(),
	});

	it('multi-hop relation joins correlate every declared key pair', () => {
		const column = (name: string): TableIR['columns'][number] => ({
			name,
			type: 'integer',
			nullable: false,
		});
		const tables = new Map<string, TableIR>([
			[
				'orders',
				{
					name: 'orders',
					columns: [column('orderId'), column('tenantId')],
					primaryKey: ['orderId', 'tenantId'],
					foreignKeys: [],
					indexes: [],
				},
			],
			[
				'order_items',
				{
					name: 'order_items',
					columns: [column('id'), column('orderId'), column('tenantId')],
					primaryKey: ['id', 'tenantId'],
					foreignKeys: [
						{
							columns: ['orderId', 'tenantId'],
							references: { table: 'orders', columns: ['orderId', 'tenantId'] },
						},
					],
					indexes: [],
				},
			],
			[
				'shipments',
				{
					name: 'shipments',
					columns: [column('id'), column('itemId'), column('tenantId')],
					primaryKey: 'id',
					foreignKeys: [
						{
							columns: ['itemId', 'tenantId'],
							references: { table: 'order_items', columns: ['id', 'tenantId'] },
						},
					],
					indexes: [],
				},
			],
		]);
		const belongsTo = (
			name: string,
			source: string,
			target: string,
			foreignKey: string[],
			targetKey: string[],
		): RelationIR => ({
			name,
			type: 'belongsTo',
			source,
			target,
			foreignKey,
			targetKey,
			cardinality: 'one',
			optionality: 'required',
			includeStrategy: 'auto',
			joinDefault: 'auto',
		});
		const model = new ModelIRImpl(
			tables,
			new Map([
				[
					'shipments.item',
					belongsTo(
						'item',
						'shipments',
						'order_items',
						['itemId', 'tenantId'],
						['id', 'tenantId'],
					),
				],
				[
					'order_items.order',
					belongsTo(
						'order',
						'order_items',
						'orders',
						['orderId', 'tenantId'],
						['orderId', 'tenantId'],
					),
				],
			]),
		);
		const o = createOrm({
			model,
			adapter: createPgCompileOnlyAdapter({ model }),
		});
		expect(o.select('shipments').join('item.order').dump().sql).toBe(
			'SELECT shipments.* FROM shipments JOIN order_items AS item ON shipments."itemId" = item.id AND shipments."tenantId" = item."tenantId" JOIN orders AS item_order ON item."orderId" = item_order."orderId" AND item."tenantId" = item_order."tenantId"',
		);
	});

	it("multi-hop relation joins apply each hop's default filter in its ON", () => {
		const dump = filteredOrm
			.select('calls')
			.join('callee.file', { as: ['c', 'cf'] })
			.columns([
				relationColumn('callee', 'name', 'name'),
				relationColumn('callee.file', 'path', 'p'),
			])
			.where(eq('calls.id', 9))
			.dump();
		expect(dump.sql).toBe(
			'SELECT c.name AS name, cf.path AS p FROM calls JOIN symbols AS c ON calls.callee_id = c.id AND c.kind = $2 JOIN files AS cf ON c.file_id = cf.id AND cf.lang = $3 WHERE calls.id = $1',
		);
		expect(dump.params).toEqual([9, 'function', 'ts']);
	});

	it('a filtered relation join registers its relation path', () => {
		const dump = filteredOrm
			.select('calls')
			.join('callee', { as: 'c' })
			.columns([relationColumn('callee', 'name', 'n')])
			.dump();
		expect(dump.sql).toBe(
			'SELECT c.name AS n FROM calls JOIN symbols AS c ON calls.callee_id = c.id AND c.kind = $1',
		);
		expect(dump.params).toEqual(['function']);
	});

	it('multi-hop relation join plans one resolved join per hop', () => {
		const joins = hopOrm.select('calls').join('callee.file').plan()
			.execution!.joins;
		expect(
			joins.map((join) => ({
				intentIndex: join.intentIndex,
				intentPath: join.intentPath,
				alias: join.range.alias,
				logicalSegments: join.path!.logicalSegments,
				hops: join.path!.hops.length,
			})),
		).toEqual([
			{
				intentIndex: 0,
				intentPath: 'join[0]',
				alias: 'callee',
				logicalSegments: ['callee'],
				hops: 1,
			},
			{
				intentIndex: 0,
				intentPath: 'join[0]',
				alias: 'callee_file',
				logicalSegments: ['callee', 'file'],
				hops: 2,
			},
		]);
		expect(joins[1]!.sourceRange).toBe(joins[0]!.range);
	});

	it('multi-hop relation joins compile with poisoned relation methods after planning', () => {
		const hopAdapter = createPgCompileOnlyAdapter({ model: hopDb.model });
		for (const options of [
			{},
			{ as: ['c', 'cf'] },
			{ type: 'left' as const },
		]) {
			const report = hopOrm.select('calls').join('callee.file', options).plan();
			const expected = hopAdapter.compile(report);
			const actual = hopAdapter.compile(report, {
				model: poison(hopDb.model),
			});
			expect(actual.sql).toBe(expected.sql);
			expect(actual.parameters).toEqual(expected.parameters);
		}
	});

	it('a many-to-many relation is refused at any hop', () => {
		const m = schema(
			{
				posts: { id: 'integer' },
				tags: { id: 'integer' },
				postTags: { postId: ref('posts'), tagId: ref('tags') },
			},
			undefined,
			{
				relations: {
					posts: {
						tags: manyToMany('tags', {
							through: 'postTags',
							inverse: 'posts',
							sourceForeignKey: ['postId'],
							targetForeignKey: ['tagId'],
						}),
					},
				},
			},
		);
		const o = createOrm({
			schema: m,
			adapter: createPgCompileOnlyAdapter({ model: m.model }),
		});
		expect(() => o.select('postTags').join('post.tags').plan()).toThrow(
			"Invalid relation: Relation 'posts.tags': many-to-many traversal is not supported yet (#787).",
		);
	});

	it('a hop without declared keys is refused by the key resolver', () => {
		const strip = (relation: RelationIR | undefined) =>
			relation?.name === 'file' && relation.source === 'symbols'
				? { ...relation, foreignKey: [] }
				: relation;
		const model = new Proxy(hopDb.model, {
			get(target, property) {
				if (property === 'getRelation')
					return (key: string) => strip(target.getRelation(key));
				if (property === 'getRelationsFrom')
					return (table: string) =>
						target.getRelationsFrom(table).map((r) => strip(r)!);
				const member = Reflect.get(target, property);
				return typeof member === 'function' ? member.bind(target) : member;
			},
		});
		const o = createOrm({
			model,
			adapter: createPgCompileOnlyAdapter({ model }),
		});
		expect(() => o.select('calls').join('callee.file').plan()).toThrow(
			new Error(
				"Relation 'symbols.file' is missing a declared foreign key column.",
			),
		);
	});

	it('a report whose resolved joins miss a hop is refused', () => {
		const report = hopOrm.select('calls').join('callee').plan();
		Object.assign(report.intent, {
			joins: [{ relation: 'callee.file', type: 'inner' }],
		});
		expect(() =>
			createPgCompileOnlyAdapter({ model: hopDb.model }).compile(report),
		).toThrow(expect.objectContaining({ name: 'InvalidResolvedJoinsError' }));
	});
});
