import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	createOrm,
	eq,
	exists,
	gt,
	ModelIRImpl,
	plan,
	planRecursive,
	ref,
	schema,
} from '@dbsp/core';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
/** Naming is restricted to physical-model construction and DDL/code generation. */
const namingAllowed = new Set([
	'index.ts',
	'naming-plugin.ts',
	'physical-model/index.ts',
	'sequence-name.ts',
]);
const namingAllowedDirectories = ['ddl/', 'transition/'];

function sourceFiles(
	directory: string,
	prefix = '',
): readonly [string, string][] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const relative = `${prefix}${entry.name}`;
		const absolute = `${directory}/${entry.name}`;
		if (entry.isDirectory() && entry.name === '__tests__') return [];
		if (entry.isDirectory()) return sourceFiles(absolute, `${relative}/`);
		return entry.isFile() &&
			entry.name.endsWith('.ts') &&
			!entry.name.endsWith('.test.ts')
			? [[relative, readFileSync(absolute, 'utf8')]]
			: [];
	});
}

function namingViolations(relative: string, text: string): string[] {
	const allowed =
		namingAllowed.has(relative) ||
		namingAllowedDirectories.some((directory) =>
			relative.startsWith(directory),
		);
	const source = ts.createSourceFile(
		relative,
		text,
		ts.ScriptTarget.Latest,
		true,
	);
	const violations: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			const specifier = node.moduleSpecifier.text;
			if (
				!allowed &&
				(specifier.endsWith('/naming-plugin.js') ||
					specifier.endsWith('/naming.js'))
			)
				violations.push(`${relative}: forbidden import ${specifier}`);
		}
		if (
			!allowed &&
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression)
		) {
			const name = node.expression.name.text;
			const isPromiseResolve =
				name === 'resolve' &&
				ts.isIdentifier(node.expression.expression) &&
				node.expression.expression.text === 'Promise';
			if (
				!isPromiseResolve &&
				(name === 'resolve' ||
					name === 'model' ||
					name === 'toDatabase' ||
					name === 'toModel')
			)
				violations.push(`${relative}: forbidden naming call .${name}()`);
		}
		if (
			relative !== 'sql-identifier.ts' &&
			ts.isAsExpression(node) &&
			node.type.getText(source) === 'SqlIdentifier'
		)
			violations.push(
				`${relative}: only sql-identifier.ts may cast as SqlIdentifier`,
			);
		ts.forEachChild(node, visit);
	};
	visit(source);
	return violations;
}

describe('query naming boundary', () => {
	it('uses the physical root range variable for every root-table reference', () => {
		const model = schema({
			users: { id: { type: 'integer', primaryKey: true } },
			userRoles: {
				id: { type: 'integer', primaryKey: true },
				userId: ref('users'),
				roleId: 'integer',
			},
			auditLogs: {
				id: { type: 'integer', primaryKey: true },
				userRoleId: ref('userRoles'),
			},
			auditEvents: {
				id: { type: 'integer', primaryKey: true },
				auditLogId: ref('auditLogs'),
			},
		}).model;
		const orm = createOrm({
			model,
			adapter: createPgsqlCompileOnlyAdapter({
				model,
				dbCasing: 'snake_case',
			}),
		});

		const root = orm
			.select('userRoles')
			.where(eq('userId', 7))
			.orderBy('userId')
			.dump();
		expect(root.sql).toBe(
			'SELECT user_roles.* FROM user_roles WHERE user_roles.user_id = $1 ORDER BY user_roles.user_id ASC',
		);
		expect(orm.select('userRoles').columns(['userId']).dump().sql).toBe(
			'SELECT user_roles.user_id FROM user_roles',
		);

		const existsQuery = orm.select('users').where(exists('userRoles')).dump();
		expect(existsQuery.sql).toContain('users.id');
		expect(existsQuery.sql).toContain('"userRoles_exists_0".user_id');

		const joined = orm
			.select('userRoles')
			.include('user', { join: 'left' })
			.dump();
		expect(joined.sql).toContain('SELECT user_roles.*');
		expect(joined.sql).toContain('user_roles.user_id');

		const jsonAggregated = orm.select('userRoles').include('user').dump();
		expect(jsonAggregated.sql).toContain('user_roles.user_id');

		const lateral = orm
			.select('userRoles')
			.include('auditLogs', { limit: 1 } as never)
			.dump();
		expect(lateral.sql).toContain('user_roles.id');

		const nested = orm
			.select('userRoles')
			.include('auditLogs')
			.include('auditLogs.auditEvents')
			.dump();
		expect(nested.sql).toContain('json_agg');
	});

	it('resolves recursive edge-table addresses from their logical names', () => {
		const model = schema({
			roles: { id: { type: 'integer', primaryKey: true }, name: 'string' },
			roleEdges: {
				id: { type: 'integer', primaryKey: true },
				parentRoleId: ref('roles', { as: 'parentRole' }),
				childRoleId: ref('roles', { as: 'childRole' }),
			},
		}).model;
		const adapter = createPgsqlCompileOnlyAdapter({
			model,
			dbCasing: 'snake_case',
		});
		const report = planRecursive(
			{
				type: 'recursive',
				cteName: 'roleTree',
				start: {
					from: 'roles',
					nodeIdExpr: { kind: 'column', name: 'id' },
				},
				traversal: {
					kind: 'edge-table',
					nodeTable: 'roles',
					edgeTable: 'roleEdges',
					nodeId: 'id',
					edgeFrom: 'parentRoleId',
					edgeTo: 'childRoleId',
					direction: 'out',
				},
				maxDepth: 2,
				dedupe: 'final',
			},
			model,
		);

		expect(adapter.compileRecursive(report, model).sql).toContain('role_edges');
	});

	it.each(['snake_case', 'preserve'] as const)(
		'keeps declared mutation relation keys at their addressed table with %s casing',
		(dbCasing) => {
			const model = schema({
				posts: {
					id: { type: 'integer', primaryKey: true },
					archived: 'boolean',
				},
				comments: {
					id: { type: 'integer', primaryKey: true },
					postId: ref('posts', { as: 'post', inverse: 'comments' }),
					flagged: 'boolean',
				},
			}).model;
			const orm = createOrm({
				model,
				adapter: createPgsqlCompileOnlyAdapter({ model, dbCasing }),
			});

			const compiled = orm
				.update('posts')
				.set({ archived: true })
				.where(exists('comments', { where: eq('flagged', true) }))
				.dump();
			expect(compiled.sql).toContain(
				dbCasing === 'snake_case'
					? 'posts.id = comments_exists_0.post_id'
					: 'posts.id = comments_exists_0."postId"',
			);
		},
	);

	it('validates a belongsTo source key against its source table', () => {
		const model = schema({
			authors: { id: { type: 'integer', primaryKey: true } },
			posts: { id: 'integer', authorId: ref('authors') },
		}).model;
		const adapter = createPgsqlCompileOnlyAdapter({
			model,
			dbCasing: 'snake_case',
		});
		const compiled = adapter.compileSubqueryInclude(
			{
				relationName: 'author',
				targetTable: 'authors',
				foreignKey: 'id',
				sourceKey: 'authorId',
				sourceTable: 'posts',
				relationType: 'belongsTo',
			},
			[7],
		);

		expect(compiled.sql).toContain('FROM authors WHERE id IN ($1)');
	});

	it.each(['snake_case', 'preserve'] as const)(
		'repeats a projected COUNT expression for a HAVING alias with %s casing',
		(dbCasing) => {
			const model = schema({
				posts: {
					id: { type: 'integer', primaryKey: true },
					published: 'boolean',
				},
			}).model;
			const orm = createOrm({
				model,
				adapter: createPgsqlCompileOnlyAdapter({
					model,
					dbCasing,
				}),
			});

			expect(
				orm
					.select('posts')
					.groupBy(['published'])
					.count('id', 'postCount')
					.having(gt('postCount', 10))
					.dump().sql,
			).toBe(
				'SELECT posts.published, count(posts.id) AS "postCount" FROM posts GROUP BY posts.published HAVING count(posts.id) > CAST($1 AS bigint)',
			);
		},
	);

	it('repeats a projected SUM expression for a HAVING alias', () => {
		const model = schema({ posts: { id: 'integer', amount: 'integer' } }).model;
		const orm = createOrm({
			model,
			adapter: createPgsqlCompileOnlyAdapter({ model, dbCasing: 'snake_case' }),
		});
		expect(
			orm
				.select('posts')
				.groupBy(['id'])
				.sum('amount', 'totalAmount')
				.having(gt('totalAmount', 10))
				.dump().sql,
		).toBe(
			'SELECT posts.id, sum(posts.amount) AS "totalAmount" FROM posts GROUP BY posts.id HAVING sum(posts.amount) > $1',
		);
	});

	it('casts HAVING operands to aggregate result types', () => {
		const declared = schema({ posts: { id: 'uuid', amount: 'decimal' } }).model;
		const table = declared.getTable('posts');
		if (!table) throw new Error('posts table missing from test schema');
		const model = new ModelIRImpl(
			new Map([
				[
					'posts',
					{
						...table,
						columns: table.columns.map((column) => ({
							...column,
							...(column.name === 'id' && { originalDbType: 'uuid' }),
							...(column.name === 'amount' && {
								originalDbType: 'numeric(10,2)',
							}),
						})),
					},
				],
			]),
			new Map(),
		);
		const orm = createOrm({
			model,
			adapter: createPgsqlCompileOnlyAdapter({ model, dbCasing: 'snake_case' }),
		});

		const countSql = orm
			.select('posts')
			.groupBy(['amount'])
			.count('id', 'postCount')
			.having(gt('postCount', 10))
			.dump().sql;
		expect(countSql).toContain('HAVING count(posts.id) > CAST($1 AS bigint)');

		const sumSql = orm
			.select('posts')
			.groupBy(['id'])
			.sum('amount', 'totalAmount')
			.having(gt('totalAmount', 10))
			.dump().sql;
		expect(sumSql).toContain('HAVING sum(posts.amount) > CAST($1 AS numeric)');

		const minSql = orm
			.select('posts')
			.groupBy(['amount'])
			.min('id', 'minimumId')
			.having(gt('minimumId', '00000000-0000-0000-0000-000000000001'))
			.dump().sql;
		expect(minSql).toContain('HAVING min(posts.id) > CAST($1 AS uuid)');
	});

	it('refuses a HAVING operand that is not a declared column or aggregate alias', () => {
		const model = schema({
			posts: { id: 'integer', published: 'boolean' },
		}).model;
		const orm = createOrm({
			model,
			adapter: createPgsqlCompileOnlyAdapter({ model, dbCasing: 'snake_case' }),
		});
		expect(() =>
			orm
				.select('posts')
				.groupBy(['published'])
				.count('id', 'postCount')
				.having(gt('missingMetric', 10))
				.dump(),
		).toThrow(/missingMetric/);
	});

	it('refuses undeclared addressed mutation and select references', () => {
		const model = schema({
			userProfiles: { id: 'integer', displayName: 'string' },
		}).model;
		const adapter = createPgsqlCompileOnlyAdapter({
			model,
			dbCasing: 'snake_case',
		});
		expect(() =>
			adapter.compileInsert(
				{
					type: 'insert',
					table: 'userProfiles',
					values: [{ missingColumn: 'x' }],
				} as never,
				{ model },
			),
		).toThrow(
			"Declared column 'userProfiles.missingColumn' is missing from the physical inventory.",
		);
		expect(() =>
			adapter.compileInsert(
				{ type: 'insert', table: 'missingTable', values: [{ id: 1 }] } as never,
				{ model },
			),
		).toThrow(
			"Declared table 'missingTable' is missing from the physical inventory.",
		);
		expect(() =>
			adapter.compileUpsert(
				{
					type: 'upsert',
					table: 'userProfiles',
					values: [{ id: 1 }],
					onConflict: { columns: ['missingColumn'] },
					action: { type: 'doNothing' },
				} as never,
				{ model },
			),
		).toThrow(
			"Declared column 'userProfiles.missingColumn' is missing from the physical inventory.",
		);
		expect(() =>
			adapter.compile(
				plan(
					{
						type: 'select',
						from: 'userProfiles',
						select: { type: 'fields', fields: ['missingColumn'] },
					},
					model,
				),
				{ model },
			),
		).toThrow(
			"Declared column 'userProfiles.missingColumn' is missing from the physical inventory.",
		);
	});

	it('resolves declared conflict constraints and rejects catalog-only constraints', () => {
		const model = schema({
			userProfiles: {
				id: { type: 'integer', primaryKey: true },
				email: 'string',
			},
		}).model;
		const adapter = createPgsqlCompileOnlyAdapter({
			model,
			dbCasing: 'snake_case',
		});
		const base = {
			type: 'upsert' as const,
			table: 'userProfiles',
			values: [{ id: 1, email: 'a@example.test' }],
			action: { type: 'doNothing' as const },
		};

		expect(
			adapter.compileUpsert(
				{ ...base, onConflict: { constraint: 'pk_userProfiles' } },
				{ model },
			).sql,
		).toBe(
			'INSERT INTO user_profiles (id, email) VALUES ($1, $2) ON CONFLICT ON CONSTRAINT pk_user_profiles DO NOTHING',
		);
		expect(() =>
			adapter.compileUpsert(
				{
					...base,
					onConflict: { constraint: 'runtime_user_profiles_email_uq' },
				},
				{ model },
			),
		).toThrow(
			"Declared constraint 'userProfiles.runtime_user_profiles_email_uq' is absent from the physical model.",
		);
	});

	it('enforces the TypeScript-AST naming boundary', () => {
		const violations = sourceFiles(sourceRoot).flatMap(([relative, text]) =>
			namingViolations(relative, text),
		);
		expect(violations).toEqual([]);
	});

	it('rejects a forbidden import in the AST guard fixture', () => {
		const violations = namingViolations(
			'compiler.ts',
			"import { identityNaming } from './naming-plugin.js';",
		);
		expect(violations).toEqual([
			'compiler.ts: forbidden import ./naming-plugin.js',
		]);
	});
});
