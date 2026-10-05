/** Regression: dotted-field and explicit EXISTS predicates both survive enrichment. */

import { and, createOrm, eq, exists, gt, ref, schema } from '@dbsp/core';
import type { ModelIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Helpers: build a minimal ModelIR with a relation that has declared foreignKey fields.
// This simulates a hand-built FK scenario where the compiler reads the declared FK from the relation.
// ---------------------------------------------------------------------------

function makeHandBuiltFkModel(): ModelIR {
	const base = schema({
		posts: {
			id: 'integer',
			title: 'text',
			views: 'integer',
			user_id: 'integer',
			author_id: 'integer',
		},
		users: { id: 'integer', name: 'text' },
	}).model;
	// posts.title, posts.views — declared foreignKey on the users→posts relation.
	// columns is an array so table.columns.find() works in the handler system.
	const postsTable = {
		name: 'posts',
		columns: [
			{ name: 'id', type: 'integer', nullable: false, primaryKey: true },
			{ name: 'title', type: 'text', nullable: true },
			{ name: 'views', type: 'integer', nullable: true },
			{ name: 'author_id', type: 'integer', nullable: true },
		],
		primaryKey: ['id'],
		indexes: [],
		checks: [],
		foreignKeys: [],
	};
	const usersTable = {
		name: 'users',
		columns: [
			{ name: 'id', type: 'integer', nullable: false, primaryKey: true },
			{ name: 'name', type: 'text', nullable: true },
		],
		primaryKey: ['id'],
		indexes: [],
		checks: [],
		foreignKeys: [],
	};

	const tables = new Map([
		['posts', postsTable],
		['users', usersTable],
	]);
	return {
		...base,
		relations: new Map(),
		getTable: base.getTable,
		getRelation: (qualifiedName: string) => {
			if (qualifiedName === 'users.posts') {
				return {
					name: 'posts',
					type: 'hasMany' as const,
					source: 'users',
					target: 'posts',
					cardinality: 'one-to-many' as const,
					optionality: 'optional' as const,
					includeStrategy: 'auto' as const,
					filterStrategy: 'auto' as const,
					joinDefault: 'auto' as const,
					foreignKey: 'user_id',
				};
			}
			if (qualifiedName === 'posts.author') {
				return {
					name: 'author',
					type: 'belongsTo' as const,
					source: 'posts',
					target: 'users',
					cardinality: 'many-to-one' as const,
					optionality: 'optional' as const,
					includeStrategy: 'auto' as const,
					filterStrategy: 'auto' as const,
					joinDefault: 'auto' as const,
					foreignKey: 'author_id',
				};
			}
			return undefined;
		},
		getTables: () => ['users', 'posts'],
		getRelations: () => ['users.posts', 'posts.author'],
		validate: () => ({ valid: true, errors: [] }),
	} as unknown as ModelIR;
}

// ---------------------------------------------------------------------------
// Defect 1: hand-built FK model — dotted-field predicate NOT dropped
// ---------------------------------------------------------------------------

describe('dotted-field EXISTS with hand-built FK relation', () => {
	it('and(eq("posts.title","x"), exists("posts",{where:gt("views",10)})) — both predicates survive', () => {
		const model = makeHandBuiltFkModel();
		const adapter = createPgCompileOnlyAdapter({ model });
		// Use createOrm with the hand-built model.
		const orm = createOrm({ model, adapter } as any);

		const { sql, params } = (orm as any)
			.select('users')
			.where(
				and(
					eq('posts.title', 'hello'),
					exists('posts', { where: gt('views', 10) }),
				),
			)
			.dump();

		const normalized = sql.replace(/\s+/g, ' ').trim();

		// Both predicates must be present in the SQL.
		// The dotted-field predicate compiles to an EXISTS with the title filter.
		// The explicit exists() compiles to a separate EXISTS with the views filter.
		expect(normalized, `Full SQL: ${normalized}`).toContain('title');
		expect(normalized, `Full SQL: ${normalized}`).toContain('views');

		// Both param values must appear.
		expect(params).toContain('hello');
		expect(params).toContain(10);

		// Two EXISTS subqueries: one for title, one for views.
		const existsCount = (normalized.match(/\bEXISTS\b/g) ?? []).length;
		expect(existsCount, `Expected 2 EXISTS, got: ${normalized}`).toBe(2);
	});

	it('eq("posts.title","x") alone with declared FK — compiles without error', () => {
		const model = makeHandBuiltFkModel();
		const adapter = createPgCompileOnlyAdapter({ model });
		const orm = createOrm({ model, adapter } as any);

		expect(() => {
			(orm as any).select('users').where(eq('posts.title', 'test')).dump();
		}).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Regression: explicit-FK model still works (no regression from marker change)
// ---------------------------------------------------------------------------

describe('dotted-field EXISTS with explicit-FK relation (regression)', () => {
	const testSchema = schema({
		users: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'text' },
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: { type: 'text' },
			views: { type: 'integer' },
			author_id: ref('users', { as: 'author', inverse: 'posts' }),
		},
	} as const);

	function buildOrm() {
		const adapter = createPgCompileOnlyAdapter({
			model: testSchema.model,
		});
		return createOrm({ model: testSchema.model, adapter });
	}

	it('and(eq("posts.title","x"), exists("posts",{where:gt("views",10)})) — both predicates survive', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(
				and(
					eq('posts.title', 'hello'),
					exists('posts', { where: gt('views', 10) }),
				),
			)
			.dump();

		const normalized = sql.replace(/\s+/g, ' ').trim();
		expect(normalized).toContain('title');
		expect(normalized).toContain('views');
		expect(params).toContain('hello');
		expect(params).toContain(10);
		const existsCount = (normalized.match(/\bEXISTS\b/g) ?? []).length;
		expect(existsCount, `Expected 2 EXISTS, got: ${normalized}`).toBe(2);
	});
});
