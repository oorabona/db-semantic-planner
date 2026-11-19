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
