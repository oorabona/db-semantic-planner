/**
 * Regression tests for exists()/notExists() on inverse hasMany relations in
 * mutation WHERE clauses. The FK is intentionally non-conventional so fallback
 * derivation (symbols -> symbol_id) would be visibly wrong.
 */

import {
	and,
	createOrm,
	eq,
	exists,
	isNull,
	notExists,
	rawExists,
	ref,
	schema,
	some,
	subquery,
} from '@dbsp/core';
import type { WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const inverseFkSchema = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	symbols_archive: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		callee_ref: ref('symbols', {
			as: 'callee',
			inverse: 'calleeCalls',
		}),
		body: { type: 'text' },
	},
});

function buildAdapter() {
	return createPgCompileOnlyAdapter({ model: inverseFkSchema.model });
}

function expectInverseCorrelation(sql: string) {
	expect(sql).toMatch(/EXISTS/i);
	expect(sql).toMatch(/FROM\s+"?calls"?/i);
	expect(sql).toContain('callee_ref');
	expect(sql).toMatch(
		/"?symbols"?\."?id"?\s*=\s*"?calls_exists_\d+"?\."?callee_ref"?/,
	);
	expect(sql).not.toContain('symbol_id');
	expect(sql).not.toMatch(
		/"?symbols"?\."?callee_ref"?\s*=\s*"?calls_exists_\d+"?\."?id"?/,
	);
}

const compositeFkRelations = new Map([
	[
		'customers.orders',
		{
			name: 'orders',
			type: 'hasMany',
			source: 'customers',
			target: 'orders',
			foreignKey: 'customer_id',
			cardinality: 'many',
			optionality: 'optional',
			includeStrategy: 'auto',
			joinDefault: 'auto',
		},
	],
	[
		'orders.items',
		{
			name: 'items',
			type: 'hasMany',
			source: 'orders',
			target: 'order_items',
			foreignKey: ['order_id', 'tenant_id'],
			sourceKey: ['order_id', 'tenant_id'],
			cardinality: 'many',
			optionality: 'optional',
			includeStrategy: 'auto',
			joinDefault: 'auto',
		},
	],
] as const);

const compositeFkBase = schema({
	customers: { id: 'integer', name: 'text' },
	orders: {
		id: 'integer',
		name: 'text',
		order_id: 'integer',
		tenant_id: 'integer',
		customer_id: 'integer',
		status: 'text',
	},
	orders_archive: {
		id: 'integer',
		name: 'text',
		order_id: 'integer',
		tenant_id: 'integer',
		customer_id: 'integer',
		status: 'text',
	},
	order_items: {
		id: 'integer',
		name: 'text',
		order_id: 'integer',
		tenant_id: 'integer',
	},
}).model;

const compositeFkModel = {
	...compositeFkBase,
	relations: compositeFkRelations,
	getTable: (tableName: string) => compositeFkBase.tables.get(tableName),
	getRelation: (qualifiedName: 'customers.orders' | 'orders.items') =>
		compositeFkRelations.get(qualifiedName),
	getRelationsFrom: (source: string) =>
		[...compositeFkRelations.values()].filter(
			(relation) => relation.source === source,
		),
	getRelationsTo: (target: string) =>
		[...compositeFkRelations.values()].filter(
			(relation) => relation.target === target,
		),
	isAmbiguous: () => ({ ambiguous: false, options: [] }),
};

function buildCompositeFkAdapter() {
	const relation = compositeFkModel.getRelation('orders.items');
	expect(relation?.foreignKey).toEqual(['order_id', 'tenant_id']);
	return createPgCompileOnlyAdapter({ model: compositeFkModel });
}

function expectCompositeCorrelation(sql: string, sourceAlias = 'orders') {
	expect(sql).toMatch(/EXISTS/i);
	expect(sql).toMatch(/FROM\s+"?order_items"?/i);
	const quotedSource = sourceAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	expect(sql).toMatch(
		new RegExp(
			`"?${quotedSource}"?\\."?order_id"?\\s*=\\s*"?order_items_exists_\\d+"?\\."?order_id"?`,
		),
	);
	expect(sql).toMatch(
		new RegExp(
			`"?${quotedSource}"?\\."?tenant_id"?\\s*=\\s*"?order_items_exists_\\d+"?\\."?tenant_id"?`,
		),
	);
	expect(sql).not.toMatch(
		/"?orders"?\."?id"?\s*=\s*"?order_items_exists_\d+"?\."?order_id"?/,
	);
}

function compileMutationWhere(
	adapter: ReturnType<typeof createPgCompileOnlyAdapter>,
	entryPoint: string,
	table: string,
	where: unknown,
): string {
	switch (entryPoint) {
		case 'compileInsertFrom':
			return adapter.compileInsertFrom({
				type: 'insert_from',
				table: `${table}_archive`,
				source: table,
				columns: ['id', 'name'],
				where,
			} as any).sql;
		case 'compileUpdate':
			return adapter.compileUpdate({
				type: 'update',
				table,
				set: { name: 'archived' },
				where,
			} as any).sql;
		case 'compileBatchUpdate':
			return adapter.compileBatchUpdate({
				type: 'batchUpdate',
				table,
				matchColumns: ['id'],
				updates: [{ id: 1, name: 'archived' }],
				where,
			} as any).sql;
		case 'compileDelete':
			return adapter.compileDelete({
				type: 'delete',
				table,
				where,
			} as any).sql;
		case 'compileUpsert.action.where':
			return adapter.compileUpsert({
				type: 'upsert',
				table,
				values: [{ id: 1, name: 'active' }],
				onConflict: { columns: ['id'] },
				action: {
					type: 'doUpdate',
					set: { name: 'active' },
					where,
				},
			} as any).sql;
		case 'compileUpsertFrom':
			return adapter.compileUpsertFrom({
				type: 'upsert_from',
				table: `${table}_archive`,
				source: table,
				conflictColumns: ['id'],
				columns: ['id', 'name'],
				where,
			} as any).sql;
		default:
			throw new Error(`Unknown mutation WHERE entry point: ${entryPoint}`);
	}
}

const mutationWhereEntryPoints = [
	'compileInsertFrom',
	'compileUpdate',
	'compileBatchUpdate',
	'compileDelete',
	'compileUpsert.action.where',
	'compileUpsertFrom',
];

describe('inverse relation exists() mutation FK resolution', () => {
	it('upsert VALUES action WHERE exists(inverse) correlates on the real target FK', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileUpsert({
			type: 'upsert',
			table: 'symbols',
			values: [{ id: 1, name: 'Alpha' }],
			onConflict: { columns: ['id'] },
			action: {
				type: 'doUpdate',
				where: exists('calleeCalls'),
			},
		} as any);

		expect(sql).toContain('VALUES');
		expect(sql).not.toContain('unnest(');
		expectInverseCorrelation(sql);
	});

	it('upsert unnest action WHERE exists(inverse) correlates on the real target FK', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileUpsert(
			{
				type: 'upsert',
				table: 'symbols',
				values: [{ id: 1, name: 'Alpha' }],
				onConflict: { columns: ['id'] },
				action: {
					type: 'doUpdate',
					where: exists('calleeCalls'),
				},
			} as any,
			{ batchThreshold: 0 },
		);

		expect(sql).toContain('unnest(');
		expect(sql).not.toContain('VALUES');
		expectInverseCorrelation(sql);
	});

	it('DELETE WHERE exists(inverse) correlates on the real target FK', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete',
			table: 'symbols',
			where: exists('calleeCalls'),
		} as any);

		expect(sql).toMatch(/^DELETE/i);
		expectInverseCorrelation(sql);
	});

	it('UPDATE WHERE notExists(inverse) correlates on the real target FK', () => {
		const adapter = buildAdapter();

		const { sql } = adapter.compileUpdate({
			type: 'update',
			table: 'symbols',
			set: { name: 'archived' },
			where: notExists('calleeCalls'),
		} as any);

		expect(sql).toMatch(/^UPDATE/i);
		expect(sql).toMatch(/NOT.*EXISTS/i);
		expectInverseCorrelation(sql);
	});

	it.each(mutationWhereEntryPoints)(
		'%s resolves single-column exists() relation metadata',
		(entryPoint) => {
			const adapter = buildAdapter();

			const sql = compileMutationWhere(
				adapter,
				entryPoint,
				'symbols',
				exists('calleeCalls'),
			);

			expectInverseCorrelation(sql);
		},
	);
});

describe('composite FK exists() mutation correlation', () => {
	it('DELETE WHERE notExists(composite relation) correlates on the full key', () => {
		const adapter = buildCompositeFkAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete',
			table: 'orders',
			where: notExists('items'),
		} as any);

		expect(sql).toMatch(/NOT.*EXISTS/i);
		expectCompositeCorrelation(sql);
	});

	it('UPDATE WHERE exists(composite relation) correlates on the full key', () => {
		const adapter = buildCompositeFkAdapter();

		const { sql } = adapter.compileUpdate({
			type: 'update',
			table: 'orders',
			set: { status: 'archived' },
			where: exists('items'),
		} as any);

		expectCompositeCorrelation(sql);
	});

	it('upsert doUpdate WHERE notExists(composite relation) correlates on the full key', () => {
		const adapter = buildCompositeFkAdapter();

		const { sql } = adapter.compileUpsert({
			type: 'upsert',
			table: 'orders',
			values: [{ order_id: 1, tenant_id: 10, status: 'active' }],
			onConflict: { columns: ['order_id', 'tenant_id'] },
			action: {
				type: 'doUpdate',
				set: { status: 'active' },
				where: notExists('items'),
			},
		} as any);

		expect(sql).toMatch(/NOT.*EXISTS/i);
		expectCompositeCorrelation(sql);
	});

	it.each(['compileInsertFrom', 'compileBatchUpdate', 'compileUpsertFrom'])(
		'%s WHERE exists(composite relation) correlates on the full key',
		(entryPoint) => {
			const adapter = buildCompositeFkAdapter();

			const sql = compileMutationWhere(
				adapter,
				entryPoint,
				'orders',
				exists('items'),
			);

			expectCompositeCorrelation(sql);
		},
	);

	it('nested exists().where composite relation correlates on the full key', () => {
		const adapter = buildCompositeFkAdapter();

		const { sql } = adapter.compileDelete({
			type: 'delete',
			table: 'customers',
			where: exists('orders', { where: exists('items') }),
		} as any);

		expectCompositeCorrelation(sql, 'orders_exists_0');
	});
});

describe('a relation-path ColumnRef in a mutation WHERE body (#991)', () => {
	const nodeDb = schema({
		nodes: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			parent_id: ref('nodes', {
				nullable: true,
				as: 'parent',
				inverse: 'children',
				roles: { parent: 'parent', children: 'children' },
			}),
		},
		nodes_archive: { id: { type: 'integer', primaryKey: true }, name: 'text' },
	});
	const { nodes } = createOrm({
		schema: nodeDb,
		adapter: createPgCompileOnlyAdapter({ model: nodeDb.model }),
	}).tables;
	it.each(['compileBatchUpdate', 'compileInsertFrom', 'compileUpsertFrom'])(
		'AC38 other-mutation-paths-refused %s',
		(entryPoint) => {
			const adapter = createPgCompileOnlyAdapter({ model: nodeDb.model });
			expect(() =>
				compileMutationWhere(
					adapter,
					entryPoint,
					'nodes',
					exists('children', {
						include: { parent: { join: 'inner' } },
						where: eq(nodes.parent.name, 'x'),
					}),
				),
			).toThrow(
				new Error(
					"ColumnRef 'parent.name' follows a relation; inside a relation predicate, quantifier callback or subquery body its path would be read from that body's row (#1014).",
				),
			);
		},
	);
});

describe('typed relation refs in mutation guard bodies (#991)', () => {
	const relationRefusal = (relation: string) =>
		new Error(
			`RelationRef '${relation}' follows a relation from its table; inside a relation predicate, quantifier callback or subquery body its path would be read from that body's row (#1014).`,
		);
	const writingsDb = schema({
		users: { id: { type: 'integer', primaryKey: true }, email: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			published: 'boolean',
			author_id: ref('users', { as: 'author', inverse: 'writings' }),
		},
	});
	const { users } = createOrm({
		schema: writingsDb,
		adapter: createPgCompileOnlyAdapter({ model: writingsDb.model }),
	}).tables;
	const plainDb = schema({
		users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			published: 'boolean',
			user_id: ref('users', { inverse: 'posts' }),
		},
		comments: {
			id: { type: 'integer', primaryKey: true },
			post_id: ref('posts', { inverse: 'comments' }),
		},
	});
	const plainOrm = createOrm({
		schema: plainDb,
		adapter: createPgCompileOnlyAdapter({ model: plainDb.model }),
	});
	const { posts } = plainOrm.tables;
	const ambiguousBody = () =>
		rawExists(
			subquery('users')
				.select('id')
				.where(some(plainOrm.tables.users.posts, () => and())),
		);
	const unambiguousBody = () =>
		rawExists(
			subquery('posts')
				.select('id')
				.where(some(posts.comments, () => and())),
		);
	const topLevel = () =>
		some(plainOrm.tables.users.posts, (p) => eq(p.published!, true));
	const batchSet = (where: WhereIntent) =>
		plainOrm
			.update('users')
			.batchSet('id', [{ id: 1, name: 'changed' }])
			.where(where)
			.dump().sql;

	it.each(['compileUpdate', 'compileDelete', 'compileUpsert.action.where'])(
		'AC42 model-less-mutation-refused %s',
		(entryPoint) => {
			expect(() =>
				compileMutationWhere(
					createPgCompileOnlyAdapter(),
					entryPoint,
					'users',
					exists('writings', { where: eq(users.writings.published!, true) }),
				),
			).toThrow(
				new Error(
					"ColumnRef 'writings.published' follows a relation; inside a relation predicate, quantifier callback or subquery body its path would be read from that body's row (#1014).",
				),
			);
		},
	);

	it('AC46 mutation-guard-body-refused', () => {
		expect(() => batchSet(ambiguousBody())).toThrow(relationRefusal('posts'));
		expect(() =>
			compileMutationWhere(
				createPgCompileOnlyAdapter(),
				'compileUpsert.action.where',
				'users',
				ambiguousBody(),
			),
		).toThrow(relationRefusal('posts'));
	});

	it('AC46 mutation-guard-unambiguous-body-kept', () => {
		expect(batchSet(unambiguousBody())).toBe(
			'UPDATE users SET name = t.name FROM unnest(CAST($1 AS int4[]), CAST($2 AS text[])) AS t(id, name) WHERE users.id = t.id AND EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE EXISTS (SELECT 1 FROM comments AS comments_exists_0 WHERE posts_sq.id = comments_exists_0.post_id AND true))',
		);
		expect(
			compileMutationWhere(
				createPgCompileOnlyAdapter(),
				'compileUpsert.action.where',
				'users',
				unambiguousBody(),
			),
		).toBe(
			'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = $3 WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE EXISTS (SELECT 1 FROM comments AS comments_exists_0 WHERE posts_sq.id = comments_exists_0.post_id AND true))',
		);
	});

	it('AC46 mutation-guard-top-level-kept', () => {
		expect(batchSet(topLevel())).toBe(
			'UPDATE users SET name = t.name FROM unnest(CAST($2 AS int4[]), CAST($3 AS text[])) AS t(id, name) WHERE users.id = t.id AND EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.user_id AND posts_exists_0.published = $1)',
		);
		expect(
			compileMutationWhere(
				createPgCompileOnlyAdapter(),
				'compileUpsert.action.where',
				'users',
				topLevel(),
			),
		).toBe(
			'INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = $3 WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.user_id AND posts_exists_0.published = $4)',
		);
	});
});

describe('#891 slice 5a: batchSet guards and insert/upsert-from WHERE resolve through core', () => {
	const guardTables = {
		users: {
			id: { type: 'integer', primaryKey: true },
			email: 'text',
			name: 'text',
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			deletedAt: { type: 'timestamp', nullable: true },
			user_id: ref('users', { as: 'author', inverse: 'writings' }),
		},
		comments: {
			id: { type: 'integer', primaryKey: true },
			body: 'text',
			post_id: ref('posts', { as: 'post', inverse: 'replies' }),
		},
		users_archive: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
		},
	} as const;
	const guardOrm = (filtered: boolean) => {
		const db = filtered
			? schema(guardTables, undefined, {
					defaultFilters: { posts: isNull('deletedAt') },
				})
			: schema(guardTables);
		const adapter = createPgCompileOnlyAdapter({ model: db.model });
		return {
			adapter,
			orm: createOrm({ schema: db, adapter, suppressDxWarnings: true }),
		};
	};
	const quantifierBody = () =>
		exists('writings', {
			where: {
				kind: 'relationFilter',
				relation: 'replies',
				mode: 'some',
				where: and(),
			} as WhereIntent,
		});
	const batchSet = (
		orm: ReturnType<typeof guardOrm>['orm'],
		where: WhereIntent,
	) =>
		orm
			.update('users')
			.batchSet('id', [{ id: 1, email: 'x' }])
			.where(where)
			.dump();
	const fromSource = (
		adapter: ReturnType<typeof createPgCompileOnlyAdapter>,
		kind: 'insert' | 'upsert',
		where: WhereIntent,
	) =>
		kind === 'insert'
			? adapter.compileInsertFrom({
					type: 'insert_from',
					table: 'users_archive',
					source: 'users',
					columns: ['id', 'name'],
					where,
				} as any)
			: adapter.compileUpsertFrom({
					type: 'upsert_from',
					table: 'users_archive',
					source: 'users',
					columns: ['id', 'name'],
					conflictColumns: ['id'],
					where,
				} as any);
	const insertHead =
		'INSERT INTO users_archive (id, name) SELECT users.id AS id, users.name AS name FROM users WHERE';
	const onConflict = ' ON CONFLICT (id) DO UPDATE SET name = excluded.name';
	const nestedExists =
		'EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.user_id AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1.post_id AND true))';
	const noRelation = (relation: string, table: string) =>
		`exists('${relation}'): no relation '${relation}' is declared on table '${table}'. Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.`;

	it.each([false, true])(
		'AC1 batchset-quantifier-body: a quantifier inside a batchSet guard exists() body compiles (filtered: %s)',
		(filtered) => {
			expect(batchSet(guardOrm(filtered).orm, quantifierBody())).toMatchObject({
				sql: `UPDATE users SET email = t.email FROM unnest(CAST($1 AS int4[]), CAST($2 AS text[])) AS t(id, email) WHERE users.id = t.id AND ${nestedExists}`,
				parameters: [[1], ['x']],
			});
		},
	);

	it('AC1 insert-upsert-from-quantifier-body: the same body compiles in insert-from and upsert-from', () => {
		for (const filtered of [false, true]) {
			const { adapter } = guardOrm(filtered);
			expect(fromSource(adapter, 'insert', quantifierBody())).toMatchObject({
				sql: `${insertHead} ${nestedExists}`,
				parameters: [],
			});
			expect(fromSource(adapter, 'upsert', quantifierBody())).toMatchObject({
				sql: `${insertHead} ${nestedExists}${onConflict}`,
				parameters: [],
			});
		}
	});

	it('AC2 batchset-issued-body-filter: an issued rawExists body keeps its builder filter in a batchSet guard', () => {
		for (const filtered of [false, true]) {
			const { orm } = guardOrm(filtered);
			const filter = filtered ? ' AND posts_sq."deletedAt" IS NULL' : '';
			expect(
				batchSet(
					orm,
					rawExists(
						orm
							.select('posts')
							.where(eq('title', 't')) as unknown as Parameters<
							typeof rawExists
						>[0],
					),
				),
			).toMatchObject({
				sql: `UPDATE users SET email = t.email FROM unnest(CAST($2 AS int4[]), CAST($3 AS text[])) AS t(id, email) WHERE users.id = t.id AND EXISTS (SELECT 1 FROM posts AS posts_sq WHERE posts_sq.title = $1${filter})`,
				parameters: ['t', [1], ['x']],
			});
		}
	});

	it('AC2 insert-upsert-from-issued-body-filter: the same in insert-from and upsert-from', () => {
		for (const filtered of [false, true]) {
			const { adapter, orm } = guardOrm(filtered);
			const filter = filtered ? ' AND posts_sq."deletedAt" IS NULL' : '';
			const body = `EXISTS (SELECT 1 FROM posts AS posts_sq WHERE posts_sq.title = $1${filter})`;
			const where = () =>
				rawExists(
					orm.select('posts').where(eq('title', 't')) as unknown as Parameters<
						typeof rawExists
					>[0],
				);
			expect(fromSource(adapter, 'insert', where())).toMatchObject({
				sql: `${insertHead} ${body}`,
				parameters: ['t'],
			});
			expect(fromSource(adapter, 'upsert', where())).toMatchObject({
				sql: `${insertHead} ${body}${onConflict}`,
				parameters: ['t'],
			});
		}
	});

	it('AC3 recursive-refused: a recursive exists() is refused in the three positions', () => {
		const db = schema({
			nodes: {
				id: { type: 'integer', primaryKey: true },
				label: 'text',
				parent_id: ref('nodes', {
					nullable: true,
					as: 'parent',
					inverse: 'children',
					roles: { parent: 'parent', children: 'children' },
				}),
			},
			nodes_archive: {
				id: { type: 'integer', primaryKey: true },
				label: 'text',
			},
		} as const);
		const adapter = createPgCompileOnlyAdapter({ model: db.model });
		const orm = createOrm({ schema: db, adapter, suppressDxWarnings: true });
		const recursive = () =>
			exists('children', {
				recursive: { direction: 'down', through: 'children' },
			}) as WhereIntent;
		const refusal =
			"WHERE exists('children'): recursive relation predicates are not supported inside WHERE.";
		expect(() =>
			orm
				.update('nodes')
				.batchSet('id', [{ id: 1, label: 'x' }])
				.where(recursive())
				.dump(),
		).toThrow(refusal);
		for (const compile of [
			() =>
				adapter.compileInsertFrom({
					type: 'insert_from',
					table: 'nodes_archive',
					source: 'nodes',
					columns: ['id', 'label'],
					where: recursive(),
				} as any),
			() =>
				adapter.compileUpsertFrom({
					type: 'upsert_from',
					table: 'nodes_archive',
					source: 'nodes',
					columns: ['id', 'label'],
					conflictColumns: ['id'],
					where: recursive(),
				} as any),
		])
			expect(compile).toThrow(refusal);
	});

	it('AC4 many-to-many-refused: a many-to-many exists() is refused in the three positions', () => {
		const db = schema({
			users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
			roles: {
				id: { type: 'integer', primaryKey: true },
				label: 'text',
				user_id: ref('users', { as: 'owner', inverse: 'roles' }),
			},
			archive: { id: { type: 'integer', primaryKey: true }, name: 'text' },
		} as const);
		const base = db.model.getRelation('users.roles')!;
		const model = new Proxy(db.model, {
			get(target, property, receiver) {
				if (property === 'getRelation')
					return (name: string) =>
						name === 'users.roles'
							? {
									...base,
									type: 'belongsToMany',
									through: 'user_roles',
									otherKey: 'id',
								}
							: target.getRelation(name);
				const value = Reflect.get(target, property, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const adapter = createPgCompileOnlyAdapter({ model });
		const orm = createOrm({ model, adapter, suppressDxWarnings: true });
		const refusal =
			"many-to-many traversal exists('roles') in a WHERE condition is not supported yet (#787).";
		expect(() =>
			orm
				.update('users')
				.batchSet('id', [{ id: 1, name: 'x' }])
				.where(exists('roles'))
				.dump(),
		).toThrow(refusal);
		expect(() =>
			adapter.compileInsertFrom({
				type: 'insert_from',
				table: 'archive',
				source: 'users',
				columns: ['id', 'name'],
				where: exists('roles'),
			} as any),
		).toThrow(refusal);
		expect(() =>
			adapter.compileUpsertFrom({
				type: 'upsert_from',
				table: 'archive',
				source: 'users',
				columns: ['id', 'name'],
				conflictColumns: ['id'],
				where: exists('roles'),
			} as any),
		).toThrow(refusal);
	});

	it('AC5 undeclared-relation-refused: an undeclared exists() gets the no-relation refusal in the three positions', () => {
		const { adapter, orm } = guardOrm(false);
		const refusal = noRelation('roles', 'users');
		expect(() => batchSet(orm, exists('roles'))).toThrow(refusal);
		expect(() => fromSource(adapter, 'insert', exists('roles'))).toThrow(
			refusal,
		);
		expect(() => fromSource(adapter, 'upsert', exists('roles'))).toThrow(
			refusal,
		);
	});

	it('AC6 model-less-unchanged: without a model the three positions keep their route', () => {
		const adapter = createPgCompileOnlyAdapter();
		const batch = (where: WhereIntent) =>
			adapter.compileBatchUpdate({
				type: 'batch_update',
				table: 'users',
				matchColumns: ['id'],
				updates: [{ id: 1, email: 'x' }],
				where,
			} as any);
		const writings =
			'EXISTS (SELECT 1 FROM writings AS writings_exists_0 WHERE users.id = writings_exists_0.user_id)';
		expect(batch(exists('writings'))).toMatchObject({
			sql: `UPDATE users SET email = t.email FROM unnest(CAST($1 AS int4[]), CAST($2 AS text[])) AS t(id, email) WHERE users.id = t.id AND ${writings}`,
			parameters: [[1], ['x']],
		});
		expect(fromSource(adapter, 'insert', exists('writings'))).toMatchObject({
			sql: `${insertHead} ${writings}`,
			parameters: [],
		});
		expect(fromSource(adapter, 'upsert', exists('writings'))).toMatchObject({
			sql: `${insertHead} ${writings}${onConflict}`,
			parameters: [],
		});
		const crash = 'No WHERE handler registered for operator: undefined';
		expect(() => batch(quantifierBody())).toThrow(crash);
		expect(() => fromSource(adapter, 'insert', quantifierBody())).toThrow(
			crash,
		);
		expect(() => fromSource(adapter, 'upsert', quantifierBody())).toThrow(
			crash,
		);
	});

	it('AC6b bound-source: a bound insert/upsert-from source resolves through core', () => {
		const db = schema({
			blogPosts: {
				id: { type: 'integer', primaryKey: true },
				title: 'text',
				published: 'boolean',
			},
			archivedPosts: {
				id: { type: 'integer', primaryKey: true },
				title: 'text',
			},
		} as const);
		const adapter = createPgCompileOnlyAdapter({ model: db.model });
		const orm = createOrm({ schema: db, adapter, suppressDxWarnings: true });
		const cte =
			'WITH subset AS (SELECT "blogPosts".id, "blogPosts".title FROM "blogPosts" WHERE "blogPosts".published = $1)';
		// A plain column of the binding keeps today's SQL (bound-source-plain-column).
		expect(
			orm.nql`blogPosts | where published = false | select id, title | bind subset
insert into archivedPosts from subset where title = 'x'`.dump(),
		).toMatchObject({
			sql: `${cte} INSERT INTO "archivedPosts" SELECT * FROM subset WHERE subset.title = $2`,
			parameters: [false, 'x'],
		});
		expect(
			orm.nql`blogPosts | where published = false | select id, title | bind subset
upsert into archivedPosts on id from subset where title = 'x'`.dump(),
		).toMatchObject({
			sql: `${cte} INSERT INTO "archivedPosts" (id, title) SELECT subset.id AS id, subset.title AS title FROM subset WHERE subset.title = $2 ON CONFLICT (id) DO UPDATE SET title = excluded.title`,
			parameters: [false, 'x'],
		});
		// A dotted qualifier naming a table absent from the statement is refused
		// (bound-source-dotted-refused).
		const sourceQuery = {
			type: 'select',
			from: 'blogPosts',
			select: { type: 'fields', fields: ['id', 'title'] },
		};
		const refusal = noRelation('blogPosts', 'subset');
		expect(() =>
			adapter.compileInsertFrom({
				type: 'insert_from',
				table: 'archivedPosts',
				source: 'subset',
				sourceQuery,
				columns: ['id'],
				where: eq('blogPosts.title', 'x'),
			} as any),
		).toThrow(refusal);
		expect(() =>
			adapter.compileUpsertFrom({
				type: 'upsert_from',
				table: 'archivedPosts',
				source: 'subset',
				sourceQuery,
				columns: ['id'],
				conflictColumns: ['id'],
				where: eq('blogPosts.title', 'x'),
			} as any),
		).toThrow(refusal);
	});

	it('AC6c schema-scoped-guard: a batchSet guard under withSchema keeps its schema-qualified SQL', () => {
		const { orm } = guardOrm(false);
		expect(
			orm
				.withSchema('tenant')
				.update('users')
				.batchSet('id', [{ id: 1, email: 'x' }])
				.where(exists('writings'))
				.dump(),
		).toMatchObject({
			sql: 'UPDATE tenant.users SET email = t.email FROM unnest(CAST($1 AS int4[]), CAST($2 AS text[])) AS t(id, email) WHERE users.id = t.id AND EXISTS (SELECT 1 FROM tenant.posts AS posts_exists_0 WHERE users.id = posts_exists_0.user_id)',
			parameters: [[1], ['x']],
		});
	});

	it('AC6d snake-case-guard: under snake_case the batchSet guard qualifies by the physical table name', () => {
		const db = schema({
			userAccounts: {
				id: { type: 'integer', primaryKey: true },
				displayName: 'text',
			},
		} as const);
		const adapter = createPgCompileOnlyAdapter({
			model: db.model,
			dbCasing: 'snake_case',
		});
		const orm = createOrm({ schema: db, adapter, suppressDxWarnings: true });
		expect(
			orm
				.update('userAccounts')
				.batchSet('id', [{ id: 1, displayName: 'x' }])
				.where(eq('displayName', 'a'))
				.dump(),
		).toMatchObject({
			sql: 'UPDATE user_accounts SET display_name = t.display_name FROM unnest(CAST($2 AS int4[]), CAST($3 AS text[])) AS t(id, display_name) WHERE user_accounts.id = t.id AND user_accounts.display_name = $1',
			parameters: ['a', [1], ['x']],
		});
	});
});
