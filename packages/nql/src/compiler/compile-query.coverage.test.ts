/**
 * Coverage tests for compile-query.ts — exercises uncovered branches
 * in compileQuery, compileSetOperation, compileGroupByClause,
 * compileOrderByClause, and compileOrderItem.
 */

import type { ColumnType, QueryIntent } from '@dbsp/types';
import {
	getTrustedNqlRelationFilterFields,
	hasNqlTrustedRelationFilterProof,
} from '@dbsp/types/internal';
import { describe, expect, it } from 'vitest';
import { compile, NqlCompiler, parse } from '../index.js';
import type { NqlClause, NqlProgram, NqlQuery } from '../parser/ast.js';
import { ColumnValidator } from './column-validator.js';
import { getQueryOutputSchema } from './compile-query.js';
import { resolveBindingRelationColumn } from './expression-utils.js';
import {
	isUnresolvedSelectAllOutputSchemaError,
	UnresolvedSelectAllOutputSchemaError,
} from './index.js';
import type { CompilerContext } from './types.js';

type TestRelation = {
	readonly name: string;
	readonly source: string;
	readonly target: string;
	readonly type: 'hasMany' | 'hasOne' | 'belongsTo' | 'belongsToMany';
	readonly foreignKey: string | readonly string[];
	readonly through?: string;
	readonly otherKey?: string | readonly string[];
	readonly recursive?: unknown;
	readonly sourceKey?: string | readonly string[];
	readonly targetKey?: string | readonly string[];
};

// Schema with relations for include tests
const schema = {
	getTable(name: string) {
		const tables: Record<
			string,
			{
				columns: { name: string; type?: ColumnType }[];
				pseudoColumns?: {
					table: string;
					foreignKeyColumn: string;
					targetColumn: string;
					parentRole: string;
					childRole: string;
					ascendantKeyword: string;
					descendantKeyword: string;
				}[];
			}
		> = {
			users: {
				columns: [
					{ name: 'id', type: 'integer' },
					{ name: 'name', type: 'string' },
					{ name: 'email', type: 'string' },
					{ name: 'department', type: 'string' },
					{ name: 'active', type: 'boolean' },
					{ name: 'salary', type: 'number' },
				],
			},
			posts: {
				columns: [
					{ name: 'id', type: 'integer' },
					{ name: 'title', type: 'string' },
					{ name: 'body', type: 'string' },
					{ name: 'authorId', type: 'integer' },
					{ name: 'categoryId', type: 'integer' },
					{ name: 'published', type: 'boolean' },
				],
			},
			comments: {
				columns: [
					{ name: 'id', type: 'integer' },
					{ name: 'postId', type: 'integer' },
					{ name: 'body', type: 'string' },
				],
			},
			orders: {
				columns: [
					{ name: 'id', type: 'integer' },
					{ name: 'userId', type: 'integer' },
					{ name: 'total', type: 'number' },
					{ name: 'status', type: 'string' },
				],
			},
			tags: {
				columns: [
					{ name: 'id', type: 'integer' },
					{ name: 'name', type: 'string' },
				],
			},
			postTags: {
				columns: [
					{ name: 'postId', type: 'integer' },
					{ name: 'tagId', type: 'integer' },
				],
			},
			categories: {
				columns: [
					{ name: 'id', type: 'integer' },
					{ name: 'name', type: 'string' },
					{ name: 'parentId', type: 'integer' },
				],
				pseudoColumns: [
					{
						table: 'categories',
						foreignKeyColumn: 'parentId',
						targetColumn: 'id',
						parentRole: 'parent',
						childRole: 'children',
						ascendantKeyword: 'ascendant',
						descendantKeyword: 'descendant',
					},
				],
			},
			profiles: {
				columns: [
					{ name: 'id', type: 'integer' },
					{ name: 'userId', type: 'integer' },
					{ name: 'companyId', type: 'integer' },
					{ name: 'bio', type: 'string' },
				],
			},
			companies: {
				columns: [
					{ name: 'id', type: 'integer' },
					{ name: 'name', type: 'string' },
				],
			},
		};
		return tables[name];
	},
	getRelationsFrom(sourceTable: string) {
		const relations: Record<string, TestRelation[]> = {
			users: [
				{
					name: 'posts',
					source: 'users',
					target: 'posts',
					type: 'hasMany',
					foreignKey: 'authorId',
				},
				{
					name: 'orders',
					source: 'users',
					target: 'orders',
					type: 'hasMany',
					foreignKey: 'userId',
				},
				{
					name: 'profile',
					source: 'users',
					target: 'profiles',
					type: 'hasOne',
					foreignKey: 'userId',
				},
			],
			posts: [
				{
					name: 'author',
					source: 'posts',
					target: 'users',
					type: 'belongsTo',
					foreignKey: 'authorId',
				},
				{
					name: 'category',
					source: 'posts',
					target: 'categories',
					type: 'belongsTo',
					foreignKey: 'categoryId',
				},
				{
					name: 'comments',
					source: 'posts',
					target: 'comments',
					type: 'hasMany',
					foreignKey: 'postId',
				},
				{
					name: 'tags',
					source: 'posts',
					target: 'tags',
					type: 'belongsToMany',
					through: 'postTags',
					foreignKey: 'postId',
					otherKey: 'tagId',
				},
			],
			tags: [
				{
					name: 'posts',
					source: 'tags',
					target: 'posts',
					type: 'belongsToMany',
					through: 'postTags',
					foreignKey: 'tagId',
					otherKey: 'postId',
				},
			],
			orders: [],
			profiles: [
				{
					name: 'company',
					source: 'profiles',
					target: 'companies',
					type: 'belongsTo',
					foreignKey: 'companyId',
				},
			],
			companies: [],
			categories: [
				{
					name: 'parent',
					source: 'categories',
					target: 'categories',
					type: 'belongsTo',
					foreignKey: 'parentId',
					recursive: { direction: 'ancestors' },
				},
				{
					name: 'children',
					source: 'categories',
					target: 'categories',
					type: 'hasMany',
					foreignKey: 'parentId',
					recursive: { direction: 'descendants' },
				},
			],
		};
		return relations[sourceTable] ?? [];
	},
	getRelation(qualifiedName: string) {
		const [source, relationName] = qualifiedName.split('.');
		if (!source || !relationName) return undefined;
		return this.getRelationsFrom(source).find(
			(relation) => relation.name === relationName,
		);
	},
	getRelationsTo() {
		return [];
	},
};

function compilerContextForValidator(
	validator: ColumnValidator,
): CompilerContext {
	return {
		currentFromTable: undefined,
		currentRelationTarget: undefined,
		pseudoColumnKeywords: new Set(),
		recursiveKeywords: new Set(),
		validator,
		bindingOutputColumns: new Map(),
		bindingRelationFilters: new Map(),
		params: {},
		maxAnyItems: 10_000,
		allowUnfilteredMutations: false,
		allowInternalParams: false,
	};
}

function compileNql(input: string) {
	const result = compile(input, schema);
	if (!result.success) {
		throw new Error(`Compile error: ${result.errors[0]?.message}`);
	}
	return result;
}

function compileWithReusableCompiler(compiler: NqlCompiler, input: string) {
	const parsed = parse(input);
	if (!parsed.success || !parsed.ast) {
		throw new Error(`Parse error: ${parsed.errors[0]?.message}`);
	}
	return compiler.compile(parsed.ast);
}

function parseProgram(input: string): NqlProgram {
	const parsed = parse(input);
	if (!parsed.success || !parsed.ast) {
		throw new Error(`Parse error: ${parsed.errors[0]?.message}`);
	}
	return parsed.ast;
}

// ============================================================================
// Set Operations
// ============================================================================

describe('set operations', () => {
	it('compiles UNION to SetOperationIntent', () => {
		const result = compileNql(
			'users | select id, name | union (users | select id, email)',
		);
		expect(result.ast?.setOperation).toBeDefined();
		expect(result.ast?.setOperation?.op).toBe('union');
		expect(result.ast?.setOperation?.all).toBe(false);
	});

	it('compiles UNION ALL', () => {
		const result = compileNql(
			'users | select id, name | union all (users | select id, email)',
		);
		expect(result.ast?.setOperation).toBeDefined();
		expect(result.ast?.setOperation?.op).toBe('union');
		expect(result.ast?.setOperation?.all).toBe(true);
	});

	it('compiles INTERSECT', () => {
		const result = compileNql(
			'users | select id | intersect (orders | select id)',
		);
		expect(result.ast?.setOperation).toBeDefined();
		expect(result.ast?.setOperation?.op).toBe('intersect');
		expect(result.ast?.setOperation?.all).toBe(false);
	});

	it('compiles EXCEPT', () => {
		const result = compileNql(
			'users | select id | except (orders | select id)',
		);
		expect(result.ast?.setOperation).toBeDefined();
		expect(result.ast?.setOperation?.op).toBe('except');
		expect(result.ast?.setOperation?.all).toBe(false);
	});

	it('compiles INTERSECT ALL', () => {
		const result = compileNql(
			'users | select id | intersect all (orders | select id)',
		);
		expect(result.ast?.setOperation).toBeDefined();
		expect(result.ast?.setOperation?.op).toBe('intersect');
		expect(result.ast?.setOperation?.all).toBe(true);
	});

	it('compiles EXCEPT ALL', () => {
		const result = compileNql(
			'users | select id | except all (orders | select id)',
		);
		expect(result.ast?.setOperation).toBeDefined();
		expect(result.ast?.setOperation?.op).toBe('except');
		expect(result.ast?.setOperation?.all).toBe(true);
	});
});

// ============================================================================
// GROUP BY
// ============================================================================

describe('GROUP BY clause', () => {
	it('compiles simple GROUP BY', () => {
		const result = compileNql(
			'users | group by department | select department, count() as cnt',
		);
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.groupBy).toEqual(['department']);
	});

	it('compiles GROUP BY with multiple fields', () => {
		const result = compileNql(
			'users | group by department, active | select department, active, count() as cnt',
		);
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.groupBy).toEqual(['department', 'active']);
	});

	it('WHERE after GROUP BY becomes HAVING', () => {
		// Note: count used as a column name here (not a function call) because
		// comparison requires a field reference on the left side
		const result = compileNql(
			'orders | group by status | where total > 5 | select status',
		);
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.groupBy).toEqual(['status']);
		expect(result.ast?.query?.having).toBeDefined();
		// The WHERE clause after GROUP BY should produce a HAVING intent
		expect(result.ast?.query?.where).toBeUndefined();
	});

	it('WHERE before GROUP BY stays as WHERE', () => {
		const result = compileNql(
			'users | where active = true | group by department | select department, count() as cnt',
		);
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.groupBy).toEqual(['department']);
		expect(result.ast?.query?.where).toBeDefined();
	});
});

// ============================================================================
// ORDER BY
// ============================================================================

describe('ORDER BY clause', () => {
	it('compiles ORDER BY ASC (default)', () => {
		const result = compileNql('users | order by name');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.orderBy).toEqual([
			{ field: 'name', direction: 'asc' },
		]);
	});

	it('compiles ORDER BY ASC (explicit)', () => {
		const result = compileNql('users | order by name asc');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.orderBy).toEqual([
			{ field: 'name', direction: 'asc' },
		]);
	});

	it('compiles ORDER BY DESC', () => {
		const result = compileNql('users | order by name desc');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.orderBy).toEqual([
			{ field: 'name', direction: 'desc' },
		]);
	});

	it('compiles ORDER BY multiple columns', () => {
		const result = compileNql('users | order by department asc, name desc');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.orderBy).toEqual([
			{ field: 'department', direction: 'asc' },
			{ field: 'name', direction: 'desc' },
		]);
	});

	it('compiles ORDER BY with multiple columns, mixed directions', () => {
		const result = compileNql('users | order by department, name desc, id');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.orderBy).toHaveLength(3);
		expect(result.ast?.query?.orderBy?.[0]?.direction).toBe('asc');
		expect(result.ast?.query?.orderBy?.[1]?.direction).toBe('desc');
		expect(result.ast?.query?.orderBy?.[2]?.direction).toBe('asc');
	});
});

// ============================================================================
// DISTINCT
// ============================================================================

describe('DISTINCT', () => {
	it('compiles SELECT DISTINCT', () => {
		const result = compileNql('users | select distinct name');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.distinct).toBe(true);
	});

	it('omits distinct when not specified', () => {
		const result = compileNql('users | select name');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.distinct).toBeUndefined();
	});
});

// ============================================================================
// Includes via relation paths in SELECT
// ============================================================================

describe('includes via relation paths in SELECT', () => {
	it('auto-generates include from relation.column in SELECT', () => {
		const result = compileNql('users | select id, posts.title');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.include).toBeDefined();
		expect(result.ast?.query?.include).toHaveLength(1);
		expect(result.ast?.query?.include?.[0]?.relation).toBe('posts');
	});

	it('auto-generates multiple includes from multiple relation paths', () => {
		const result = compileNql('users | select id, posts.title, orders.total');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.include).toHaveLength(2);
		const relationNames = result.ast?.query?.include?.map(
			(inc) => inc.relation,
		);
		expect(relationNames).toContain('posts');
		expect(relationNames).toContain('orders');
	});

	it('does not duplicate includes for same relation', () => {
		const result = compileNql('users | select posts.title, posts.body');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.include).toHaveLength(1);
		expect(result.ast?.query?.include?.[0]?.relation).toBe('posts');
	});
});

describe('binding-final query sources', () => {
	it('does not leak virtual binding tables across successful compile calls on a reused compiler', () => {
		const compiler = new NqlCompiler(undefined, schema);

		expect(() =>
			compileWithReusableCompiler(
				compiler,
				'users | select id | bind projected_users\nprojected_users | select id',
			),
		).not.toThrow();
		expect(() =>
			compileWithReusableCompiler(compiler, 'projected_users | select id'),
		).toThrow(/Table 'projected_users' does not exist/);
	});

	it('clears virtual binding tables when a reused compiler compile throws', () => {
		const compiler = new NqlCompiler(undefined, schema);

		expect(() =>
			compileWithReusableCompiler(
				compiler,
				'users | select id | bind projected_users\nprojected_users | select email',
			),
		).toThrow(
			/Column 'email' is not projected by NQL binding 'projected_users'/,
		);
		expect(() =>
			compileWithReusableCompiler(compiler, 'projected_users | select id'),
		).toThrow(/Table 'projected_users' does not exist/);
	});

	it('accepts a final query FROM that references a declared bind name with schema validation enabled', () => {
		const result = compile(
			'users | where active = true | select id | bind active_users\nactive_users | select id',
			schema,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.bindings?.has('active_users')).toBe(true);
		expect(result.ast?.query?.from).toBe('active_users');
	});

	it('records a final query FROM binding as a dependency for CTE retention (#173)', () => {
		const result = compile(
			'posts | where id >= 3 | select id | bind recent_posts\nrecent_posts | select id',
			schema,
		);
		const sequence = result.ast?.nqlProgramSequence as
			| readonly { readonly bindingDependencies?: readonly string[] }[]
			| undefined;

		expect(result.success).toBe(true);
		expect(result.ast?.bindings?.has('recent_posts')).toBe(true);
		expect(result.ast?.query?.from).toBe('recent_posts');
		expect(sequence?.at(-1)?.bindingDependencies).toEqual(['recent_posts']);
	});

	it('tags a final query read binding reference across mutation', () => {
		const result = compile(
			`users | select id | bind active_users
insert into users set name = 'Alice' | select id | bind created_user
active_users | select id`,
			schema,
		);
		const sequence = result.ast?.nqlProgramSequence;

		expect(result.success).toBe(true);
		expect(sequence?.[0]).toMatchObject({
			kind: 'query',
			bindName: 'active_users',
			snapshot: true,
		});
		expect(sequence?.[1]).toMatchObject({
			kind: 'mutation',
			bindName: 'created_user',
		});
	});

	it.each([
		['WITH CTE body', 'with ids as (active_users | select id) ids | select id'],
		[
			'WITH outer query',
			'with passthrough as (users | select id) active_users | select id',
		],
	])('accepts read binding references across mutation inside %s', (_label, finalStatement) => {
		const result = compile(
			`users | select id | bind active_users
insert into users set name = 'Alice' | select id | bind created_user
${finalStatement}`,
			schema,
		);

		expect(result.success).toBe(true);
	});

	it('accepts IN subqueries over real tables from a final query that reads a bind source', () => {
		const result = compile(
			'posts | where published = false | select id | bind draft_posts\ndraft_posts | where id in (comments | select postId) | select id',
			schema,
		);

		expect(result.success).toBe(true);
	});

	it('recursively validates binding-sourced IN subqueries in their own binding context', () => {
		const result = compile(
			'users | select id | bind projected_users\norders | select userId | bind order_user_ids\nprojected_users | where id in (order_user_ids | select userId) | select id',
			schema,
		);

		expect(result.success).toBe(true);
	});

	it('rejects invalid columns inside binding-sourced IN subqueries against the subquery binding projection', () => {
		const result = compile(
			'users | select id | bind projected_users\norders | select userId | bind order_user_ids\nprojected_users | where id in (order_user_ids | select total) | select id',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Column 'total' is not projected by NQL binding 'order_user_ids'.*Available columns: userId/,
		);
	});

	it('rejects SELECT columns that were not projected by the referenced bind', () => {
		const result = compile(
			'users | select id | bind active_users\nactive_users | select email',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Column 'email' is not projected by NQL binding 'active_users'.*Available columns: id/,
		);
	});

	it('rejects WHERE columns that were not projected by the referenced bind', () => {
		const result = compile(
			"users | select id | bind active_users\nactive_users | where email = 'a@example.com' | select id",
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Column 'email' is not projected by NQL binding 'active_users'.*Available columns: id/,
		);
	});

	it('rejects ORDER BY columns that were not projected by the referenced bind', () => {
		const result = compile(
			'users | select id | bind active_users\nactive_users | select id | order by email',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Column 'email' is not projected by NQL binding 'active_users'.*Available columns: id/,
		);
	});

	it('rejects GROUP BY columns that were not projected by the referenced bind', () => {
		const result = compile(
			'users | select id | bind active_users\nactive_users | group by email | select id',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Column 'email' is not projected by NQL binding 'active_users'.*Available columns: id/,
		);
	});

	it('rejects ORDER BY expression columns that were not projected by the referenced bind', () => {
		const result = compile(
			'users | select id | bind active_users\nactive_users | select id | order by email + id',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Column 'email' is not projected by NQL binding 'active_users'.*Available columns: id/,
		);
	});

	it('rejects GROUP BY expression columns that were not projected by the referenced bind', () => {
		const result = compile(
			'users | select id | bind active_users\nactive_users | group by upper(email) | select id',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Column 'email' is not projected by NQL binding 'active_users'.*Available columns: id/,
		);
	});

	it('accepts projected aliases from the referenced bind and rejects the original column name', () => {
		const aliased = compile(
			'users | select id as userId, name | bind projected_users\nprojected_users | where userId > 1 | select userId, name | order by userId',
			schema,
		);
		expect(aliased.success).toBe(true);

		const original = compile(
			'users | select id as userId | bind projected_users\nprojected_users | select id',
			schema,
		);
		expect(original.success).toBe(false);
		expect(original.errors[0]?.message).toMatch(
			/Column 'id' is not projected by NQL binding 'projected_users'.*Available columns: userId/,
		);
	});

	it('validates final bind-source columns by exact logical projected name, not DB casing aliases', () => {
		const logical = compile(
			'users | select id as userId | bind projected_users\nprojected_users | select userId',
			schema,
		);
		expect(logical.success).toBe(true);

		const dbLayer = compile(
			'users | select id as userId | bind projected_users\nprojected_users | select user_id',
			schema,
		);
		expect(dbLayer.success).toBe(false);
		expect(dbLayer.errors[0]?.message).toMatch(
			/Column 'user_id' is not projected by NQL binding 'projected_users'.*Available columns: userId/,
		);
	});

	it('accepts GROUP BY columns that were projected by the referenced bind', () => {
		const result = compile(
			'users | select department | bind departments\ndepartments | group by department | select department',
			schema,
		);

		expect(result.success).toBe(true);
	});

	it('allows portable common-ground clauses from a final query that reads a bind source', () => {
		const result = compile(
			'users | select id, department, salary | bind projected_users\nprojected_users | where salary > 100 | group by department | where count(*) > 0 | select distinct department, count(id) as total | order by department | limit 10 | offset 1',
			schema,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.query?.from).toBe('projected_users');
		expect(result.ast?.query?.distinct).toBe(true);
		expect(result.ast?.query?.groupBy).toEqual(['department']);
		expect(result.ast?.query?.having).toBeDefined();
		expect(result.ast?.query?.limit).toBe(10);
		expect(result.ast?.query?.offset).toBe(1);
	});

	it('allows set operations whose leaves read from bind sources', () => {
		const result = compile(
			'users | select id | bind projected_users\nprojected_users | select id | union (users | select id)',
			schema,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.setOperation?.op).toBe('union');
	});

	it('rejects row-level locks from a final query that reads a bind source (ref #183)', () => {
		const result = compile(
			'users | select id | bind projected_users\nprojected_users | select id | for update skip locked',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/#183/);
		expect(result.errors[0]?.message).toMatch(/lock|FOR UPDATE|SKIP LOCKED/i);
	});

	it('rejects DISTINCT ON from a final query that reads a bind source (ref #183)', () => {
		const ast = parseProgram(
			'users | select id | bind projected_users\nprojected_users | select id',
		);
		const finalQuery = ast.statements[1] as NqlQuery;
		const selectClause = finalQuery.clauses.find((c) => c.type === 'select') as
			| (NqlClause & { distinctOn?: string[] })
			| undefined;
		expect(selectClause).toBeDefined();
		selectClause!.distinctOn = ['id'];

		expect(() => new NqlCompiler(undefined, schema).compile(ast)).toThrow(
			/#183.*DISTINCT ON|DISTINCT ON.*#183/,
		);
	});

	it('rejects window functions from a final query that reads a bind source (ref #183)', () => {
		const result = compile(
			'users | select id, salary | bind projected_users\nprojected_users | select id, row_number() over (order by salary) as rn',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/#183/);
		expect(result.errors[0]?.message).toMatch(/window/i);
	});

	it('rejects PostgreSQL range operators from a final query that reads a bind source (ref #183)', () => {
		const result = compile(
			'users | select id, salary | bind projected_users\nprojected_users | where salary contains 25 | select id',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/#183/);
		expect(result.errors[0]?.message).toMatch(/range/i);
	});

	it('rejects ANY(:param) from a final query that reads a bind source (ref #183)', () => {
		const result = compile(
			'users | select id | bind projected_users\nprojected_users | where id = ANY(:ids) | select id',
			schema,
			undefined,
			{ params: { ids: [1, 2] } },
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/#183/);
		expect(result.errors[0]?.message).toMatch(/ANY/i);
	});

	it.each([
		'some',
		'none',
		'every',
	] as const)('allows binding-final %s(author) when the binding projects the source FK (ref #182)', (mode) => {
		const result = compile(
			`posts | select id, authorId | bind projected_posts
projected_posts | where ${mode}(author).email = 'alice@example.com' | select id`,
			schema,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.query?.where).toMatchObject({
			kind: 'relationFilter',
			relation: ['author'],
			mode,
			targetTable: 'users',
			sourceColumn: ['authorId'],
			targetColumn: ['id'],
		});
		expect(hasNqlTrustedRelationFilterProof(result.ast?.query?.where)).toBe(
			true,
		);
		const payload = getTrustedNqlRelationFilterFields(result.ast?.query?.where);
		expect(payload).toEqual({
			relation: 'author',
			targetTable: 'users',
			sourceColumn: ['authorId'],
			targetColumn: ['id'],
			hops: [],
			cardinality: 'one',
		});
		expect(Object.isFrozen(payload)).toBe(true);
		expect(Object.isFrozen(payload?.sourceColumn)).toBe(true);
		expect(Object.isFrozen(payload?.targetColumn)).toBe(true);
		try {
			if (payload) {
				(payload as { targetTable: string }).targetTable = 'forged_users';
			}
		} catch {
			// Frozen payloads throw in strict mode; either way, mutation must not stick.
		}
		expect(payload?.targetTable).toBe('users');
		expect(
			result.ast?.bindingOutputSchemas?.get('projected_posts')?.relationFilters
				?.relations,
		).toEqual([
			{
				relation: 'author',
				sourceTable: 'posts',
				targetTable: 'users',
				sourceColumn: ['authorId'],
				targetColumn: ['id'],
				hops: [],
				cardinality: 'one',
			},
		]);
	});

	it('allows binding-final belongsTo scalar relation columns with a frozen trusted proof', () => {
		const result = compile(
			`posts | select id, authorId | bind projected_posts
projected_posts | select id, author.name`,
			schema,
		);

		expect(result.success).toBe(true);
		const relationColumn =
			result.ast?.query?.select?.type === 'expressions'
				? result.ast.query.select.columns.find(
						(column) => column.kind === 'relationColumn',
					)
				: undefined;
		expect(relationColumn).toMatchObject({
			kind: 'relationColumn',
			relation: 'author',
			column: 'name',
			as: 'author.name',
		});
		const payload = getTrustedNqlRelationFilterFields(relationColumn);
		expect(payload).toEqual({
			relation: 'author',
			targetTable: 'users',
			sourceColumn: ['authorId'],
			targetColumn: ['id'],
			hops: [],
			selectedColumn: 'name',
			cardinality: 'one',
			relationType: 'belongsTo',
		});
		expect(Object.isFrozen(payload)).toBe(true);
		expect(result.ast?.query?.include).toBeUndefined();
	});

	it('allows binding-final hasOne scalar relation columns when the source key is directly projected', () => {
		const result = compile(
			`users | select id | bind projected_users
projected_users | select id, profile.bio`,
			schema,
		);

		expect(result.success).toBe(true);
		const relationColumn =
			result.ast?.query?.select?.type === 'expressions'
				? result.ast.query.select.columns.find(
						(column) => column.kind === 'relationColumn',
					)
				: undefined;
		expect(getTrustedNqlRelationFilterFields(relationColumn)).toEqual({
			relation: 'profile',
			targetTable: 'profiles',
			sourceColumn: ['id'],
			targetColumn: ['userId'],
			hops: [],
			selectedColumn: 'bio',
			cardinality: 'one',
			relationType: 'hasOne',
		});
		expect(result.ast?.query?.include).toBeUndefined();
	});

	it('allows binding-final hasMany relation columns with a frozen trusted proof', () => {
		const result = compile(
			`users | select id | bind projected_users
projected_users | select posts.title`,
			schema,
		);

		expect(result.success).toBe(true);
		const relationColumn =
			result.ast?.query?.select?.type === 'expressions'
				? result.ast.query.select.columns.find(
						(column) => column.kind === 'relationColumn',
					)
				: undefined;
		expect(relationColumn).toMatchObject({
			kind: 'relationColumn',
			relation: 'posts',
			column: 'title',
			as: 'posts.title',
		});
		const payload = getTrustedNqlRelationFilterFields(relationColumn);
		expect(payload).toEqual({
			relation: 'posts',
			targetTable: 'posts',
			sourceColumn: ['id'],
			targetColumn: ['authorId'],
			hops: [],
			selectedColumn: 'title',
			cardinality: 'many',
			relationType: 'hasMany',
		});
		expect(Object.isFrozen(payload)).toBe(true);
		expect(result.ast?.query?.include).toBeUndefined();
	});

	it('allows binding-final many-to-many relation columns with frozen junction proof', () => {
		const result = compile(
			`posts | select id | bind projected_posts
projected_posts | select tags.name`,
			schema,
		);

		expect(result.success).toBe(true);
		const relationColumn =
			result.ast?.query?.select?.type === 'expressions'
				? result.ast.query.select.columns.find(
						(column) => column.kind === 'relationColumn',
					)
				: undefined;
		expect(relationColumn).toMatchObject({
			kind: 'relationColumn',
			relation: 'tags',
			column: 'name',
			as: 'tags.name',
		});
		const payload = getTrustedNqlRelationFilterFields(relationColumn);
		expect(payload).toEqual({
			relation: 'tags',
			targetTable: 'tags',
			sourceColumn: ['id'],
			targetColumn: ['id'],
			hops: [],
			through: 'postTags',
			throughSourceColumn: 'postId',
			throughTargetColumn: 'tagId',
			selectedColumn: 'name',
			cardinality: 'many',
			relationType: 'manyToMany',
		});
		expect(Object.isFrozen(payload)).toBe(true);
		expect(Object.isFrozen(payload?.throughSourceColumn)).toBe(true);
		expect(result.ast?.query?.include).toBeUndefined();
	});

	it('allows binding-final many-to-many relation columns in the reverse direction', () => {
		const result = compile(
			`tags | select id | bind projected_tags
projected_tags | select posts.title`,
			schema,
		);

		expect(result.success).toBe(true);
		const relationColumn =
			result.ast?.query?.select?.type === 'expressions'
				? result.ast.query.select.columns.find(
						(column) => column.kind === 'relationColumn',
					)
				: undefined;
		expect(getTrustedNqlRelationFilterFields(relationColumn)).toMatchObject({
			relation: 'posts',
			targetTable: 'posts',
			sourceColumn: ['id'],
			targetColumn: ['id'],
			through: 'postTags',
			throughSourceColumn: 'tagId',
			throughTargetColumn: 'postId',
			selectedColumn: 'title',
			cardinality: 'many',
			relationType: 'manyToMany',
		});
	});

	it('rejects binding-final many-to-many relation columns without a resolvable junction', () => {
		const unresolvedJunctionSchema = {
			...schema,
			getRelationsFrom(sourceTable: string) {
				if (sourceTable !== 'posts')
					return schema.getRelationsFrom(sourceTable);
				return [
					{
						name: 'tags',
						source: 'posts',
						target: 'tags',
						type: 'belongsToMany' as const,
						foreignKey: 'postId',
					},
				];
			},
			getRelation(qualifiedName: string) {
				const [source, relationName] = qualifiedName.split('.');
				if (!source || !relationName) return undefined;
				return this.getRelationsFrom(source).find(
					(relation) => relation.name === relationName,
				);
			},
		};
		const result = compile(
			`posts | select id | bind projected_posts
projected_posts | select tags.name`,
			unresolvedJunctionSchema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/resolvable junction/);
		expect(result.errors[0]?.message).toMatch(/ref-#192/);
	});

	it('rejects binding-final many-to-many relation columns with composite junction keys', () => {
		const compositeJunctionSchema = {
			...schema,
			getRelationsFrom(sourceTable: string) {
				if (sourceTable !== 'posts')
					return schema.getRelationsFrom(sourceTable);
				return [
					{
						name: 'tags',
						source: 'posts',
						target: 'tags',
						type: 'belongsToMany' as const,
						through: 'postTags',
						foreignKey: ['postId', 'tenantId'],
						otherKey: 'tagId',
					},
				];
			},
			getRelation(qualifiedName: string) {
				const [source, relationName] = qualifiedName.split('.');
				if (!source || !relationName) return undefined;
				return this.getRelationsFrom(source).find(
					(relation) => relation.name === relationName,
				);
			},
		};
		const result = compile(
			`posts | select id | bind projected_posts
projected_posts | select tags.name`,
			compositeJunctionSchema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/junction source FK/);
		expect(result.errors[0]?.message).toMatch(/ref-#179/);
	});

	it('rejects binding-final many-to-many relation columns as a tail hop', () => {
		const result = compile(
			`posts | select id | bind projected_posts
projected_posts | select tags.posts.title`,
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/relation 'tags'/);
		expect(result.errors[0]?.message).toMatch(/junction/);
		expect(result.errors[0]?.message).toMatch(/ref-#192/);
	});

	it('rejects binding-final belongsToMany relationStar includes because junction traversal is unsupported', () => {
		const result = compile(
			`posts | select id | bind projected_posts
projected_posts | select tags.*`,
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/belongsToMany/);
		expect(result.errors[0]?.message).toMatch(/junction/);
		expect(result.errors[0]?.message).toMatch(/ref-#192/);
	});

	it('accepts binding-final belongsTo relationStar as a proven single-level include', () => {
		const result = compile(
			`posts | select id, authorId | bind projected_posts
projected_posts | select author.*`,
			schema,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.query?.include).toEqual([{ relation: 'author' }]);
		const relationColumn =
			result.ast?.query?.select?.type === 'expressions'
				? result.ast.query.select.columns.find(
						(column) =>
							column.kind === 'relationColumn' && column.relation === 'author',
					)
				: undefined;
		expect(relationColumn).toMatchObject({
			kind: 'relationColumn',
			relation: 'author',
			column: '*',
			as: 'author.*',
		});
	});

	it('accepts binding-final hasMany relationStar as a proven single-level include', () => {
		const result = compile(
			`users | select id | bind projected_users
projected_users | select *, posts.*`,
			schema,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.query?.include).toEqual([{ relation: 'posts' }]);
	});

	it('accepts binding-final two-hop to-one scalar relation columns with frozen hops', () => {
		const result = compile(
			`posts | select id, authorId | bind projected_posts
projected_posts | select author.profile.bio`,
			schema,
		);

		expect(result.success).toBe(true);
		const relationColumn =
			result.ast?.query?.select?.type === 'expressions'
				? result.ast.query.select.columns.find(
						(column) => column.kind === 'relationColumn',
					)
				: undefined;
		expect(relationColumn).toMatchObject({
			kind: 'relationColumn',
			relation: 'author.profile',
			column: 'bio',
			as: 'author.profile.bio',
		});
		const payload = getTrustedNqlRelationFilterFields(relationColumn);
		expect(payload).toEqual({
			relation: 'author.profile',
			targetTable: 'users',
			sourceColumn: ['authorId'],
			targetColumn: ['id'],
			hops: [{ target: 'profiles', fkColumn: ['id'], joinColumn: ['userId'] }],
			selectedColumn: 'bio',
			cardinality: 'one',
			relationType: 'belongsTo',
		});
		expect(Object.isFrozen(payload)).toBe(true);
		expect(Object.isFrozen(payload?.hops)).toBe(true);
		expect(Object.isFrozen(payload?.hops[0])).toBe(true);
		expect(Object.isFrozen(payload?.hops[0]?.fkColumn)).toBe(true);
		expect(Object.isFrozen(payload?.hops[0]?.joinColumn)).toBe(true);
		expect(result.ast?.query?.include).toBeUndefined();
	});

	it('accepts binding-final three-hop to-one scalar relation columns with ordered frozen hops', () => {
		const result = compile(
			`posts | select id, authorId | bind projected_posts
projected_posts | select author.profile.company.name`,
			schema,
		);

		expect(result.success).toBe(true);
		const relationColumn =
			result.ast?.query?.select?.type === 'expressions'
				? result.ast.query.select.columns.find(
						(column) => column.kind === 'relationColumn',
					)
				: undefined;
		expect(getTrustedNqlRelationFilterFields(relationColumn)).toMatchObject({
			relation: 'author.profile.company',
			targetTable: 'users',
			sourceColumn: ['authorId'],
			targetColumn: ['id'],
			hops: [
				{ target: 'profiles', fkColumn: ['id'], joinColumn: ['userId'] },
				{ target: 'companies', fkColumn: ['companyId'], joinColumn: ['id'] },
			],
			selectedColumn: 'name',
			cardinality: 'one',
			relationType: 'belongsTo',
		});
	});

	it('rejects binding-final multi-hop scalar relation columns whose first hop is hasMany', () => {
		const result = compile(
			`users | select id | bind projected_users
projected_users | select posts.comments.body`,
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/relation 'posts' is 'hasMany'/);
		expect(result.errors[0]?.message).toMatch(/to-one/);
		expect(result.errors[0]?.message).toMatch(/ref-#192/);
	});

	it('rejects binding-final multi-hop scalar relation columns whose mid hop is hasMany', () => {
		const result = compile(
			`posts | select id, authorId | bind projected_posts
projected_posts | select author.posts.comments.body`,
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/tail relation 'posts' is 'hasMany'/,
		);
		expect(result.errors[0]?.message).toMatch(/to-one/);
		expect(result.errors[0]?.message).toMatch(/ref-#192/);
	});

	it('rejects binding-final multi-hop scalar relation columns whose leaf hop is hasMany', () => {
		const leafHasManySchema = {
			...schema,
			getRelationsFrom(sourceTable: string) {
				if (sourceTable !== 'profiles') {
					return schema.getRelationsFrom(sourceTable);
				}
				return [
					...schema.getRelationsFrom(sourceTable),
					{
						name: 'posts',
						source: 'profiles',
						target: 'posts',
						type: 'hasMany' as const,
						foreignKey: 'authorId',
					},
				];
			},
			getRelation(qualifiedName: string) {
				const [source, relationName] = qualifiedName.split('.');
				if (!source || !relationName) return undefined;
				return this.getRelationsFrom(source).find(
					(relation) => relation.name === relationName,
				);
			},
		};
		const result = compile(
			`posts | select id, authorId | bind projected_posts
projected_posts | select author.profile.posts.title`,
			leafHasManySchema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/tail relation 'posts' is 'hasMany'/,
		);
		expect(result.errors[0]?.message).toMatch(/to-one/);
		expect(result.errors[0]?.message).toMatch(/ref-#192/);
	});

	it('rejects binding-final multi-hop scalar relation columns whose tail hop is belongsToMany', () => {
		const belongsToManyTailSchema = {
			...schema,
			getRelationsFrom(sourceTable: string) {
				if (sourceTable !== 'profiles') {
					return schema.getRelationsFrom(sourceTable);
				}
				return [
					...schema.getRelationsFrom(sourceTable),
					{
						name: 'tags',
						source: 'profiles',
						target: 'tags',
						type: 'belongsToMany' as const,
						foreignKey: 'id',
					},
				];
			},
			getRelation(qualifiedName: string) {
				const [source, relationName] = qualifiedName.split('.');
				if (!source || !relationName) return undefined;
				return this.getRelationsFrom(source).find(
					(relation) => relation.name === relationName,
				);
			},
		};
		const result = compile(
			`posts | select id, authorId | bind projected_posts
projected_posts | select author.profile.tags.name`,
			belongsToManyTailSchema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/tail relation 'tags'/);
		expect(result.errors[0]?.message).toMatch(/junction/);
		expect(result.errors[0]?.message).toMatch(/ref-#192/);
	});

	it('accepts binding-final multi-hop scalar relation columns whose tail hop has a composite FK', () => {
		const compositeTailSchema = {
			...schema,
			getTable(name: string) {
				if (name === 'profiles') {
					return {
						columns: [
							{ name: 'id' },
							{ name: 'userId' },
							{ name: 'companyId' },
							{ name: 'tenantId' },
							{ name: 'bio' },
						],
					};
				}
				if (name === 'companies') {
					return {
						columns: [{ name: 'id' }, { name: 'tenantId' }, { name: 'name' }],
					};
				}
				return schema.getTable(name);
			},
			getRelationsFrom(sourceTable: string) {
				if (sourceTable !== 'profiles') {
					return schema.getRelationsFrom(sourceTable);
				}
				return [
					{
						name: 'company',
						source: 'profiles',
						target: 'companies',
						type: 'belongsTo' as const,
						foreignKey: ['companyId', 'tenantId'],
						targetKey: ['id', 'tenantId'],
					},
				];
			},
			getRelation(qualifiedName: string) {
				const [source, relationName] = qualifiedName.split('.');
				if (!source || !relationName) return undefined;
				return this.getRelationsFrom(source).find(
					(relation) => relation.name === relationName,
				);
			},
		};
		const result = compile(
			`posts | select id, authorId | bind projected_posts
projected_posts | select author.profile.company.name`,
			compositeTailSchema,
		);

		expect(result.success).toBe(true);
		const relationColumn =
			result.ast?.query?.select?.type === 'expressions'
				? result.ast.query.select.columns.find(
						(column) => column.kind === 'relationColumn',
					)
				: undefined;
		expect(getTrustedNqlRelationFilterFields(relationColumn)).toMatchObject({
			relation: 'author.profile.company',
			sourceColumn: ['authorId'],
			targetColumn: ['id'],
			hops: [
				{ target: 'profiles', fkColumn: ['id'], joinColumn: ['userId'] },
				{
					target: 'companies',
					fkColumn: ['companyId', 'tenantId'],
					joinColumn: ['id', 'tenantId'],
				},
			],
			cardinality: 'one',
			relationType: 'belongsTo',
		});
	});

	it('rejects binding-final multi-hop scalar relation columns whose tail hop is recursive self-ref', () => {
		const result = compile(
			`posts | select id, categoryId | bind projected_posts
projected_posts | select category.parent.name`,
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/tail relation 'parent'/);
		expect(result.errors[0]?.message).toMatch(/recursive\/self-referential/);
		expect(result.errors[0]?.message).toMatch(/ref-#193/);
	});

	it('rejects binding-final multi-hop scalar relation columns with an unresolvable tail', () => {
		const result = compile(
			`posts | select id, authorId | bind projected_posts
projected_posts | select author.missing.name`,
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/ref-#192/);
		expect(result.errors[0]?.message).toMatch(
			/tail relation 'missing' is not declared on table 'users'/,
		);
	});

	it('accepts binding-final multi-level relationStar as a proven include with real-table tail', () => {
		const result = compile(
			`users | select id | bind projected_users
projected_users | select posts.comments.*`,
			schema,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.query?.include).toEqual([
			{ relation: 'posts', include: [{ relation: 'comments' }] },
		]);
		const relationColumn =
			result.ast?.query?.select?.type === 'expressions'
				? result.ast.query.select.columns.find(
						(column) =>
							column.kind === 'relationColumn' &&
							column.relation === 'posts.comments',
					)
				: undefined;
		expect(relationColumn).toMatchObject({
			kind: 'relationColumn',
			relation: 'posts.comments',
			column: '*',
			as: 'posts.comments.*',
		});
	});

	it('rejects binding-final multi-level relationStar includes whose tail hop is belongsToMany', () => {
		const result = compile(
			`users | select id | bind projected_users
projected_users | select posts.tags.*`,
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/tail relation 'tags'/);
		expect(result.errors[0]?.message).toMatch(/junction/);
		expect(result.errors[0]?.message).toMatch(/ref-#192/);
	});

	it('accepts binding-final multi-level relationStar includes whose tail hop has a composite FK', () => {
		const compositeTailSchema = {
			...schema,
			getTable(name: string) {
				if (name === 'posts') {
					return {
						columns: [
							{ name: 'id' },
							{ name: 'title' },
							{ name: 'body' },
							{ name: 'authorId' },
							{ name: 'tenantId' },
							{ name: 'categoryId' },
							{ name: 'published' },
						],
					};
				}
				if (name === 'comments') {
					return {
						columns: [
							{ name: 'id' },
							{ name: 'postId' },
							{ name: 'tenantId' },
							{ name: 'body' },
						],
					};
				}
				return schema.getTable(name);
			},
			getRelationsFrom(sourceTable: string) {
				if (sourceTable !== 'posts')
					return schema.getRelationsFrom(sourceTable);
				return [
					{
						name: 'author',
						source: 'posts',
						target: 'users',
						type: 'belongsTo' as const,
						foreignKey: 'authorId',
					},
					{
						name: 'comments',
						source: 'posts',
						target: 'comments',
						type: 'hasMany' as const,
						foreignKey: ['postId', 'tenantId'],
						sourceKey: ['id', 'tenantId'],
					},
					{
						name: 'tags',
						source: 'posts',
						target: 'tags',
						type: 'belongsToMany' as const,
						foreignKey: 'id',
					},
				];
			},
			getRelation(qualifiedName: string) {
				const [source, relationName] = qualifiedName.split('.');
				if (!source || !relationName) return undefined;
				return this.getRelationsFrom(source).find(
					(relation) => relation.name === relationName,
				);
			},
		};
		const result = compile(
			`users | select id | bind projected_users
projected_users | select posts.comments.*`,
			compositeTailSchema,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.query?.include).toEqual([
			{ relation: 'posts', include: [{ relation: 'comments' }] },
		]);
	});

	it('rejects binding-final multi-level relationStar includes whose tail hop is recursive self-ref', () => {
		const result = compile(
			`users | select id | bind projected_users
projected_users | select posts.category.children.*`,
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/tail relation 'children'/);
		expect(result.errors[0]?.message).toMatch(/recursive\/self-referential/);
		expect(result.errors[0]?.message).toMatch(/ref-#193/);
	});

	it('rejects binding-final multi-level relationStar includes with an unresolvable real-table tail', () => {
		const result = compile(
			`users | select id | bind projected_users
projected_users | select posts.missing.*`,
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/ref-#192/);
		expect(result.errors[0]?.message).toMatch(
			/tail relation 'missing' is not declared on table 'posts'/,
		);
	});

	it.each([
		['missing projected FK', 'id, title'],
		['fabricated FK alias', 'id, 1 as authorId'],
	] as const)('rejects binding-final belongsTo relation columns with %s', (_label, projection) => {
		const result = compile(
			`posts | select ${projection} | bind projected_posts
projected_posts | select author.name`,
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/ref-#182/);
		expect(result.errors[0]?.message).toMatch(/FK column 'authorId'/);
		expect(result.errors[0]?.message).toMatch(/direct source-column/);
	});

	it.each([
		['missing projected FK', 'id, title'],
		['fabricated FK alias', 'id, 1 as authorId'],
	] as const)('rejects binding-final belongsTo relationStar includes with %s', (_label, projection) => {
		const result = compile(
			`posts | select ${projection} | bind projected_posts
projected_posts | select author.*`,
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/ref-#192/);
		expect(result.errors[0]?.message).toMatch(/FK column 'authorId'/);
		expect(result.errors[0]?.message).toMatch(/direct source-column/);
	});

	it('allows binding-final relation columns for fully projected composite FK relations', () => {
		const compositeSchema = {
			...schema,
			getTable(name: string) {
				if (name === 'posts') {
					return {
						columns: [
							{ name: 'id' },
							{ name: 'title' },
							{ name: 'body' },
							{ name: 'authorId' },
							{ name: 'tenantId' },
							{ name: 'categoryId' },
							{ name: 'published' },
						],
					};
				}
				if (name === 'users') {
					return {
						columns: [
							{ name: 'id' },
							{ name: 'tenantId' },
							{ name: 'name' },
							{ name: 'email' },
							{ name: 'department' },
							{ name: 'active' },
							{ name: 'salary' },
						],
					};
				}
				return schema.getTable(name);
			},
			getRelationsFrom(sourceTable: string) {
				if (sourceTable !== 'posts')
					return schema.getRelationsFrom(sourceTable);
				return [
					{
						name: 'author',
						source: 'posts',
						target: 'users',
						type: 'belongsTo' as const,
						foreignKey: ['authorId', 'tenantId'],
						targetKey: ['id', 'tenantId'],
					},
				];
			},
			getRelation(qualifiedName: string) {
				const [source, relationName] = qualifiedName.split('.');
				if (!source || !relationName) return undefined;
				return this.getRelationsFrom(source).find(
					(relation) => relation.name === relationName,
				);
			},
		};
		const result = compile(
			`posts | select id, authorId, tenantId | bind projected_posts
projected_posts | select author.name`,
			compositeSchema,
		);

		expect(result.success).toBe(true);
		const relationColumn =
			result.ast?.query?.select?.type === 'expressions'
				? result.ast.query.select.columns.find(
						(column) => column.kind === 'relationColumn',
					)
				: undefined;
		expect(getTrustedNqlRelationFilterFields(relationColumn)).toMatchObject({
			relation: 'author',
			targetTable: 'users',
			sourceColumn: ['authorId', 'tenantId'],
			targetColumn: ['id', 'tenantId'],
			cardinality: 'one',
			relationType: 'belongsTo',
		});
	});

	it('allows binding-final relationStar includes for fully projected composite FK relations', () => {
		const compositeSchema = {
			...schema,
			getTable(name: string) {
				if (name === 'posts') {
					return {
						columns: [
							{ name: 'id' },
							{ name: 'title' },
							{ name: 'body' },
							{ name: 'authorId' },
							{ name: 'tenantId' },
							{ name: 'categoryId' },
							{ name: 'published' },
						],
					};
				}
				if (name === 'users') {
					return {
						columns: [
							{ name: 'id' },
							{ name: 'tenantId' },
							{ name: 'name' },
							{ name: 'email' },
							{ name: 'department' },
							{ name: 'active' },
							{ name: 'salary' },
						],
					};
				}
				return schema.getTable(name);
			},
			getRelationsFrom(sourceTable: string) {
				if (sourceTable !== 'posts')
					return schema.getRelationsFrom(sourceTable);
				return [
					{
						name: 'author',
						source: 'posts',
						target: 'users',
						type: 'belongsTo' as const,
						foreignKey: ['authorId', 'tenantId'],
						targetKey: ['id', 'tenantId'],
					},
				];
			},
			getRelation(qualifiedName: string) {
				const [source, relationName] = qualifiedName.split('.');
				if (!source || !relationName) return undefined;
				return this.getRelationsFrom(source).find(
					(relation) => relation.name === relationName,
				);
			},
		};
		const result = compile(
			`posts | select id, authorId, tenantId | bind projected_posts
projected_posts | select author.*`,
			compositeSchema,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.query?.include).toEqual([{ relation: 'author' }]);
	});

	it('allows binding-final hasMany relation columns for fully projected composite FK relations', () => {
		const compositeSchema = {
			...schema,
			getTable(name: string) {
				if (name === 'users') {
					return {
						columns: [
							{ name: 'id' },
							{ name: 'tenantId' },
							{ name: 'name' },
							{ name: 'email' },
							{ name: 'department' },
							{ name: 'active' },
							{ name: 'salary' },
						],
					};
				}
				if (name === 'posts') {
					return {
						columns: [
							{ name: 'id' },
							{ name: 'title' },
							{ name: 'body' },
							{ name: 'authorId' },
							{ name: 'tenantId' },
							{ name: 'categoryId' },
							{ name: 'published' },
						],
					};
				}
				return schema.getTable(name);
			},
			getRelationsFrom(sourceTable: string) {
				if (sourceTable !== 'users')
					return schema.getRelationsFrom(sourceTable);
				return [
					{
						name: 'posts',
						source: 'users',
						target: 'posts',
						type: 'hasMany' as const,
						foreignKey: ['authorId', 'tenantId'],
						sourceKey: ['id', 'tenantId'],
					},
				];
			},
			getRelation(qualifiedName: string) {
				const [source, relationName] = qualifiedName.split('.');
				if (!source || !relationName) return undefined;
				return this.getRelationsFrom(source).find(
					(relation) => relation.name === relationName,
				);
			},
		};
		const result = compile(
			`users | select id, tenantId | bind projected_users
projected_users | select posts.title`,
			compositeSchema,
		);

		expect(result.success).toBe(true);
		const relationColumn =
			result.ast?.query?.select?.type === 'expressions'
				? result.ast.query.select.columns.find(
						(column) => column.kind === 'relationColumn',
					)
				: undefined;
		expect(getTrustedNqlRelationFilterFields(relationColumn)).toMatchObject({
			relation: 'posts',
			targetTable: 'posts',
			sourceColumn: ['id', 'tenantId'],
			targetColumn: ['authorId', 'tenantId'],
			cardinality: 'many',
			relationType: 'hasMany',
		});
	});

	it('rejects binding-final composite FK relation columns when any FK column is not directly projected', () => {
		const compositeSchema = {
			...schema,
			getRelationsFrom(sourceTable: string) {
				if (sourceTable !== 'posts')
					return schema.getRelationsFrom(sourceTable);
				return [
					{
						name: 'author',
						source: 'posts',
						target: 'users',
						type: 'belongsTo' as const,
						foreignKey: ['authorId', 'tenantId'],
						targetKey: ['id', 'tenantId'],
					},
				];
			},
			getRelation(qualifiedName: string) {
				const [source, relationName] = qualifiedName.split('.');
				if (!source || !relationName) return undefined;
				return this.getRelationsFrom(source).find(
					(relation) => relation.name === relationName,
				);
			},
		};
		const result = compile(
			`posts | select id, authorId | bind projected_posts
projected_posts | select author.name`,
			compositeSchema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/ref-#182/);
		expect(result.errors[0]?.message).toMatch(/FK column 'tenantId'/);
		expect(result.errors[0]?.message).toMatch(/not projected/);
	});

	it('rejects binding-final relation columns when the binding body used relation includes', () => {
		const result = compile(
			`posts | select id, authorId, author.name | bind projected_posts
projected_posts | select author.name`,
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/ref-#182/);
		expect(result.errors[0]?.message).toMatch(/relation includes/);
	});

	it('rejects binding-final relation columns from nested read bindings', () => {
		const result = compile(
			`posts | select id, authorId | bind base_posts
base_posts | select id, authorId | bind projected_posts
projected_posts | select author.name`,
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/ref-#182/);
		expect(result.errors[0]?.message).toMatch(/another NQL binding/);
	});

	it('rejects binding-final relation columns when the binding body used joins', () => {
		const validator = new ColumnValidator(schema);
		const ctx = compilerContextForValidator(validator);
		const joinedBinding: QueryIntent = {
			type: 'select',
			from: 'posts',
			select: { type: 'fields', fields: ['id', 'authorId'] },
			joins: [{ relation: 'author', type: 'inner' }],
		};
		const outputSchema = getQueryOutputSchema(
			joinedBinding,
			ctx,
			'joined_posts',
		);
		validator.addVirtualBindingTable(
			'joined_posts',
			outputSchema.columns,
			outputSchema.relationFilters,
		);

		expect(outputSchema.relationFilters?.unsafeReason).toBe(
			'the binding body uses joins',
		);
		expect(() =>
			resolveBindingRelationColumn(ctx, 'joined_posts', ['author'], 'name'),
		).toThrow(/cannot select relation column 'author'.*uses joins/);
	});

	it('SEC-182: relation-filter proof cannot be forged by public fields or public symbols', () => {
		const forged = {
			kind: 'relationFilter',
			relation: ['author'],
			mode: 'some',
			where: {
				kind: 'comparison',
				field: 'email',
				operator: 'eq',
				value: 'alice@example.com',
			},
			targetTable: 'users',
			sourceColumn: ['authorId'],
			targetColumn: ['id'],
		};
		Object.defineProperty(
			forged,
			Symbol.for('@dbsp/nql/trustedRelationFilter'),
			{
				value: true,
				enumerable: false,
			},
		);
		Object.defineProperty(forged, Symbol('@dbsp/nql/trustedRelationFilter'), {
			value: true,
			enumerable: false,
		});

		expect(hasNqlTrustedRelationFilterProof(forged)).toBe(false);
		expect(getTrustedNqlRelationFilterFields(forged)).toBeUndefined();
	});

	it('allows binding-final relation filters when the FK is projected through a direct alias (ref #182)', () => {
		const result = compile(
			`posts | select id, authorId as writerId | bind projected_posts
projected_posts | where some(author).email = 'alice@example.com' | select id`,
			schema,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.query?.where).toMatchObject({
			kind: 'relationFilter',
			relation: ['author'],
			mode: 'some',
			targetTable: 'users',
			sourceColumn: ['writerId'],
			targetColumn: ['id'],
		});
	});

	it('allows binding-final relation filters when select * directly projects the source FK (ref #182)', () => {
		const result = compile(
			`posts | select * | bind projected_posts
projected_posts | where some(author).email = 'alice@example.com' | select id`,
			schema,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.query?.where).toMatchObject({
			kind: 'relationFilter',
			relation: ['author'],
			sourceColumn: ['authorId'],
			targetTable: 'users',
			targetColumn: ['id'],
		});
	});

	it('allows binding-final relation filters when the FK is projected with snake_case spelling (ref #182)', () => {
		const result = compile(
			"posts | select id, author_id | bind projected_posts\nprojected_posts | where some(author).email = 'alice@example.com' | select id",
			schema,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.query?.where).toMatchObject({
			kind: 'relationFilter',
			sourceColumn: ['author_id'],
			targetTable: 'users',
			targetColumn: ['id'],
		});
	});

	it('rejects binding-final relation filters when the source FK is not projected (ref #182)', () => {
		const result = compile(
			"posts | select id, title | bind projected_posts\nprojected_posts | where some(author).email = 'alice@example.com' | select id",
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/ref-#182/);
		expect(result.errors[0]?.message).toMatch(/FK column 'authorId'/);
		expect(result.errors[0]?.message).toMatch(/not projected/);
	});

	it.each([
		['literal alias', '1 as authorId'],
		['arithmetic alias', 'authorId + 0 as authorId'],
	] as const)('rejects binding-final relation filters when the FK output is a fabricated %s (ref #182)', (_label, projection) => {
		const result = compile(
			`posts | select id, ${projection} | bind projected_posts
projected_posts | where some(author).email = 'alice@example.com' | select id`,
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/ref-#182/);
		expect(result.errors[0]?.message).toMatch(/FK column 'authorId'/);
		expect(result.errors[0]?.message).toMatch(/direct source-column/);
	});

	it('rejects binding-final relation filters from aggregate bindings (ref #182)', () => {
		const result = compile(
			"posts | select authorId, count(id) as total | bind post_counts\npost_counts | where some(author).email = 'alice@example.com' | select authorId",
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/ref-#182/);
		expect(result.errors[0]?.message).toMatch(/aggregate/);
	});

	it('rejects binding-final relation filters from nested read bindings (ref #182)', () => {
		const result = compile(
			`posts | select id, authorId | bind base_posts
base_posts | select id, authorId | bind projected_posts
projected_posts | where some(author).email = 'alice@example.com' | select id`,
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/ref-#182/);
		expect(result.errors[0]?.message).toMatch(/another NQL binding/);
	});

	it('rejects binding-final relation filters for unknown source-table relations (ref #182)', () => {
		const result = compile(
			"posts | select id, authorId | bind projected_posts\nprojected_posts | where some(editor).email = 'alice@example.com' | select id",
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/ref-#182/);
		expect(result.errors[0]?.message).toMatch(/not declared/);
	});

	it('default-rejects unhandled future binding-final clauses (ref #183)', () => {
		const ast = parseProgram(
			'users | select id | bind projected_users\nprojected_users | select id',
		);
		const finalQuery = ast.statements[1] as NqlQuery;
		finalQuery.clauses.push({ type: 'qualify' } as unknown as NqlClause);

		expect(() => new NqlCompiler(undefined, schema).compile(ast)).toThrow(
			/#183.*qualify|qualify.*#183/,
		);
	});

	it('rejects relation filters from a final query that reads from a bind source', () => {
		const result = compile(
			"users | select id | bind projected_users\nprojected_users | where some(posts).title = 'draft' | select id",
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Query 'projected_users' reads from an NQL binding and cannot use relation filters \(posts\)/,
		);
	});

	it('rejects relation filters from a bind source even when the binding projected SELECT *', () => {
		const result = compile(
			"users | select * | bind all_users\nall_users | where some(posts).title = 'draft' | select id",
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Query 'all_users' reads from an NQL binding and cannot use relation filters \(posts\)/,
		);
	});

	it('allows hasMany relation columns from a bind source that projected SELECT *', () => {
		const result = compile(
			'users | select * | bind all_users\nall_users | select posts.title',
			schema,
		);

		expect(result.success).toBe(true);
		const relationColumn =
			result.ast?.query?.select?.type === 'expressions'
				? result.ast.query.select.columns.find(
						(column) => column.kind === 'relationColumn',
					)
				: undefined;
		expect(getTrustedNqlRelationFilterFields(relationColumn)).toMatchObject({
			relation: 'posts',
			sourceColumn: ['id'],
			targetColumn: ['authorId'],
			cardinality: 'many',
			relationType: 'hasMany',
		});
	});

	it('allows recursive relation columns from a bind source when the proven seed columns are projected', () => {
		const result = compile(
			'categories | select id, parentId | bind c\nc | select id, ascendant.name, descendant.name',
			schema,
		);

		expect(result.success).toBe(true);
		const relationColumns =
			result.ast?.query?.select?.type === 'expressions'
				? result.ast.query.select.columns.filter(
						(column) => column.kind === 'relationColumn',
					)
				: [];
		const ascendant = relationColumns.find(
			(column) => column.relation === 'ascendant',
		);
		const descendant = relationColumns.find(
			(column) => column.relation === 'descendant',
		);
		expect(getTrustedNqlRelationFilterFields(ascendant)).toMatchObject({
			relation: 'ascendant',
			sourceColumn: ['parentId'],
			targetColumn: ['id'],
			targetTable: 'categories',
			selectedColumn: 'name',
			cardinality: 'many',
			recursive: {
				direction: 'up',
				maxDepth: 10,
				selfRefColumn: 'parentId',
				targetKeyColumn: 'id',
			},
		});
		expect(getTrustedNqlRelationFilterFields(descendant)).toMatchObject({
			relation: 'descendant',
			sourceColumn: ['id'],
			targetColumn: ['parentId'],
			targetTable: 'categories',
			selectedColumn: 'name',
			cardinality: 'many',
			recursive: {
				direction: 'down',
				maxDepth: 10,
				selfRefColumn: 'parentId',
				targetKeyColumn: 'id',
			},
		});
	});

	it('uses pseudo metadata as the recursive target key fallback for non-id self-ref bindings', () => {
		const nonIdSelfRefSchema = {
			...schema,
			getTable(name: string) {
				if (name !== 'categories') return schema.getTable(name);
				return {
					columns: [
						{ name: 'catId' },
						{ name: 'name' },
						{ name: 'parentCatId' },
					],
					pseudoColumns: [
						{
							table: 'categories',
							foreignKeyColumn: 'parentCatId',
							targetColumn: 'catId',
							parentRole: 'parent',
							childRole: 'children',
							ascendantKeyword: 'ascendant',
							descendantKeyword: 'descendant',
						},
					],
				};
			},
			getRelationsFrom(sourceTable: string) {
				if (sourceTable !== 'categories')
					return schema.getRelationsFrom(sourceTable);
				return [
					{
						name: 'parent',
						source: 'categories',
						target: 'categories',
						type: 'belongsTo' as const,
						foreignKey: 'parentCatId',
						recursive: { direction: 'ancestors' },
					},
					{
						name: 'children',
						source: 'categories',
						target: 'categories',
						type: 'hasMany' as const,
						foreignKey: 'parentCatId',
						recursive: { direction: 'descendants' },
					},
				];
			},
			getRelation(qualifiedName: string) {
				const [source, relationName] = qualifiedName.split('.');
				if (!source || !relationName) return undefined;
				return this.getRelationsFrom(source).find(
					(relation) => relation.name === relationName,
				);
			},
		};
		const result = compile(
			'categories | select catId, parentCatId | bind c\nc | select catId, ascendant.name, descendant.name',
			nonIdSelfRefSchema,
		);

		expect(result.success).toBe(true);
		const relationColumns =
			result.ast?.query?.select?.type === 'expressions'
				? result.ast.query.select.columns.filter(
						(column) => column.kind === 'relationColumn',
					)
				: [];
		const ascendant = relationColumns.find(
			(column) => column.relation === 'ascendant',
		);
		const descendant = relationColumns.find(
			(column) => column.relation === 'descendant',
		);
		expect(getTrustedNqlRelationFilterFields(ascendant)).toMatchObject({
			relation: 'ascendant',
			sourceColumn: ['parentCatId'],
			targetColumn: ['catId'],
			targetTable: 'categories',
			selectedColumn: 'name',
			cardinality: 'many',
			recursive: {
				direction: 'up',
				maxDepth: 10,
				selfRefColumn: 'parentCatId',
				targetKeyColumn: 'catId',
			},
		});
		expect(getTrustedNqlRelationFilterFields(descendant)).toMatchObject({
			relation: 'descendant',
			sourceColumn: ['catId'],
			targetColumn: ['parentCatId'],
			targetTable: 'categories',
			selectedColumn: 'name',
			cardinality: 'many',
			recursive: {
				direction: 'down',
				maxDepth: 10,
				selfRefColumn: 'parentCatId',
				targetKeyColumn: 'catId',
			},
		});
	});

	it('rejects recursive relation columns from a bind source when the seed column is not a direct projection', () => {
		const result = compile(
			'categories | select id | bind c\nc | select ascendant.name',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/ascendant/);
		expect(result.errors[0]?.message).toMatch(/select relation column/);
	});

	it('rejects binding recursive relation columns with a composite self-ref FK', () => {
		const compositeSchema = {
			...schema,
			getTable(name: string) {
				if (name !== 'categories') return schema.getTable(name);
				return {
					columns: [
						{ name: 'id' },
						{ name: 'tenantId' },
						{ name: 'parentId' },
						{ name: 'name' },
					],
					pseudoColumns: [
						{
							table: 'categories',
							foreignKeyColumn: 'parentId',
							targetColumn: 'id',
							parentRole: 'parent',
							childRole: 'children',
							ascendantKeyword: 'ascendant',
							descendantKeyword: 'descendant',
						},
					],
				};
			},
			getRelationsFrom(sourceTable: string) {
				if (sourceTable !== 'categories')
					return schema.getRelationsFrom(sourceTable);
				return [
					{
						name: 'parent',
						source: 'categories',
						target: 'categories',
						type: 'belongsTo' as const,
						foreignKey: ['parentId', 'tenantId'],
						targetKey: ['id', 'tenantId'],
						recursive: { direction: 'up', maxDepth: 10 },
					},
				];
			},
			getRelation(qualifiedName: string) {
				const [source, relationName] = qualifiedName.split('.');
				if (!source || !relationName) return undefined;
				return this.getRelationsFrom(source).find(
					(relation) => relation.name === relationName,
				);
			},
		};
		const result = compile(
			'categories | select id, tenantId, parentId | bind c\nc | select ascendant.name',
			compositeSchema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/composite/);
		expect(result.errors[0]?.message).toMatch(/ref-#193/);
	});

	it('rejects recursive includes from a bind source', () => {
		const result = compile(
			'categories | select id, parentId | bind c\nc | select descendant.*',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/recursive\/self-referential/);
		expect(result.errors[0]?.message).toMatch(/ref-#193/);
	});

	it('rejects pseudo-columns from a bind source that projected SELECT * (ref #182)', () => {
		const result = compile(
			'users | select * | bind all_users\nall_users | select parent.name',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/all_users.*cannot use pseudo-column traversals.*parent/,
		);
	});

	it('rejects relation filters in HAVING from a final query that reads from a bind source', () => {
		const result = compile(
			"users | select id | bind projected_users\nprojected_users | group by id | where some(posts).title = 'draft' | select id",
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Query 'projected_users' reads from an NQL binding and cannot use relation filters \(posts\)/,
		);
	});

	it('rejects relation paths in WHERE from a final query that reads from a bind source', () => {
		const result = compile(
			"users | select id | bind projected_users\nprojected_users | where posts.title = 'draft' | select id",
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Query 'projected_users' reads from an NQL binding and cannot reference relation path 'posts\.title'/,
		);
	});

	it('rejects relation paths in HAVING from a final query that reads from a bind source', () => {
		const result = compile(
			"users | select id | bind projected_users\nprojected_users | group by id | where posts.title = 'draft' | select id",
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Query 'projected_users' reads from an NQL binding and cannot reference relation path 'posts\.title'/,
		);
	});

	it('rejects relation paths in ORDER BY from a final query that reads from a bind source', () => {
		const result = compile(
			'users | select id | bind projected_users\nprojected_users | select id | order by posts.title',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Query 'projected_users' reads from an NQL binding and cannot reference relation path 'posts\.title'/,
		);
	});

	it('rejects relation paths in GROUP BY from a final query that reads from a bind source', () => {
		const result = compile(
			'users | select id | bind projected_users\nprojected_users | group by posts.title | select id',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Query 'projected_users' reads from an NQL binding and cannot reference relation path 'posts\.title'/,
		);
	});

	it('keeps final bind-source validation permissive for SELECT * projections', () => {
		const result = compile(
			"users | select * | bind all_users\nall_users | where email = 'a@example.com' | select email | order by name",
			schema,
		);

		expect(result.success).toBe(true);
	});

	it('keeps plain columns valid from a bind source that projected SELECT * (ref #182)', () => {
		const result = compile(
			'users | select * | bind all_users\nall_users | select id',
			schema,
		);

		expect(result.success).toBe(true);
	});

	it('carries concrete output schema for SELECT * bindings', () => {
		const result = compile(
			'users | select * | bind all_users\nall_users | select id',
			schema,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.bindingOutputSchemas?.get('all_users')?.columns).toEqual(
			['id', 'name', 'email', 'department', 'active', 'salary'],
		);
	});

	it('carries declared binding outputs through aliases and binding chains', () => {
		const result = compile(
			'posts | select authorId as aid | bind projected_posts\nprojected_posts | select aid as author | bind projected_authors\nprojected_authors | select author',
			schema,
		);

		expect(result.success).toBe(true);
		expect(
			result.ast?.bindingOutputSchemas?.get('projected_posts')?.declaredOutputs,
		).toEqual([
			{
				outputKey: 'aid',
				source: { kind: 'modelColumn', table: 'posts', column: 'authorId' },
				shape: { kind: 'scalar', cardinality: 'one' },
			},
		]);
		expect(
			result.ast?.bindingOutputSchemas?.get('projected_authors')
				?.declaredOutputs,
		).toEqual([
			{
				outputKey: 'author',
				source: { kind: 'modelColumn', table: 'posts', column: 'authorId' },
				shape: { kind: 'scalar', cardinality: 'one' },
			},
		]);
	});

	it('records scalar relation-column descriptors and declares hasMany outputs non-scalar', () => {
		const result = compile(
			`posts | select id, authorId | bind projected_posts
projected_posts | select author.name as authorName, author.profile.bio as authorBio, comments.body as commentBodies | bind related_post_columns
related_post_columns | select authorName, authorBio, commentBodies`,
			schema,
		);

		expect(result.success).toBe(true);
		expect(
			result.ast?.bindingOutputSchemas?.get('related_post_columns')
				?.declaredOutputs,
		).toEqual([
			{
				outputKey: 'authorName',
				source: { kind: 'modelColumn', table: 'users', column: 'name' },
				shape: { kind: 'scalar', cardinality: 'one' },
			},
			{
				outputKey: 'authorBio',
				source: { kind: 'modelColumn', table: 'profiles', column: 'bio' },
				shape: { kind: 'scalar', cardinality: 'one' },
			},
			{
				outputKey: 'commentBodies',
				source: { kind: 'modelColumn', table: 'comments', column: 'body' },
				shape: { kind: 'array', cardinality: 'many' },
			},
		]);
	});

	it('declares binding-projected recursive relation columns non-scalar', () => {
		const result = compile(
			`categories | select id, parentId | bind c
c | select ascendant.name as ancestorName, descendant.name as descendantName | bind related_categories
related_categories | select ancestorName, descendantName`,
			schema,
		);

		expect(result.success).toBe(true);
		expect(
			result.ast?.bindingOutputSchemas?.get('related_categories')
				?.declaredOutputs,
		).toEqual([
			{
				outputKey: 'ancestorName',
				source: { kind: 'modelColumn', table: 'categories', column: 'name' },
				shape: { kind: 'array', cardinality: 'many' },
			},
			{
				outputKey: 'descendantName',
				source: { kind: 'modelColumn', table: 'categories', column: 'name' },
				shape: { kind: 'array', cardinality: 'many' },
			},
		]);
	});

	it('records scalar physical relation-column descriptors and leaves hasMany outputs unresolved without a trusted binding proof', () => {
		const outputSchema = getQueryOutputSchema(
			{
				type: 'select',
				from: 'posts',
				select: {
					type: 'expressions',
					columns: [
						{
							kind: 'relationColumn',
							relation: 'author',
							column: 'name',
							as: 'authorName',
						},
						{
							kind: 'relationColumn',
							relation: 'author.profile',
							column: 'bio',
							as: 'authorBio',
						},
						{
							kind: 'relationColumn',
							relation: 'comments',
							column: 'body',
							as: 'commentBody',
						},
					],
				},
			},
			compilerContextForValidator(new ColumnValidator(schema)),
			'physical_relation_projection',
		);

		expect(outputSchema.declaredOutputs).toEqual([
			{
				outputKey: 'authorName',
				source: { kind: 'modelColumn', table: 'users', column: 'name' },
				shape: { kind: 'scalar', cardinality: 'one' },
			},
			{
				outputKey: 'authorBio',
				source: { kind: 'modelColumn', table: 'profiles', column: 'bio' },
				shape: { kind: 'scalar', cardinality: 'one' },
			},
			{
				outputKey: 'commentBody',
				source: {
					kind: 'unresolved',
					reason:
						"relation output 'commentBody' has no proven scalar model column source",
				},
				shape: {
					kind: 'unknown',
					reason:
						"relation output 'commentBody' has no proven scalar model column source",
				},
			},
		]);
		expect(outputSchema.columnTypes).toBeUndefined();
		expect(outputSchema.columnTypesUnavailable).toEqual({
			column: 'authorName',
			reason: 'relation-column',
		});
	});

	it('keeps relation-column binding descriptors unresolved without a validated target', () => {
		const outputSchema = getQueryOutputSchema(
			{
				type: 'select',
				from: 'posts',
				select: {
					type: 'expressions',
					columns: [
						{
							kind: 'relationColumn',
							relation: 'missing',
							column: 'name',
							as: 'missingName',
						},
					],
				},
			},
			compilerContextForValidator(new ColumnValidator(schema)),
			'unresolvable_physical_relation_projection',
		);

		expect(outputSchema.declaredOutputs).toEqual([
			{
				outputKey: 'missingName',
				source: {
					kind: 'unresolved',
					reason:
						"relation output 'missingName' has no proven scalar model column source",
				},
				shape: {
					kind: 'unknown',
					reason:
						"relation output 'missingName' has no proven scalar model column source",
				},
			},
		]);
		expect(outputSchema.columnTypes).toBeUndefined();
		expect(outputSchema.columnTypesUnavailable).toEqual({
			column: 'missingName',
			reason: 'relation-column',
		});
	});

	it('detects unresolved SELECT * output-schema errors by typed discriminant', () => {
		const error = new UnresolvedSelectAllOutputSchemaError(
			'changed human-readable output-schema wording',
		);

		expect(isUnresolvedSelectAllOutputSchemaError(error)).toBe(true);
	});

	it('gracefully degrades unresolved SELECT * binding schemas without a validator', () => {
		const result = compile(
			'users | select * | bind all_users\nall_users | select id',
			null,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.bindings?.has('all_users')).toBe(true);
		expect(result.ast?.bindingOutputSchemas?.has('all_users')).not.toBe(true);
	});

	it('inherits SELECT * output schema through binding chains and rejects unknown columns', () => {
		const result = compile(
			'users | select * | bind A\nA | select foo | bind B\nB | select bar',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Column 'foo' is not projected by NQL binding 'A'/,
		);
	});

	it('rejects the ROOT chain example when a later binding selects a missing inherited column', () => {
		const result = compile(
			'users | select name as foo | bind A\nA | select * | bind A2\nA2 | select foo | bind B\nB | select bar',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Column 'bar' is not projected by NQL binding 'B'/,
		);
	});

	it('keeps final bind-source validation permissive for mixed SELECT * projections', () => {
		const result = compile(
			'users | select *, name as displayName | bind all_users\nall_users | select email, displayName',
			schema,
		);

		expect(result.success).toBe(true);
	});

	it('accepts nested expressions and aggregates over projected bind-source columns', () => {
		const result = compile(
			'users | select id, name, salary | bind projected_users\nprojected_users | select upper(name) as upperName, salary + id as score, count(id) as total',
			schema,
		);

		expect(result.success).toBe(true);
	});

	it('rejects HAVING references to final SELECT aggregate aliases from a bind source', () => {
		const result = compile(
			'users | select department, id | bind projected_users\nprojected_users | group by department | where total > 1 | select department, count(id) as total',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/HAVING cannot reference SELECT alias 'total'/,
		);
	});

	it('rejects HAVING references to SELECT aggregate aliases from a real table', () => {
		const result = compile(
			'orders | group by status | where totalOrders > 1 | select status, count(*) as totalOrders',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/HAVING cannot reference SELECT alias 'totalOrders'/,
		);
	});

	it('continues to allow HAVING over a real table column', () => {
		const result = compile(
			'orders | group by status | where total > 5 | select status',
			schema,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.query?.having).toMatchObject({
			kind: 'comparison',
			field: 'total',
			operator: 'gt',
			value: 5,
		});
	});

	it('continues to allow HAVING over count(*)', () => {
		const result = compile(
			'orders | group by status | where count(*) > 1 | select status',
			schema,
		);

		expect(result.success).toBe(true);
		expect(result.ast?.query?.having).toMatchObject({
			kind: 'expression',
			operator: 'gt',
			value: 1,
			expr: {
				kind: 'aggregate',
				function: 'count',
				field: '*',
			},
		});
	});

	it('keeps SELECT * permissive for nested plain refs but rejects nested dotted refs (ref #182)', () => {
		const plain = compile(
			'users | select * | bind all_users\nall_users | select upper(email) as upperEmail | order by name',
			schema,
		);
		expect(plain.success).toBe(true);

		const dotted = compile(
			'users | select * | bind all_users\nall_users | select upper(posts.title) as postTitle',
			schema,
		);
		expect(dotted.success).toBe(false);
		expect(dotted.errors[0]?.message).toMatch(
			/Query 'all_users' reads from an NQL binding and cannot reference relation path 'posts\.title'/,
		);
	});

	it('allows hasMany relation columns from a final query that reads a bind name', () => {
		const result = compile(
			'users | select id | bind active_users\nactive_users | select posts.title',
			schema,
		);

		expect(result.success).toBe(true);
		const relationColumn =
			result.ast?.query?.select?.type === 'expressions'
				? result.ast.query.select.columns.find(
						(column) => column.kind === 'relationColumn',
					)
				: undefined;
		expect(getTrustedNqlRelationFilterFields(relationColumn)).toMatchObject({
			relation: 'posts',
			sourceColumn: ['id'],
			targetColumn: ['authorId'],
			cardinality: 'many',
			relationType: 'hasMany',
		});
	});

	it('rejects relation include limits from a final query that reads a bind name', () => {
		const result = compile(
			'users | select id | bind active_users\nactive_users | select id | limit posts 5',
			schema,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/active_users.*cannot use relation include limits.*CTE binding/,
		);
	});

	it.each([
		[
			'WHERE relation path',
			"users | select * | bind all_users\nall_users | where posts.title = 'draft' | select id",
		],
		[
			'SELECT relation column',
			'users | select * | bind all_users\nall_users | select posts.title',
		],
		[
			'GROUP BY relation path',
			'users | select * | bind all_users\nall_users | group by posts.title | select id',
		],
	])('rejects binding-final %s without a model (ref #182)', (_label, nql) => {
		const result = compile(nql, null);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Query 'all_users' reads from an NQL binding/,
		);
	});

	it('rejects binding-final relation filters without a model', () => {
		const result = compile(
			"users | select * | bind all_users\nall_users | where some(posts).title = 'draft' | select id",
			null,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Query 'all_users' reads from an NQL binding and cannot use relation filters \(posts\)/,
		);
	});

	it('rejects binding-final pseudo-columns without a model', () => {
		const result = compile(
			'users | select * | bind all_users\nall_users | select parent.name',
			null,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/all_users.*cannot use pseudo-column traversals.*parent/,
		);
	});

	it('validates computable binding projections without a model', () => {
		const result = compile(
			'users | select id | bind active_users\nactive_users | select email',
			null,
		);

		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/Column 'email' is not projected by NQL binding 'active_users'.*Available columns: id/,
		);
	});

	it('validates computable SELECT-star binding chains without a model', () => {
		const valid = compile(
			'users | select id as userId | bind A\nA | select * | bind B\nB | select userId',
			null,
		);
		expect(valid.success).toBe(true);

		const invalid = compile(
			'users | select id as userId | bind A\nA | select * | bind B\nB | select id',
			null,
		);
		expect(invalid.success).toBe(false);
		expect(invalid.errors[0]?.message).toMatch(
			/Column 'id' is not projected by NQL binding 'B'.*Available columns: userId/,
		);
	});

	it('keeps plain columns permissive for no-model SELECT-star bindings but still rejects relations', () => {
		const plain = compile(
			"users | select * | bind all_users\nall_users | where email = 'a@example.com' | select email | order by name",
			null,
		);
		expect(plain.success).toBe(true);

		const relation = compile(
			'users | select * | bind all_users\nall_users | select posts.title',
			null,
		);
		expect(relation.success).toBe(false);
		expect(relation.errors[0]?.message).toMatch(
			/all_users.*cannot select relation column 'posts'.*model metadata is not available/,
		);
	});
});

// ============================================================================
// Flat mode
// ============================================================================

describe('flat mode', () => {
	it('flat keyword sets strategy on includes', () => {
		const result = compileNql('users | select id, posts.title | flat');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.include).toBeDefined();
		expect(result.ast?.query?.include?.[0]?.strategy).toBe('flat');
	});
});

// ============================================================================
// Per-include LIMIT
// ============================================================================

describe('per-include limit', () => {
	it('compiles limit on include relation', () => {
		const result = compileNql('users | select id, posts.title | limit posts 5');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.include).toBeDefined();
		expect(result.ast?.query?.include?.[0]?.relation).toBe('posts');
		expect(result.ast?.query?.include?.[0]?.limit).toBe(5);
		expect(result.ast?.query?.include?.[0]?.strategy).toBe('flat');
	});

	it('errors when limit references non-included relation', () => {
		const result = compile('users | select id | limit posts 5', schema);
		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(
			/limit for relation.*posts.*not included/,
		);
	});
});

// ============================================================================
// LOCK clause
// ============================================================================

describe('LOCK clause', () => {
	it('compiles FOR UPDATE', () => {
		const result = compileNql('users | for update');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.lock).toEqual({
			strength: 'forUpdate',
			waitPolicy: 'block',
		});
	});

	it('compiles FOR UPDATE SKIP LOCKED', () => {
		const result = compileNql('users | for update skip locked');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.lock).toEqual({
			strength: 'forUpdate',
			waitPolicy: 'skipLocked',
		});
	});

	it('compiles FOR UPDATE NOWAIT', () => {
		const result = compileNql('users | for update nowait');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.lock).toEqual({
			strength: 'forUpdate',
			waitPolicy: 'noWait',
		});
	});

	it('compiles FOR SHARE', () => {
		const result = compileNql('users | for share');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.lock).toEqual({
			strength: 'forShare',
			waitPolicy: 'block',
		});
	});

	it('compiles FOR NO KEY UPDATE', () => {
		const result = compileNql('users | for no key update');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.lock).toEqual({
			strength: 'forNoKeyUpdate',
			waitPolicy: 'block',
		});
	});

	it('compiles FOR KEY SHARE', () => {
		const result = compileNql('users | for key share');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.lock).toEqual({
			strength: 'forKeyShare',
			waitPolicy: 'block',
		});
	});
});

// ============================================================================
// LIMIT and OFFSET (outer query)
// ============================================================================

describe('LIMIT and OFFSET', () => {
	it('compiles LIMIT', () => {
		const result = compileNql('users | limit 10');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.limit).toBe(10);
	});

	it('compiles OFFSET', () => {
		const result = compileNql('users | offset 20');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.offset).toBe(20);
	});

	it('compiles LIMIT + OFFSET together', () => {
		const result = compileNql('users | limit 10 | offset 20');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.limit).toBe(10);
		expect(result.ast?.query?.offset).toBe(20);
	});
});

// ============================================================================
// Multiple WHERE conditions merge into AND
// ============================================================================

describe('multiple WHERE clauses merge', () => {
	it('single WHERE remains as-is', () => {
		const result = compileNql('users | where active = true');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.where).toBeDefined();
		expect(result.ast?.query?.where?.kind).toBe('comparison');
	});

	it('multiple WHERE clauses merge into AND', () => {
		const result = compileNql(
			"users | where active = true | where department = 'engineering'",
		);
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.where?.kind).toBe('and');
	});
});

// ============================================================================
// Multiple HAVING conditions merge into AND
// ============================================================================

describe('multiple HAVING conditions', () => {
	it('multiple WHERE after GROUP BY merge into AND', () => {
		const result = compileNql(
			'orders | group by status | where total > 5 | where id > 100 | select status',
		);
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.having?.kind).toBe('and');
	});
});

// ============================================================================
// Combined clauses
// ============================================================================

describe('combined clauses', () => {
	it('compiles a full query with WHERE + GROUP BY + HAVING + ORDER BY + LIMIT', () => {
		const result = compileNql(
			"orders | where status = 'pending' | group by status | where total > 2 | select status | order by status desc | limit 10",
		);
		const query = result.ast?.query;
		expect(query).toBeDefined();
		expect(query?.from).toBe('orders');
		expect(query?.where).toBeDefined();
		expect(query?.groupBy).toEqual(['status']);
		expect(query?.having).toBeDefined();
		expect(query?.orderBy).toBeDefined();
		expect(query?.limit).toBe(10);
	});
});

// ============================================================================
// Set operation with bound name reference
// ============================================================================

describe('set operation with bound name', () => {
	it('UNION with bound name reference resolves to SetOperationIntent', () => {
		const result = compile(
			'users | where active = true | select id | bind activeUsers\nusers | select id | union activeUsers',
			schema,
		);
		expect(result.success).toBe(true);
		expect(result.ast?.setOperation).toBeDefined();
		expect(result.ast?.setOperation?.op).toBe('union');
	});

	it('EXCEPT with bound name reference', () => {
		const result = compile(
			'users | select id | bind allUsers\nusers | where active = true | select id | except allUsers',
			schema,
		);
		expect(result.success).toBe(true);
		expect(result.ast?.setOperation).toBeDefined();
		expect(result.ast?.setOperation?.op).toBe('except');
	});
});

// ============================================================================
// Set operation — unbound name error
// ============================================================================

describe('set operation errors', () => {
	it('throws when bound name does not exist', () => {
		const result = compile('users | select id | union nonExistent', schema);
		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toMatch(/unbound name/i);
	});
});

// ============================================================================
// Flat mode applies strategy to pre-existing includes
// ============================================================================

describe('flat mode with pre-existing includes', () => {
	it('flat mode sets strategy on already-set includes (no-op if strategy exists)', () => {
		const result = compileNql(
			'users | select id, posts.title | flat | limit posts 3',
		);
		expect(result.ast?.query).toBeDefined();
		// Include should have flat strategy from flat keyword
		expect(result.ast?.query?.include?.[0]?.strategy).toBe('flat');
		expect(result.ast?.query?.include?.[0]?.limit).toBe(3);
	});
});

// ============================================================================
// ORDER BY with expression (non-field, falling through to expressionToSql)
// ============================================================================

describe('ORDER BY edge cases', () => {
	it('ORDER BY with expression falls through to expressionToSql', () => {
		const result = compileNql('orders | order by price + tax desc');
		expect(result.ast?.query).toBeDefined();
		expect(result.ast?.query?.orderBy).toBeDefined();
		expect(result.ast?.query?.orderBy?.[0]?.direction).toBe('desc');
		// The field should be a SQL-like expression string
		expect(typeof result.ast?.query?.orderBy?.[0]?.field).toBe('string');
	});
});

// ============================================================================
// Empty program compilation
// ============================================================================

describe('empty program', () => {
	it('compile of empty input returns empty result', () => {
		const result = compile('', schema);
		// Empty programs produce a parse error or empty result
		expect(result.ast === undefined || result.ast?.query === undefined).toBe(
			true,
		);
	});
});

// ============================================================================
// ROUND 2: WHERE applied to include batch (lines 91/95/101)
// ============================================================================

// ============================================================================
// ROUND 2: flat mode with relation column includes (line 159/170)
// ============================================================================

describe('flat mode with relation columns in SELECT', () => {
	it('flat sets strategy on auto-generated includes (line 170)', () => {
		const result = compileNql('users | select name, orders.total | flat');
		expect(result.ast?.query).toBeDefined();
		const inc = result.ast?.query?.include?.[0];
		expect(inc?.strategy).toBe('flat');
	});

	it('relation column generates include without flat', () => {
		const result = compileNql('users | select name, orders.total');
		expect(result.ast?.query?.include).toBeDefined();
		expect(result.ast?.query?.include?.length).toBeGreaterThan(0);
		expect(result.ast?.query?.include?.[0]?.relation).toBe('orders');
	});
});

// ============================================================================
// ROUND 2: getExplicitColumnCount aggregate (line 251)
// ============================================================================

describe('set operation column count validation', () => {
	it('aggregate select type counts correctly in set ops (line 251)', () => {
		// Set operation where one side uses aggregate
		const result = compileNql(
			'users | select count(id) | union (users | select count(id))',
		);
		expect(result.ast?.setOperation).toBeDefined();
	});

	it('expressions select type counts correctly in set ops', () => {
		const result = compileNql(
			'users | select name as n | union (users | select email as e)',
		);
		expect(result.ast?.setOperation).toBeDefined();
	});
});

// ============================================================================
// ROUND 2: GROUP BY non-path expression (line 322/329)
// ============================================================================

describe('GROUP BY edge cases', () => {
	it('GROUP BY with expression falls through to expressionToSql (line 329)', () => {
		const result = compileNql(
			'users | select department, count(id) | group by department',
		);
		expect(result.ast?.query?.groupBy).toBeDefined();
		expect(result.ast?.query?.groupBy).toContain('department');
	});

	it('GROUP BY with validator validates column (line 324)', () => {
		// Uses schema to trigger validator path
		const result = compile(
			'users | select department, count(id) | group by department',
			schema,
		);
		expect(result.success).toBe(true);
		expect(result.ast?.query?.groupBy).toContain('department');
	});
});

// ============================================================================
// ROUND 2: ORDER BY non-field expression (line 352)
// ============================================================================

describe('ORDER BY with non-field expression', () => {
	it('ORDER BY with function falls to expressionToSql (line 352)', () => {
		const result = compileNql('users | order by upper(name) desc');
		expect(result.ast?.query?.orderBy?.[0]?.direction).toBe('desc');
		expect(typeof result.ast?.query?.orderBy?.[0]?.field).toBe('string');
	});

	it('ORDER BY with schema validates field (line 352)', () => {
		const result = compile('users | order by name desc', schema);
		expect(result.success).toBe(true);
		expect(result.ast?.query?.orderBy?.[0]?.field).toBe('name');
	});
});
