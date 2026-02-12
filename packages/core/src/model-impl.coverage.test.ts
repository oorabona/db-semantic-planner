// @ts-nocheck — coverage test: runtime assertions on AST nodes
import { describe, expect, it } from 'vitest';
import type { RelationIR, TableIR } from './model-ir.js';
import { ModelIRImpl } from './model-impl.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTable(
	name: string,
	overrides?: Partial<TableIR>,
): TableIR {
	return {
		name,
		columns: [
			{ name: 'id', type: 'integer', nullable: false },
		],
		primaryKey: 'id',
		foreignKeys: [],
		indexes: [],
		...overrides,
	};
}

function makeRelation(
	name: string,
	source: string,
	target: string,
	overrides?: Partial<RelationIR>,
): RelationIR {
	return {
		name,
		type: 'hasMany',
		source,
		target,
		cardinality: 'many',
		optionality: 'optional',
		includeStrategy: 'auto',
		filterStrategy: 'auto',
		joinDefault: 'auto',
		...overrides,
	};
}

function buildModel(
	tables: TableIR[],
	relations: RelationIR[],
): ModelIRImpl {
	const tableMap = new Map(tables.map((t) => [t.name, t]));
	const relMap = new Map(relations.map((r) => [`${r.source}.${r.name}`, r]));
	return new ModelIRImpl(tableMap, relMap);
}

// ---------------------------------------------------------------------------
// getRelationsFrom / getRelationsTo — fallback branches
// ---------------------------------------------------------------------------

describe('ModelIRImpl.getRelationsFrom', () => {
	it('returns empty array for non-existent source table', () => {
		const model = buildModel(
			[makeTable('users')],
			[],
		);
		expect(model.getRelationsFrom('nonexistent')).toEqual([]);
	});
});

describe('ModelIRImpl.getRelationsTo', () => {
	it('returns empty array for non-existent target table', () => {
		const model = buildModel(
			[makeTable('users')],
			[],
		);
		expect(model.getRelationsTo('nonexistent')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// isAmbiguous
// ---------------------------------------------------------------------------

describe('ModelIRImpl.isAmbiguous', () => {
	it('returns non-ambiguous with empty options for 0 matching relations', () => {
		const model = buildModel(
			[makeTable('users'), makeTable('posts')],
			[],
		);
		const result = model.isAmbiguous('users', 'posts');
		expect(result).toEqual({ ambiguous: false, options: [] });
	});

	it('returns non-ambiguous with single option for 1 matching relation', () => {
		const model = buildModel(
			[makeTable('users'), makeTable('posts')],
			[makeRelation('userPosts', 'users', 'posts')],
		);
		const result = model.isAmbiguous('users', 'posts');
		expect(result).toEqual({ ambiguous: false, options: ['userPosts'] });
	});

	it('returns ambiguous with 2+ matching relations', () => {
		const model = buildModel(
			[makeTable('users'), makeTable('posts')],
			[
				makeRelation('authoredPosts', 'users', 'posts'),
				makeRelation('reviewedPosts', 'users', 'posts'),
			],
		);
		const result = model.isAmbiguous('users', 'posts');
		expect(result).toEqual({
			ambiguous: true,
			options: ['authoredPosts', 'reviewedPosts'],
		});
	});
});

// ---------------------------------------------------------------------------
// Validation: PK column not found
// ---------------------------------------------------------------------------

describe('ModelIRImpl validation — primary key', () => {
	it('throws when PK column is not in columns (string PK)', () => {
		expect(() =>
			buildModel(
				[makeTable('users', {
					columns: [{ name: 'id', type: 'integer', nullable: false }],
					primaryKey: 'missing_col',
				})],
				[],
			),
		).toThrow(/primary key column "missing_col" not found in columns/);
	});

	it('throws when any PK column is not in columns (array PK)', () => {
		expect(() =>
			buildModel(
				[makeTable('user_roles', {
					columns: [
						{ name: 'user_id', type: 'integer', nullable: false },
						{ name: 'role_id', type: 'integer', nullable: false },
					],
					primaryKey: ['user_id', 'missing_col'],
				})],
				[],
			),
		).toThrow(/primary key column "missing_col" not found in columns/);
	});

	it('accepts string PK when column exists', () => {
		expect(() =>
			buildModel(
				[makeTable('users', {
					columns: [{ name: 'id', type: 'integer', nullable: false }],
					primaryKey: 'id',
				})],
				[],
			),
		).not.toThrow();
	});

	it('accepts array PK when all columns exist (composite key)', () => {
		expect(() =>
			buildModel(
				[makeTable('user_roles', {
					columns: [
						{ name: 'user_id', type: 'integer', nullable: false },
						{ name: 'role_id', type: 'integer', nullable: false },
					],
					primaryKey: ['user_id', 'role_id'],
				})],
				[],
			),
		).not.toThrow();
	});

	it('skips PK validation when primaryKey is undefined', () => {
		expect(() =>
			buildModel(
				[makeTable('junction', {
					columns: [
						{ name: 'a_id', type: 'integer', nullable: false },
						{ name: 'b_id', type: 'integer', nullable: false },
					],
					primaryKey: undefined,
				})],
				[],
			),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Validation: FK references non-existent table
// ---------------------------------------------------------------------------

describe('ModelIRImpl validation — foreign keys', () => {
	it('throws when FK references a non-existent table', () => {
		expect(() =>
			buildModel(
				[makeTable('posts', {
					columns: [
						{ name: 'id', type: 'integer', nullable: false },
						{ name: 'author_id', type: 'integer', nullable: false },
					],
					foreignKeys: [
						{ columns: ['author_id'], references: { table: 'ghost_table', columns: ['id'] } },
					],
				})],
				[],
			),
		).toThrow(/FK referencing non-existent table "ghost_table"/);
	});
});

// ---------------------------------------------------------------------------
// Validation: Relation source / target / through non-existent
// ---------------------------------------------------------------------------

describe('ModelIRImpl validation — relations', () => {
	it('throws when relation source is non-existent table', () => {
		const tables = [makeTable('users')];
		const tableMap = new Map(tables.map((t) => [t.name, t]));
		const rel = makeRelation('posts', 'nonexistent', 'users');
		const relMap = new Map([[`nonexistent.posts`, rel]]);
		expect(() => new ModelIRImpl(tableMap, relMap)).toThrow(
			/non-existent source table "nonexistent"/,
		);
	});

	it('throws when relation target is non-existent table', () => {
		const tables = [makeTable('users')];
		const tableMap = new Map(tables.map((t) => [t.name, t]));
		const rel = makeRelation('ghost', 'users', 'nonexistent');
		const relMap = new Map([[`users.ghost`, rel]]);
		expect(() => new ModelIRImpl(tableMap, relMap)).toThrow(
			/non-existent target table "nonexistent"/,
		);
	});

	it('throws when relation through is non-existent table', () => {
		const tables = [makeTable('users'), makeTable('roles')];
		const tableMap = new Map(tables.map((t) => [t.name, t]));
		const rel = makeRelation('roles', 'users', 'roles', {
			type: 'belongsToMany',
			through: 'missing_junction',
		});
		const relMap = new Map([[`users.roles`, rel]]);
		expect(() => new ModelIRImpl(tableMap, relMap)).toThrow(
			/non-existent through table "missing_junction"/,
		);
	});
});

// ---------------------------------------------------------------------------
// Self-referential / circular relation detection (non-error path)
// ---------------------------------------------------------------------------

describe('ModelIRImpl — circular relation detection', () => {
	it('handles self-referential table without throwing', () => {
		expect(() =>
			buildModel(
				[makeTable('categories')],
				[makeRelation('parent', 'categories', 'categories', { type: 'belongsTo' })],
			),
		).not.toThrow();
	});

	it('handles cycle between two tables without throwing', () => {
		expect(() =>
			buildModel(
				[makeTable('a'), makeTable('b')],
				[
					makeRelation('toB', 'a', 'b'),
					makeRelation('toA', 'b', 'a'),
				],
			),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Index building — verifying relation lookups work
// ---------------------------------------------------------------------------

describe('ModelIRImpl — relation index correctness', () => {
	it('indexes relations by source for getRelationsFrom', () => {
		const model = buildModel(
			[makeTable('users'), makeTable('posts'), makeTable('comments')],
			[
				makeRelation('posts', 'users', 'posts'),
				makeRelation('comments', 'users', 'comments'),
				makeRelation('author', 'posts', 'users', { type: 'belongsTo' }),
			],
		);
		const fromUsers = model.getRelationsFrom('users');
		expect(fromUsers).toHaveLength(2);
		expect(fromUsers.map((r) => r.name).sort()).toEqual(['comments', 'posts']);
	});

	it('indexes relations by target for getRelationsTo', () => {
		const model = buildModel(
			[makeTable('users'), makeTable('posts')],
			[
				makeRelation('posts', 'users', 'posts'),
				makeRelation('author', 'posts', 'users', { type: 'belongsTo' }),
			],
		);
		const toUsers = model.getRelationsTo('users');
		expect(toUsers).toHaveLength(1);
		expect(toUsers[0].name).toBe('author');
	});
});
