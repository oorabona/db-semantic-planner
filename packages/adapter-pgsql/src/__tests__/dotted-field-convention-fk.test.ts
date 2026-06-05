/**
 * Regression tests for the reliable dotted-field EXISTS skip marker.
 *
 * The old code skipped a dotted-field EXISTS decision only when `d.foreignKey`
 * was truthy.  When the model's relation has no explicit foreignKey (convention-
 * derived FK), convertDottedFieldsToExists emits a decision with no foreignKey
 * field — the old check would then re-collect it as an unresolved stub, allowing
 * stub-enrichment to overwrite it with an explicit exists() enrichment for the
 * same relation and silently drop the dotted-field predicate.
 *
 * Fix: collectExistsStubs now uses `d.relationName` (always set by
 * convertDottedFieldsToExists, never by convertExistsLike stubs) as the
 * reliable skip marker — independent of foreignKey presence.
 */

import { and, createOrm, eq, exists, gt, ref, schema } from '@dbsp/core';
import type { ModelIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Helpers: build a minimal ModelIR with a relation that has NO foreignKey field.
// This simulates a convention-FK scenario where the compiler must derive the FK
// from the table name rather than reading it from the relation.
// ---------------------------------------------------------------------------

function makeConventionFkModel(): ModelIR {
	// posts.title, posts.views — no explicit foreignKey on the users→posts relation.
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

	return {
		getTable: (name: string) => {
			if (name === 'posts') return postsTable as any;
			if (name === 'users') return usersTable as any;
			return undefined;
		},
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
					// NO foreignKey field — convention-derived by the compiler
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
					// NO foreignKey field
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
// Defect 1: convention-FK model — dotted-field predicate NOT dropped
// ---------------------------------------------------------------------------

describe('dotted-field EXISTS with convention-FK relation', () => {
	it('and(eq("posts.title","x"), exists("posts",{where:gt("views",10)})) — both predicates survive', () => {
		const model = makeConventionFkModel();
		const adapter = createPgsqlCompileOnlyAdapter({ model });
		// Use createOrm with the convention-FK model.
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

	it('eq("posts.title","x") alone with convention-FK — compiles without error', () => {
		const model = makeConventionFkModel();
		const adapter = createPgsqlCompileOnlyAdapter({ model });
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
		const adapter = createPgsqlCompileOnlyAdapter({
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
