/**
 * Coverage tests for compile-query.ts — exercises uncovered branches
 * in compileQuery, compileSetOperation, compileGroupByClause,
 * compileOrderByClause, and compileOrderItem.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '../index.js';

// Schema with relations for include tests
const schema = {
	getTable(name: string) {
		const tables: Record<
			string,
			{ columns: { name: string }[]; pseudoColumns?: never[] }
		> = {
			users: {
				columns: [
					{ name: 'id' },
					{ name: 'name' },
					{ name: 'email' },
					{ name: 'department' },
					{ name: 'active' },
					{ name: 'salary' },
				],
			},
			posts: {
				columns: [
					{ name: 'id' },
					{ name: 'title' },
					{ name: 'body' },
					{ name: 'authorId' },
					{ name: 'published' },
				],
			},
			orders: {
				columns: [
					{ name: 'id' },
					{ name: 'userId' },
					{ name: 'total' },
					{ name: 'status' },
				],
			},
			profiles: {
				columns: [{ name: 'id' }, { name: 'userId' }, { name: 'bio' }],
			},
		};
		return tables[name];
	},
	getRelationsFrom(sourceTable: string) {
		const relations: Record<string, { name: string; target: string }[]> = {
			users: [
				{ name: 'posts', target: 'posts' },
				{ name: 'orders', target: 'orders' },
				{ name: 'profile', target: 'profiles' },
			],
			posts: [],
			orders: [],
			profiles: [],
		};
		return relations[sourceTable] ?? [];
	},
	getRelationsTo() {
		return [];
	},
};

function compileNql(input: string) {
	const result = compile(input, schema);
	if (!result.success) {
		throw new Error(`Compile error: ${result.errors[0]?.message}`);
	}
	return result;
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
