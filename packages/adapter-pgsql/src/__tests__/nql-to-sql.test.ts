/**
 * NQL → SQL Compile-Only Integration Tests
 *
 * Verifies the FULL pipeline without a database:
 *   NQL string → nql.compile() → plan() → adapter.compile() → SQL string
 *
 * This layer catches bugs that unit tests miss because they construct
 * PlanReport manually — here the planner produces real decisions from
 * real NQL input, and the adapter compiles them to real SQL.
 */

import {
	isDeleteIntent,
	isInsertIntent,
	isUpdateIntent,
	isUpsertIntent,
	POSTGRESQL_CAPABILITIES,
	plan,
	type QueryIntent,
	ref,
	schema,
} from '@dbsp/core';
import { compile } from '@dbsp/nql';
import type { InsertFromIntent, UpsertFromIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Test schema: departments → employees (1:N)
// ---------------------------------------------------------------------------
const testSchema = schema({
	departments: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		budget: { type: 'decimal', nullable: true },
	},
	employees: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		departmentId: ref('departments', {
			onDelete: 'CASCADE',
			inverse: 'employees',
		}),
		salary: 'decimal',
	},
});

// ---------------------------------------------------------------------------
// Helper: NQL → normalized SQL
// ---------------------------------------------------------------------------
function nqlToSQL(nql: string): string {
	const compiled = compile(nql, testSchema.model);
	if (!compiled.success || !compiled.ast?.query) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const planReport = plan(compiled.ast.query, testSchema.model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});

	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, { model: testSchema.model });

	return normalizeSQL(result.sql);
}

// ---------------------------------------------------------------------------
// Helper: NQL mutation → normalized SQL
// ---------------------------------------------------------------------------
function nqlMutationToSQL(nql: string): string {
	const compiled = compile(nql, testSchema.model);
	if (!compiled.success || !compiled.ast?.mutation) {
		throw new Error(
			`NQL mutation compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const mutation = compiled.ast.mutation;
	if (!isUpsertIntent(mutation)) {
		throw new Error(`Expected UpsertIntent, got ${mutation.type}`);
	}

	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compileUpsert(mutation, { model: testSchema.model });

	return normalizeSQL(result.sql);
}

describe('NQL → SQL compile-only pipeline', () => {
	it('compiles a simple select', () => {
		const sql = nqlToSQL('departments | select id, name');
		expect(sql).toContain('select');
		expect(sql).toContain('departments');
	});

	it('compiles a where clause with parameter', () => {
		const sql = nqlToSQL("departments | where name = 'Engineering'");
		expect(sql).toContain('name');
		expect(sql).toContain('$1');
	});

	it('compiles flat include with all columns', () => {
		const sql = nqlToSQL('departments | select *, employees.* | flat');
		// flat = non-nested strategy (join or lateral, planner decides)
		expect(sql).toContain('join');
		expect(sql).toContain('employees');
	});

	it('propagates specific columns through flat include', () => {
		const sql = nqlToSQL('departments | select id, employees.name | flat');
		// Must contain the specific column from the relation
		expect(sql).toContain('employees');
		expect(sql).toContain('.name');
		// Should NOT have employees.* — only the specific column
		expect(sql).not.toMatch(/employees\.\*/);
	});

	it('propagates multiple columns through flat include', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.name, employees.email | flat',
		);
		expect(sql).toContain('.name');
		expect(sql).toContain('.email');
	});

	it('uses star for flat include with relation.*', () => {
		const sql = nqlToSQL('departments | select id, employees.* | flat');
		expect(sql).toContain('employees');
		// Wildcard must produce star target, not just 'id'
		// SQL should have employees.* (star) NOT just "employees"."id"
		expect(sql).not.toMatch(
			/"employees_0"\."id"\s+as\s+"employees\.id"\s*from/i,
		);
	});

	it('compiles include without flat (json_agg or join)', () => {
		const sql = nqlToSQL('departments | select *, employees.*');
		// Planner picks best strategy (json_agg for 1:N, or join)
		expect(sql).toContain('employees');
	});

	it('projects specific columns in json_agg include', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.name, employees.email',
		);
		// Should use jsonb_build_object for column projection instead of to_jsonb
		expect(sql).toContain('jsonb_build_object');
		expect(sql).not.toContain('to_jsonb');
		// Projected columns: name, email (from employees.name, employees.email)
		// PK (id) is added by extractor for NULL detection
		expect(sql).toContain("'name'");
		expect(sql).toContain("'email'");
	});

	it('compiles order by', () => {
		const sql = nqlToSQL('departments | order by name asc');
		expect(sql).toContain('order by');
		expect(sql).toContain('name');
	});

	it('compiles limit', () => {
		const sql = nqlToSQL('departments | limit 10');
		expect(sql).toContain('limit 10');
	});

	it('compiles where with relation column', () => {
		const sql = nqlToSQL('employees | where departmentId = 1');
		expect(sql).toContain('$1');
		expect(sql).toContain('departmentid');
	});

	it('propagates limit from IN subquery to SQL', () => {
		const sql = nqlToSQL(
			'departments | where id in (employees | select departmentId | limit 5)',
		);
		expect(sql).toContain('limit 5');
	});

	it('propagates order by from IN subquery to SQL', () => {
		const sql = nqlToSQL(
			'departments | where id in (employees | select departmentId | order by salary desc | limit 5)',
		);
		expect(sql).toContain('limit 5');
		expect(sql).toContain('order by');
	});

	// Regression test: relation.* with where + alias + flat must produce all columns
	it('produces star target for relation.* in flat include with where and alias', () => {
		const sql = nqlToSQL(
			'departments | where employees.salary > 50000 | select id as deptId, employees.* | limit 5 | flat',
		);
		// Must have join to employees
		expect(sql).toContain('employees');
		// Must have LIMIT 5
		expect(sql).toContain('limit 5');
		// Must have alias deptId
		expect(sql).toContain('deptid');
		// Must NOT have only employees.id — should have star/all columns
		expect(sql).not.toMatch(
			/"employees_0"\."id"\s+as\s+"employees\.id"\s*from/i,
		);
	});

	// Regression test: specific relation columns must NOT produce star
	it('does not produce star when specific relation columns are selected', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.name, employees.salary | flat',
		);
		// The SQL should contain .name and .salary for the relation
		expect(sql).toContain('.name');
		expect(sql).toContain('.salary');
		// But should NOT contain employees.* anywhere
		expect(sql).not.toMatch(/employees\.\*/);
	});
});

// ---------------------------------------------------------------------------
// ORM-level tests: Intent → Plan → SQL (for features NQL can't express yet)
// ---------------------------------------------------------------------------
describe('Intent → SQL compile-only pipeline', () => {
	function intentToSQL(intent: QueryIntent): string {
		const planReport = plan(intent, testSchema.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compile(planReport, { model: testSchema.model });
		return normalizeSQL(result.sql);
	}

	// NQL per-include limit: | limit <relation> N
	it('compiles per-include limit into LATERAL subquery via NQL', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.* | limit employees 3 | flat',
		);
		// LATERAL should be used because per-include limit forces flat
		expect(sql).toContain('lateral');
		expect(sql).toContain('limit 3');
	});

	it('compiles per-include limit with implicit flat (no explicit | flat)', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.* | limit employees 3',
		);
		// Even without explicit | flat, per-include limit forces LATERAL
		expect(sql).toContain('lateral');
		expect(sql).toContain('limit 3');
	});

	it('combines per-include limit with outer limit', () => {
		const sql = nqlToSQL(
			'departments | select id, employees.* | limit employees 3 | limit 5',
		);
		expect(sql).toContain('lateral');
		// Inner LATERAL limit
		expect(sql).toContain('limit 3');
		// Outer limit on the main query
		// Count occurrences of "limit" — should have both
		const limitMatches = sql.match(/limit \d+/g) ?? [];
		expect(limitMatches).toContain('limit 3');
		expect(limitMatches).toContain('limit 5');
	});

	// Regression: LATERAL subquery must contain LIMIT when include.limit is set
	it('propagates include.limit into LATERAL subquery', () => {
		const sql = intentToSQL({
			type: 'select',
			from: 'departments',
			select: { type: 'fields', fields: ['id', 'name'] },
			include: [
				{
					relation: 'employees',
					strategy: 'flat',
					limit: 3,
				},
			],
		});
		// LATERAL should be used (not plain LEFT JOIN) because limit is set
		expect(sql).toContain('lateral');
		// The LIMIT must appear inside the LATERAL subquery
		expect(sql).toContain('limit 3');
	});

	it('does not use LATERAL when include has no limit', () => {
		const sql = intentToSQL({
			type: 'select',
			from: 'departments',
			select: { type: 'fields', fields: ['id'] },
			include: [{ relation: 'employees', strategy: 'flat' }],
		});
		// Plain LEFT JOIN (no LATERAL) when no per-include limit
		expect(sql).toContain('left join');
		expect(sql).not.toContain('lateral');
	});

	it('includes parent columns with LATERAL and specific select', () => {
		const sql = intentToSQL({
			type: 'select',
			from: 'departments',
			select: { type: 'fields', fields: ['id', 'name'] },
			include: [
				{
					relation: 'employees',
					strategy: 'flat',
					limit: 5,
				},
			],
		});
		// Parent columns must appear in the SELECT
		expect(sql).toContain('departments.id');
		expect(sql).toContain('departments.name');
		// LATERAL subquery must have limit
		expect(sql).toContain('limit 5');
	});
});

// ---------------------------------------------------------------------------
// 3-level schema: companies → departments → employees
// Used for dotted-path per-include limit tests
// ---------------------------------------------------------------------------
const threeLevel = schema({
	companies: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	departments: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		companyId: ref('companies', {
			onDelete: 'CASCADE',
			inverse: 'departments',
		}),
	},
	employees: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		departmentId: ref('departments', {
			onDelete: 'CASCADE',
			inverse: 'employees',
		}),
	},
});

function threeLevelSQL(nql: string): string {
	const compiled = compile(nql, threeLevel.model);
	if (!compiled.success || !compiled.ast?.query) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e: { message: string }) => e.message).join(', ')}`,
		);
	}

	const planReport = plan(compiled.ast.query, threeLevel.model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});

	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, { model: threeLevel.model });
	return normalizeSQL(result.sql);
}

describe('Dotted-path per-include limit', () => {
	it('compiles dotted-path limit into LATERAL cascade', () => {
		const sql = threeLevelSQL(
			'companies | select id, departments.employees.* | limit departments.employees 3',
		);
		// Both levels must be LATERAL (not json_agg) for dotted-path limit
		expect(sql.toLowerCase()).toContain('lateral');
		// The inner LATERAL subquery for employees must have LIMIT 3
		expect(sql).toContain('limit 3');
	});

	it('applies limit only to the nested level, not the parent', () => {
		const sql = threeLevelSQL(
			'companies | select id, departments.employees.* | limit departments.employees 3',
		);
		// Should have exactly one LIMIT (on employees, not departments)
		const limitMatches = sql.match(/limit \d+/gi);
		expect(limitMatches).toHaveLength(1);
		expect(limitMatches![0]).toMatch(/limit 3/i);
	});

	it('forces flat strategy on intermediate ancestors', () => {
		const sql = threeLevelSQL(
			'companies | select id, departments.employees.* | limit departments.employees 3',
		);
		// departments level should be LATERAL (flat), not json_agg
		expect(sql.toLowerCase()).not.toContain('json_agg');
	});
});

// ===========================================================================
// Upsert (ON CONFLICT) — NQL → SQL
// ===========================================================================
describe('NQL → SQL upsert (ON CONFLICT)', () => {
	it('compiles upsert with single conflict column', () => {
		const sql = nqlMutationToSQL(
			"upsert into employees on email set name = 'Alice', email = 'alice@co.com', salary = 90000",
		);
		expect(sql).toContain('insert into');
		expect(sql).toContain('employees');
		expect(sql).toContain('on conflict');
		expect(sql).toContain('email');
		expect(sql).toContain('do update set');
	});

	it('compiles upsert with composite conflict columns', () => {
		const sql = nqlMutationToSQL(
			"upsert into employees on (name, email) set name = 'Alice', email = 'alice@co.com', salary = 90000",
		);
		expect(sql).toContain('on conflict');
		// Both conflict columns should be in the ON CONFLICT clause
		const conflictMatch = sql.match(/on conflict\s*\(([^)]+)\)/i);
		expect(conflictMatch).toBeTruthy();
		expect(conflictMatch![1]).toContain('name');
		expect(conflictMatch![1]).toContain('email');
	});

	it('uses EXCLUDED references in DO UPDATE SET', () => {
		const sql = nqlMutationToSQL(
			"upsert into employees on email set name = 'Alice', email = 'alice@co.com', salary = 90000",
		);
		// DO UPDATE SET columns should use EXCLUDED.column
		expect(sql).toContain('excluded');
	});

	it('parameterizes values', () => {
		const compiled = compile(
			"upsert into employees on email set name = 'Alice', email = 'alice@co.com', salary = 90000",
			testSchema.model,
		);
		expect(compiled.success).toBe(true);
		const mutation = compiled.ast!.mutation!;
		expect(isUpsertIntent(mutation)).toBe(true);

		const adapter = createPgsqlCompileOnlyAdapter();
		const result = adapter.compileUpsert(mutation as any, {
			model: testSchema.model,
		});

		// Values should be parameterized ($1, $2, ...)
		expect(result.sql).toMatch(/\$\d+/);
		expect(result.parameters.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Bug regression: some()/none()/every(), count() OVER, relation.*
// ---------------------------------------------------------------------------

const blogSchema = schema({
	authors: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		published: 'boolean',
		authorId: ref('authors', { inverse: 'posts' }),
	},
	tags: {
		id: { type: 'integer', primaryKey: true },
		label: 'string',
	},
	postTags: {
		id: { type: 'integer', primaryKey: true },
		postId: ref('posts', { inverse: 'tags', through: true }),
		tagId: ref('tags', { inverse: 'posts', through: true }),
	},
});

function blogToSQL(nql: string): { sql: string; params: readonly unknown[] } {
	const compiled = compile(nql, blogSchema.model);
	if (!compiled.success || !compiled.ast?.query) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}
	const planReport = plan(compiled.ast.query, blogSchema.model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});
	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, { model: blogSchema.model });
	return { sql: normalizeSQL(result.sql), params: result.parameters };
}

describe('Bug regressions', () => {
	describe('some()/none()/every() relation filters', () => {
		it('some() compiles to EXISTS with condition', () => {
			const { sql, params } = blogToSQL(
				'authors | where some(posts).published = true',
			);
			expect(sql).toContain('exists');
			expect(sql).toContain('published');
			expect(params).toContain(true);
		});

		it('none() compiles to NOT EXISTS with condition', () => {
			const { sql, params } = blogToSQL(
				'authors | where none(posts).published = false',
			);
			expect(sql).toContain('not (exists');
			expect(params).toContain(false);
		});

		it('every() compiles to NOT EXISTS with inverted condition', () => {
			const { sql, params } = blogToSQL(
				'authors | where every(posts).published = true',
			);
			// every(posts).published = true → NOT EXISTS (... AND NOT (published = $1))
			expect(sql).toContain('not (exists');
			expect(sql).toContain('and not (');
			expect(params).toContain(true);
			// Must only have ONE parameter (not duplicated)
			expect(params).toHaveLength(1);
		});
	});

	describe('aliased relation filters', () => {
		it('some(posts as p, p.published = true) strips alias from column', () => {
			const { sql, params } = blogToSQL(
				'authors | where some(posts as p, p.published = true)',
			);
			expect(sql).toContain('exists');
			expect(sql).toContain('published');
			// Must NOT contain "p.published" as a quoted column name
			expect(sql).not.toContain('"p.published"');
			expect(params).toContain(true);
		});

		it('none(posts as p, p.published = false) strips alias from column', () => {
			const { sql, params } = blogToSQL(
				'authors | where none(posts as p, p.published = false)',
			);
			expect(sql).toContain('not (exists');
			expect(sql).not.toContain('"p.published"');
			expect(params).toContain(false);
		});

		it('every(posts as p, p.published = true) strips alias from column', () => {
			const { sql, params } = blogToSQL(
				'authors | where every(posts as p, p.published = true)',
			);
			expect(sql).toContain('not (exists');
			expect(sql).not.toContain('"p.published"');
			expect(params).toContain(true);
			expect(params).toHaveLength(1);
		});

		it('alias with compound condition strips prefix from both fields', () => {
			const { sql, params } = blogToSQL(
				"authors | where none(posts as p, p.published = true and p.title = 'draft')",
			);
			expect(sql).not.toContain('"p.published"');
			expect(sql).not.toContain('"p.title"');
			expect(params).toContain(true);
			expect(params).toContain('draft');
		});
	});

	describe('non-comparison operators in relation filters', () => {
		it('LIKE inside some() is preserved in EXISTS', () => {
			const { sql, params } = blogToSQL(
				"authors | where some(posts as p, p.published = true and p.title like '%Guide%')",
			);
			expect(sql).toContain('exists');
			expect(sql).toContain('like');
			expect(params).toContain(true);
			expect(params).toContain('%Guide%');
		});

		it('IN inside some() is preserved in EXISTS', () => {
			const { sql, params } = blogToSQL(
				"authors | where some(posts as p, p.title in ('draft', 'review'))",
			);
			expect(sql).toContain('exists');
			expect(sql).toContain('any');
			expect(params.length).toBeGreaterThan(0);
		});

		it('IS NULL inside none() is preserved in NOT EXISTS', () => {
			const { sql } = blogToSQL(
				'authors | where none(posts as p, p.title is null)',
			);
			expect(sql).toContain('not (exists');
			expect(sql).toContain('is null');
		});
	});

	describe('window count(*)', () => {
		it('count() over () produces count(*) not count()', () => {
			const sql = nqlToSQL(
				'employees | select name, count() over () as totalEmployees',
			);
			expect(sql).toContain('count(*)');
			expect(sql).not.toMatch(/count\(\s*\)(?!\s*over)/i); // no empty count() (ignoring count(*) OVER)
		});
	});

	describe('relation.* wildcard expansion', () => {
		it('relation.* uses unquoted star (A_Star)', () => {
			const { sql } = blogToSQL('authors | select *, posts.*');
			// Must NOT quote the star: posts."*" is wrong
			expect(sql).not.toContain('"*"');
		});
	});

	// -------------------------------------------------------------------------
	// FieldRef: column-to-column comparisons in aliased relation filters
	// -------------------------------------------------------------------------
	describe('FieldRef compilation (alias resolution)', () => {
		// Self-referential schema: categories with parent → children
		const categorySchema = schema({
			categories: {
				id: { type: 'integer', primaryKey: true },
				name: 'string',
				sortOrder: { type: 'integer', nullable: true },
				parentId: ref('categories', {
					onDelete: 'SET NULL',
					nullable: true,
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		});

		function categoryNqlToSQL(nql: string): string {
			const compiled = compile(nql, categorySchema.model);
			if (!compiled.success || !compiled.ast?.query) {
				throw new Error(
					`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
				);
			}
			const planReport = plan(compiled.ast.query, categorySchema.model, {
				dialectCapabilities: POSTGRESQL_CAPABILITIES,
			});
			const adapter = createPgsqlCompileOnlyAdapter();
			const result = adapter.compile(planReport, {
				model: categorySchema.model,
			});
			return normalizeSQL(result.sql);
		}

		it('self-ref: aliased column vs outer column compiles to column-to-column comparison', () => {
			// d.sortOrder → inner column ref; bare sortOrder → outer column ref
			const sql = categoryNqlToSQL(
				'categories | where some(children as d, d.sortOrder > sortOrder)',
			);
			// Column-to-column: both sides are column refs, no $1 parameter
			expect(sql).toEqual(
				'select categories.* from categories where exists' +
					' (select 1 from categories as categories_exists_0' +
					' where categories.id = categories_exists_0."parentid"' +
					' and categories_exists_0."sortorder" > categories."sortorder")',
			);
		});

		it('regular literal value is still parameterized', () => {
			const sql = categoryNqlToSQL(
				'categories | where some(children as d, d.sortOrder > 10)',
			);
			// Literal 10 → $1 parameter, not a column ref
			expect(sql).toEqual(
				'select categories.* from categories where exists' +
					' (select 1 from categories as categories_exists_0' +
					' where categories.id = categories_exists_0."parentid"' +
					' and categories_exists_0."sortorder" > $1)',
			);
		});

		it('self-ref equality: d.name = name compiles to column-to-column', () => {
			const sql = categoryNqlToSQL(
				'categories | where some(children as d, d.name = name)',
			);
			expect(sql).toEqual(
				'select categories.* from categories where exists' +
					' (select 1 from categories as categories_exists_0' +
					' where categories.id = categories_exists_0."parentid"' +
					' and categories_exists_0.name = categories.name)',
			);
		});

		it('non-self-ref: aliased column vs literal in regular relation', () => {
			// Using the testSchema (departments → employees)
			const sql = nqlToSQL(
				'departments | where some(employees as e, e.salary > 50000)',
			);
			expect(sql).toEqual(
				'select departments.* from departments where exists' +
					' (select 1 from employees as employees_exists_0' +
					' where departments.id = employees_exists_0."departmentid"' +
					' and employees_exists_0.salary > $1)',
			);
		});

		it('aliased filter with multiple conditions (AND)', () => {
			const sql = categoryNqlToSQL(
				'categories | where some(children as d, d.sortOrder > sortOrder and d.name != name)',
			);
			expect(sql).toEqual(
				'select categories.* from categories where exists' +
					' (select 1 from categories as categories_exists_0' +
					' where categories.id = categories_exists_0."parentid"' +
					' and (categories_exists_0."sortorder" > categories."sortorder"' +
					' and categories_exists_0.name <> categories.name))',
			);
		});
	});
});

// ===========================================================================
// Mutation NQL → SQL E2E tests
// ===========================================================================

const mutationSchema = schema({
	authors: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		active: 'boolean',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		published: 'boolean',
		featured: 'boolean',
		userId: ref('authors', { inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		body: 'string',
		postId: ref('posts', { inverse: 'comments' }),
	},
	archivedPosts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		published: 'boolean',
		userId: { type: 'integer' },
	},
});

/**
 * General NQL mutation → SQL helper that dispatches to the correct adapter method.
 */
function mutationToSQL(nql: string): {
	sql: string;
	params: readonly unknown[];
} {
	const compiled = compile(nql, mutationSchema.model);
	if (!compiled.success || !compiled.ast?.mutation) {
		throw new Error(
			`NQL mutation compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const mutation = compiled.ast.mutation;
	const adapter = createPgsqlCompileOnlyAdapter();
	const opts = { model: mutationSchema.model };

	let result: { sql: string; parameters: readonly unknown[] };
	if (isUpdateIntent(mutation)) {
		result = adapter.compileUpdate(mutation, opts);
	} else if (isDeleteIntent(mutation)) {
		result = adapter.compileDelete(mutation, opts);
	} else if (isUpsertIntent(mutation)) {
		result = adapter.compileUpsert(mutation, opts);
	} else if (isInsertIntent(mutation)) {
		result = adapter.compileInsert(mutation, opts);
	} else if (mutation.type === 'insert_from') {
		result = adapter.compileInsertFrom(mutation as InsertFromIntent, opts);
	} else if (mutation.type === 'upsert_from') {
		result = adapter.compileUpsertFrom(mutation as UpsertFromIntent, opts);
	} else {
		throw new Error(
			`Unsupported mutation type: ${(mutation as { type: string }).type}`,
		);
	}

	return { sql: normalizeSQL(result.sql), params: result.parameters };
}

describe('NQL → SQL mutation E2E', () => {
	it('S1: update with IN subquery produces inline SQL subquery', () => {
		const { sql } = mutationToSQL(
			'update authors set active = false where id in (posts | where published = false | select userId)',
		);
		expect(sql).toEqual(
			'update authors set active = $1 where authors.id = any (select posts_subq_0."userid" from posts as posts_subq_0 where posts_subq_0.published = $2)',
		);
	});

	it('S2: delete with NOT IN subquery produces inline SQL subquery', () => {
		const { sql } = mutationToSQL(
			'delete from comments where postId not in (posts | select id)',
		);
		expect(sql).toEqual(
			'delete from comments where not (comments."postid" = any (select posts_subq_0.id from posts as posts_subq_0))',
		);
	});

	it('S3: insert from with where', () => {
		const { sql } = mutationToSQL(
			'insert into archivedPosts from posts where published = false',
		);
		expect(sql).toEqual(
			'insert into "archivedposts" select * from posts where posts.published = $1',
		);
	});

	it('S4: update with RETURNING', () => {
		const { sql } = mutationToSQL(
			'update authors set active = false where id = 1 | select id, name',
		);
		expect(sql).toEqual(
			'update authors set active = $1 where authors.id = $2 returning authors.id as id, authors.name as name',
		);
	});
});

// ---------------------------------------------------------------------------
// NQL → SQL bind + CTE E2E tests (Block 3)
// ---------------------------------------------------------------------------

/**
 * Compile a multi-statement NQL program with bindings to SQL.
 * Handles CTE generation from bound queries.
 */
function bindToSQL(
	nql: string,
	model: ReturnType<typeof schema>['model'],
): { sql: string; params: readonly unknown[] } {
	const compiled = compile(nql, model);
	if (!compiled.success || !compiled.ast) {
		throw new Error(
			`NQL compilation failed: ${compiled.errors.map((e) => e.message).join(', ')}`,
		);
	}

	const ast = compiled.ast;
	const adapter = createPgsqlCompileOnlyAdapter();
	const opts = { model };
	const allParams: unknown[] = [];

	// Compile each binding to SQL for CTE generation
	const ctes: string[] = [];
	if (ast.bindings) {
		for (const [name, queryIntent] of ast.bindings) {
			const planReport = plan(queryIntent, model, {
				dialectCapabilities: POSTGRESQL_CAPABILITIES,
			});
			const result = adapter.compile(planReport, opts);
			ctes.push(`"${name}" as (${normalizeSQL(result.sql)})`);
			allParams.push(...result.parameters);
		}
	}

	// Compile the final statement (mutation or query)
	let finalSql: string;
	if (ast.mutation) {
		const mutation = ast.mutation;
		let result: { sql: string; parameters: readonly unknown[] };
		if (isUpdateIntent(mutation)) {
			result = adapter.compileUpdate(mutation, opts);
		} else if (isDeleteIntent(mutation)) {
			result = adapter.compileDelete(mutation, opts);
		} else if (isInsertIntent(mutation)) {
			result = adapter.compileInsert(mutation, opts);
		} else if (mutation.type === 'insert_from') {
			result = adapter.compileInsertFrom(mutation as InsertFromIntent, opts);
		} else if (mutation.type === 'upsert_from') {
			result = adapter.compileUpsertFrom(mutation as UpsertFromIntent, opts);
		} else {
			throw new Error(
				`Unsupported mutation type: ${(mutation as { type: string }).type}`,
			);
		}
		finalSql = normalizeSQL(result.sql);
		allParams.push(...result.parameters);
	} else if (ast.query) {
		const planReport = plan(ast.query, model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		const result = adapter.compile(planReport, opts);
		finalSql = normalizeSQL(result.sql);
		allParams.push(...result.parameters);
	} else {
		throw new Error('No query or mutation in compiled result');
	}

	// Wrap with CTEs if present
	if (ctes.length > 0) {
		finalSql = `with ${ctes.join(', ')} ${finalSql}`;
	}

	return { sql: finalSql, params: allParams };
}

describe('NQL → SQL bind + CTE E2E', () => {
	it('D3: query bind + insert from produces CTE-wrapped SQL', () => {
		const { sql } = bindToSQL(
			'posts | where published = false | select id | bind subset\ninsert into archivedPosts from subset',
			mutationSchema.model,
		);
		expect(sql).toEqual(
			'with "subset" as (select posts.id from posts where posts.published = $1) insert into "archivedposts" select * from subset',
		);
	});

	it('D4: query bind + delete using bound ref in WHERE subquery', () => {
		const { sql } = bindToSQL(
			'posts | where published = false | select id | bind toDelete\ndelete from comments where postId in (toDelete)',
			mutationSchema.model,
		);
		expect(sql).toEqual(
			'with "toDelete" as (select posts.id from posts where posts.published = $1) delete from comments where comments."postid" = any (select "todelete_subq_0".id from "todelete" as "todelete_subq_0")',
		);
	});
});

// ---------------------------------------------------------------------------
// NQL → SQL upsert-from E2E tests (Block 4)
// ---------------------------------------------------------------------------
describe('NQL → SQL upsert-from E2E', () => {
	it('E1: basic upsert from compiles to INSERT ... SELECT ... ON CONFLICT', () => {
		const { sql } = mutationToSQL('upsert into authors on id from posts');
		expect(sql).toEqual(
			'insert into authors (id, name, email, active)' +
				' select posts.id as id, posts.name as name, posts.email as email, posts.active as active from posts' +
				' on conflict (id) do update set name = excluded.name, email = excluded.email, active = excluded.active',
		);
	});

	it('E2: upsert from with WHERE clause on source', () => {
		const { sql, params } = mutationToSQL(
			'upsert into authors on id from posts where published = true',
		);
		expect(sql).toEqual(
			'insert into authors (id, name, email, active)' +
				' select posts.id as id, posts.name as name, posts.email as email, posts.active as active from posts' +
				' where posts.published = $1' +
				' on conflict (id) do update set name = excluded.name, email = excluded.email, active = excluded.active',
		);
		expect(params).toEqual([true]);
	});

	it('E3: multi-statement bind + upsert from produces CTE-wrapped SQL', () => {
		const { sql } = bindToSQL(
			'posts | where published = true | select userId | bind active\nupsert into authors on id from active',
			mutationSchema.model,
		);
		expect(sql).toEqual(
			'with "active" as (select posts."userid" from posts where posts.published = $1)' +
				' insert into authors (id, name, email, active)' +
				' select active.id as id, active.name as name, active.email as email, active.active as active from active' +
				' on conflict (id) do update set name = excluded.name, email = excluded.email, active = excluded.active',
		);
	});
});
