/**
 * Tests for code review fixes (2026-04-19)
 *
 * B1 - CTE include: ESM-safe static import (no require())
 * B2 - Parameterized LIMIT emits ParamRef not literal index
 * B3 - Multi-hop relationColumn dotted path resolves leaf alias
 * C1 - Upsert conflictTarget.where partial-index WHERE clause
 * C3 - compileWithIncludes no double-fetch (subqueryIncludes always empty)
 * C5 - Introspected column defaults stored as { sql } verbatim
 * C7 - resolveExistsIntent walks AND/OR/NOT recursively
 * D1 - validateSqlExpression error message clarifies $$
 */

import { and, exists, ref, schema } from '@dbsp/core';
import type { Node } from '@pgsql/types';
import { deparseSync } from 'pgsql-deparser';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
	CompilerContext,
	CompilerState,
	Decision,
} from '../handlers/types.js';
import { registerAllWhereHandlers } from '../handlers/where/index.js';
import {
	buildOnConflictClause,
	type UpsertConfig,
} from '../mutations/upsert.js';
import { CamelCaseNamingPlugin } from '../naming-plugin.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';
import { validateSqlExpression } from '../validate.js';

beforeAll(() => {
	registerAllWhereHandlers();
});

const naming = new CamelCaseNamingPlugin();

function makeCtx(table: string): CompilerContext {
	return { naming, rootTable: table, maxRecursiveDepth: 100 };
}

function makeState(): CompilerState {
	return {
		parameters: [],
		paramIndex: 0,
		joins: [],
		ctes: new Map<string, Node>(),
		aliases: new Map<string, string>(),
	};
}

// ---------------------------------------------------------------------------
// B1: CTE handler static import — ESM-safe (no dynamic require)
// ---------------------------------------------------------------------------
describe('B1: CTE handler import (ESM-safe)', () => {
	it('cte.ts loads without ReferenceError (static import of createWhereDispatcher)', async () => {
		const { cteIncludeHandler } = await import('../handlers/include/cte.js');
		expect(cteIncludeHandler).toBeDefined();
		expect(typeof cteIncludeHandler.compile).toBe('function');
	});
});

// ---------------------------------------------------------------------------
// B3: Multi-hop relationColumn dotted path resolves leaf alias
// ---------------------------------------------------------------------------
describe('B3: Multi-hop relationColumn dotted path', () => {
	it('callee.file resolves to registered leaf alias "file_0"', async () => {
		const { relationColumnHandler } = await import(
			'../handlers/expression/relation.js'
		);
		const state = makeState();
		state.aliases.set('file', 'file_0');

		const decision = {
			type: 'selectRelationColumn',
			relation: 'callee.file',
			column: 'name',
		} as unknown as Decision;

		const node = relationColumnHandler.compile(
			decision,
			makeCtx('calls'),
			state,
		);
		const wrapped = {
			SelectStmt: { targetList: [{ ResTarget: { val: node } }] },
		} as unknown as Node;
		const sql = deparseSync(wrapped);

		expect(sql).toContain('file_0');
		expect(sql).not.toContain('callee');
	});

	it('dotted path falls back to leaf segment name when no alias registered', async () => {
		const { relationColumnHandler } = await import(
			'../handlers/expression/relation.js'
		);
		const state = makeState();

		const decision = {
			type: 'selectRelationColumn',
			relation: 'callee.file',
			column: 'size',
		} as unknown as Decision;

		const node = relationColumnHandler.compile(
			decision,
			makeCtx('calls'),
			state,
		);
		const wrapped = {
			SelectStmt: { targetList: [{ ResTarget: { val: node } }] },
		} as unknown as Node;
		const sql = deparseSync(wrapped);

		// Must use leaf 'file', not the broken dotted identifier '"callee.file"'
		// pgsql-deparser emits lowercase identifiers without quotes: file.size
		expect(sql).toMatch(/\bfile\b/);
		expect(sql).not.toContain('callee.file');
		expect(sql).not.toContain('"callee.file"');
	});
});

// ---------------------------------------------------------------------------
// C1: Upsert partial-index WHERE clause on conflictTarget
// ---------------------------------------------------------------------------
describe('C1: Upsert conflictTarget.where partial-index', () => {
	it('whereClause is present on infer when conflictTarget.where is set', () => {
		const ctx = makeCtx('users');
		const state = makeState();

		const config: UpsertConfig = {
			table: 'users',
			columns: ['email', 'name'],
			conflictTarget: {
				columns: ['email'],
				where: [
					{
						type: 'where',
						column: 'active',
						operator: 'eq',
						value: true,
						table: 'users',
					} as unknown as Decision,
				],
			},
			conflictAction: 'nothing',
		};

		const clause = buildOnConflictClause(config, ctx, state);
		const infer = (clause as unknown as Record<string, unknown>)
			.infer as Record<string, unknown>;

		expect(infer).toBeDefined();
		expect(infer.indexElems).toBeDefined();
		expect(infer.whereClause).toBeDefined();
	});

	it('whereClause is absent on infer when conflictTarget has no where', () => {
		const ctx = makeCtx('users');
		const state = makeState();

		const config: UpsertConfig = {
			table: 'users',
			columns: ['email'],
			conflictTarget: { columns: ['email'] },
			conflictAction: 'nothing',
		};

		const clause = buildOnConflictClause(config, ctx, state);
		const infer = (clause as unknown as Record<string, unknown>)
			.infer as Record<string, unknown>;
		expect(infer.whereClause).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// C3: compileWithIncludes — subqueryIncludes always empty
// ---------------------------------------------------------------------------
describe('C3: compileWithIncludes no double-fetch', () => {
	it('subqueryIncludes is empty even when plan has subquery include-strategy', async () => {
		const { compileWithIncludes } = await import(
			'../adapter-compiler-select.js'
		);

		const plan = {
			rootTable: 'posts',
			decisions: [
				{
					type: 'include-strategy',
					choice: 'subquery',
					context: {
						relation: 'author',
						target: 'users',
						relationType: 'belongsTo',
					},
				},
			],
			warnings: [],
		} as unknown as Parameters<typeof compileWithIncludes>[0];

		const deps = {
			naming,
			defaultPk: 'id',
			deriveFk: undefined,
		} as unknown as Parameters<typeof compileWithIncludes>[2];

		const result = compileWithIncludes(plan, undefined, deps);
		expect(result.subqueryIncludes).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// C5: Column defaults { sql } format — verbatim DDL emission
// ---------------------------------------------------------------------------
describe('C5: Column default { sql } emitted verbatim in DDL', () => {
	it('{ sql: "CURRENT_TIMESTAMP" } appears verbatim in CREATE TABLE', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');

		const schema = {
			tables: new Map([
				[
					'events',
					{
						name: 'events',
						columns: [
							{ name: 'id', type: 'number', nullable: false },
							{
								name: 'created_at',
								type: 'datetime',
								nullable: false,
								default: { sql: 'CURRENT_TIMESTAMP' },
							},
						],
						primaryKey: 'id',
						foreignKeys: [],
						indexes: [],
					},
				],
			]),
		} as Parameters<typeof generateDDL>[0];

		const stmts = generateDDL(schema);
		const ddl = stmts.join('\n');
		expect(ddl).toContain('CURRENT_TIMESTAMP');
		expect(ddl).not.toContain("'CURRENT_TIMESTAMP'");
	});

	it('raw string default is still quoted as a string literal', async () => {
		const { generateDDL } = await import('../ddl/ddl-generator.js');

		const schema = {
			tables: new Map([
				[
					'items',
					{
						name: 'items',
						columns: [
							{
								name: 'status',
								type: 'string',
								nullable: false,
								default: 'pending',
							},
						],
						foreignKeys: [],
						indexes: [],
					},
				],
			]),
		} as Parameters<typeof generateDDL>[0];

		const stmts = generateDDL(schema);
		const ddl = stmts.join('\n');
		expect(ddl).toContain("'pending'");
	});
});

// ---------------------------------------------------------------------------
// C7: resolveExistsIntent recursive AND/OR/NOT walk
// ---------------------------------------------------------------------------

// Schema: users with two inverse hasMany relations pointing to different tables.
// resolveExistsIntent must walk the AND node and enrich BOTH exists children,
// not just the top-level condition.
const c7Schema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		author_id: ref('users', { as: 'author', inverse: 'user_posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		writer_id: ref('users', { as: 'writer', inverse: 'user_comments' }),
	},
});

describe('C7: resolveExistsIntent recursive walk', () => {
	it('AND(exists, exists): both branches get targetTable resolved in compiled SQL', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: c7Schema.model });

		// WHERE EXISTS(user_posts) AND EXISTS(user_comments)
		// resolveExistsIntent must recurse into the AND and enrich both children.
		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'users',
			where: and(exists('user_posts'), exists('user_comments')),
		});

		// Both EXISTS subqueries must reference real table names, not relation names.
		// If recursion was removed/flattened, one or both would fall back to the
		// relation name (user_posts / user_comments) instead of the table name.
		expect(sql).toMatch(/EXISTS/i);
		expect(sql).toMatch(/FROM\s+"?posts"?/i);
		expect(sql).toMatch(/FROM\s+"?comments"?/i);
		// Must NOT use the logical relation names as table names
		expect(sql).not.toMatch(/FROM\s+"?user_posts"?/i);
		expect(sql).not.toMatch(/FROM\s+"?user_comments"?/i);
	});

	it('NOT(exists): negated exists inside NOT node gets targetTable resolved', () => {
		const adapter = createPgsqlCompileOnlyAdapter({ model: c7Schema.model });

		// NOT EXISTS(user_posts) — resolveExistsIntent must walk the NOT branch.
		const { sql } = adapter.compileDelete({
			type: 'delete' as const,
			table: 'users',
			where: { kind: 'not', condition: exists('user_posts') },
		});

		expect(sql).toMatch(/NOT.*EXISTS/i);
		expect(sql).toMatch(/FROM\s+"?posts"?/i);
		expect(sql).not.toMatch(/FROM\s+"?user_posts"?/i);
	});
});

// ---------------------------------------------------------------------------
// D1: validateSqlExpression error message clarifies $$
// ---------------------------------------------------------------------------
describe('D1: validateSqlExpression $$ clarification', () => {
	it('error message mentions "$$ (dollar-quoted strings)"', () => {
		expect(() => validateSqlExpression('foo$$bar', 'test')).toThrow(
			'$$ (dollar-quoted strings)',
		);
	});

	it('rejects $$ expressions', () => {
		expect(() => validateSqlExpression('$$unsafe$$', 'policy')).toThrow();
	});

	it('allows nextval expression (no $$)', () => {
		expect(() =>
			validateSqlExpression("nextval('my_seq'::regclass)", 'default'),
		).not.toThrow();
	});
});
