/**
 * JSON_AGG handler tests
 *
 * Verifies the handler produces the same SQL as the compiler's
 * compileJsonAggDecision for all nesting depths.
 */

import type { ColumnIR, ModelIR, TableIR } from '@dbsp/types';
import { deparseSync } from 'pgsql-deparser';
import { parseSync } from 'pgsql-parser';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../../../ast-helpers.js';
import { identityNaming } from '../../../naming-plugin.js';
import type { CompilerContext, Decision } from '../../types.js';
import { createCompilerState } from '../../types.js';
import { jsonAggIncludeHandler } from '../json-agg.js';

function makeCtx(rootTable: string, currentAlias?: string): CompilerContext {
	return {
		naming: identityNaming,
		rootTable,
		maxRecursiveDepth: 100,
		...(currentAlias != null && { currentAlias }),
	} as CompilerContext;
}

function buildDecision(overrides: Partial<Decision> = {}): Decision {
	return {
		type: 'selectJsonAgg',
		relation: 'posts',
		targetTable: 'posts',
		relationType: 'hasMany',
		foreignKey: 'user_id',
		parentKey: 'id',
		orderBy: ['id'],
		...overrides,
	} as Decision;
}

function makeModel(
	tables: Record<
		string,
		{
			readonly columns: readonly (
				| string
				| {
						readonly name: string;
						readonly type?: ColumnIR['type'];
						readonly originalDbType?: string;
				  }
			)[];
			readonly primaryKey?: string | readonly string[];
		}
	>,
): ModelIR {
	const tableMap = new Map<string, TableIR>();
	for (const [name, table] of Object.entries(tables)) {
		tableMap.set(name, {
			name,
			columns: table.columns.map((column) =>
				typeof column === 'string'
					? { name: column, type: 'text' }
					: {
							name: column.name,
							type: column.type ?? 'text',
							...(column.originalDbType !== undefined && {
								originalDbType: column.originalDbType,
							}),
						},
			),
			...(table.primaryKey !== undefined && { primaryKey: table.primaryKey }),
			foreignKeys: [],
			indexes: [],
		} as unknown as TableIR);
	}
	return {
		tables: tableMap,
		relations: new Map(),
		getTable: (name: string) => tableMap.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	} as unknown as ModelIR;
}

/**
 * Convert handler IncludeResult targets to SQL for assertions.
 * Wraps the ResTarget(s) into a SELECT statement, deparses, normalizes.
 */
function targetsToSQL(targets: import('@pgsql/types').Node[]): string {
	const stmt = {
		SelectStmt: {
			targetList: targets,
			fromClause: [
				{
					RangeVar: {
						relname: 'dummy',
						inh: true,
						relpersistence: 'p',
					},
				},
			],
		},
	};
	return normalizeSQL(deparseSync(stmt));
}

describe('json-agg handler', () => {
	it('produces single-level json_agg with to_jsonb', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision();

		const result = jsonAggIncludeHandler.compile(decision, ctx, state);

		expect(result.targets).toHaveLength(1);
		const sql = targetsToSQL(result.targets!);

		expect(sql).toContain('json_agg');
		expect(sql).toContain('to_jsonb');
		expect(sql).toContain('__t__');
		expect(sql).toContain('posts');
		expect(sql).toContain('__t__.user_id = users.id');
		expect(sql).toContain(
			'json_agg(to_jsonb(__t__) order by __t__.id asc nulls last)',
		);
		// No children → no jsonb_build_object
		expect(sql).not.toContain('jsonb_build_object');
	});

	it('produces two-level nested json_agg with jsonb_build_object', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision({
			relation: 'userRoles',
			targetTable: 'user_roles',
			relationType: 'hasMany',
			foreignKey: 'user_id',
			parentKey: 'id',
			children: [
				buildDecision({
					relation: 'role',
					targetTable: 'roles',
					relationType: 'belongsTo',
					foreignKey: 'role_id',
					parentKey: 'id',
					orderBy: ['slug'],
				}),
			],
		});

		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		const sql = targetsToSQL(result.targets!);

		// Root level uses __t__
		expect(sql).toContain('user_roles as __t__');
		expect(sql).toContain('__t__.user_id = users.id');

		// Nested level uses __t1__
		expect(sql).toContain('roles as __t1__');
		// belongsTo: target.pk = parent.fk → __t1__.id = __t__.role_id
		expect(sql).toContain('__t1__.id = __t__.role_id');
		expect(sql).toContain('order by __t__.id asc nulls last');
		expect(sql).toContain('order by __t1__.slug asc nulls last');

		// Must have jsonb_build_object for merging child
		expect(sql).toContain('jsonb_build_object');
		expect(sql).toContain("'role'");
	});

	it('produces three-level nested json_agg', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision({
			relation: 'userRoles',
			targetTable: 'user_roles',
			relationType: 'hasMany',
			foreignKey: 'user_id',
			parentKey: 'id',
			children: [
				buildDecision({
					relation: 'role',
					targetTable: 'roles',
					relationType: 'belongsTo',
					foreignKey: 'role_id',
					parentKey: 'id',
					children: [
						buildDecision({
							relation: 'permissions',
							targetTable: 'permissions',
							relationType: 'hasMany',
							foreignKey: 'role_id',
							parentKey: 'id',
						}),
					],
				}),
			],
		});

		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		const sql = targetsToSQL(result.targets!);

		expect(sql).toContain('user_roles as __t__');
		expect(sql).toContain('roles as __t1__');
		expect(sql).toContain('permissions as __t2__');

		expect(sql).toContain('__t__.user_id = users.id');
		expect(sql).toContain('__t1__.id = __t__.role_id');
		expect(sql).toContain('__t2__.role_id = __t1__.id');
	});

	it('handles belongsTo correlation correctly', () => {
		const ctx = makeCtx('posts');
		const state = createCompilerState();
		const decision = buildDecision({
			relation: 'author',
			targetTable: 'users',
			relationType: 'belongsTo',
			foreignKey: 'author_id',
			parentKey: 'id',
		});

		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		const sql = targetsToSQL(result.targets!);

		// belongsTo: parent.fk = target.pk → __t__.id = posts.author_id
		expect(sql).toContain('__t__.id = posts.author_id');
	});

	it('builds hasMany json_agg correlation from every composite key column', () => {
		const ctx = makeCtx('orders');
		const state = createCompilerState();
		const decision = buildDecision({
			relation: 'items',
			targetTable: 'order_items',
			relationType: 'hasMany',
			foreignKey: ['order_id', 'tenant_id'],
			parentKey: ['order_id', 'tenant_id'],
		});

		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		const sql = targetsToSQL(result.targets!);

		expect(sql).toContain('__t__.order_id = orders.order_id');
		expect(sql).toContain('__t__.tenant_id = orders.tenant_id');
		expect(sql).toContain('order by __t__.id asc nulls last');
		expect(sql).toMatch(
			/__t__\.order_id = orders\.order_id\s+and\s+__t__\.tenant_id = orders\.tenant_id/i,
		);
	});

	it('orders json_agg by composite target primary key from the model', () => {
		const ctx = {
			...makeCtx('orders'),
			model: makeModel({
				order_items: {
					columns: ['order_id', 'tenant_id', 'line_no', 'sku'],
					primaryKey: ['order_id', 'tenant_id', 'line_no'],
				},
			}),
		};
		const state = createCompilerState();
		const decision = buildDecision({
			relation: 'items',
			targetTable: 'order_items',
			relationType: 'hasMany',
			foreignKey: ['order_id', 'tenant_id'],
			parentKey: ['order_id', 'tenant_id'],
		});

		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		const sql = targetsToSQL(result.targets!);

		expect(sql).toContain(
			'order by __t__.order_id asc nulls last, __t__.tenant_id asc nulls last, __t__.line_no asc nulls last',
		);
		expect(sql).not.toContain('__t__.order_id::text');
		expect(sql).not.toContain('__t__.tenant_id::text');
		expect(sql).not.toContain('__t__.line_no::text');
	});

	it('casts every no-primary-key fallback column to text', () => {
		const ctx = {
			...makeCtx('users'),
			model: makeModel({
				audit_events: {
					columns: ['user_id', 'event_time', 'message'],
				},
			}),
		};
		const state = createCompilerState();
		const decision = buildDecision({
			relation: 'auditEvents',
			targetTable: 'audit_events',
			relationType: 'hasMany',
			foreignKey: 'user_id',
			parentKey: 'id',
		});

		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		const sql = targetsToSQL(result.targets!);

		expect(sql).toContain(
			'order by __t__.user_id::text asc nulls last, __t__.event_time::text asc nulls last, __t__.message::text asc nulls last',
		);
	});

	it('casts decision-only no-primary-key fallback columns when the neutral flag is set', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision({
			relation: 'auditEvents',
			targetTable: 'audit_events',
			relationType: 'hasMany',
			foreignKey: 'user_id',
			parentKey: 'id',
			orderBy: ['user_id', 'event_time', 'message'],
			orderByFallback: true,
		});

		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		const sql = targetsToSQL(result.targets!);

		expect(sql).toContain(
			'order by __t__.user_id::text asc nulls last, __t__.event_time::text asc nulls last, __t__.message::text asc nulls last',
		);
	});

	it('casts mixed no-primary-key fallback columns to text, including extension db types', () => {
		const ctx = {
			...makeCtx('users'),
			model: makeModel({
				audit_events: {
					columns: [
						{ name: 'user_id', type: 'integer' },
						{ name: 'payload', type: 'json' },
						{ name: 'search_payload', type: 'jsonb' },
						{
							name: 'embedding',
							type: 'text',
							originalDbType: 'vector(768)',
						},
						{ name: 'message', type: 'text' },
					],
				},
			}),
		};
		const state = createCompilerState();
		const decision = buildDecision({
			relation: 'auditEvents',
			targetTable: 'audit_events',
			relationType: 'hasMany',
			foreignKey: 'user_id',
			parentKey: 'id',
		});

		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		const sql = targetsToSQL(result.targets!);

		expect(sql).toContain(
			'order by __t__.user_id::text asc nulls last, __t__.payload::text asc nulls last, __t__.search_payload::text asc nulls last, __t__.embedding::text asc nulls last, __t__.message::text asc nulls last',
		);
		expect(() => parseSync(sql)).not.toThrow();
	});

	it('skips children with missing required fields', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision({
			children: [
				{
					type: 'selectJsonAgg',
					relation: 'orphan',
					targetTable: 'orphans',
					foreignKey: 'user_id',
					parentKey: 'id',
					// Missing relationType → should be skipped
				} as Decision,
			],
		});

		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		const sql = targetsToSQL(result.targets!);

		expect(sql).toContain('posts');
		expect(sql).not.toContain('orphans');
		expect(sql).not.toContain('jsonb_build_object');
	});

	it('projects specific columns via jsonb_build_object when columns specified', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision({
			columns: ['id', 'title', 'created_at'],
		});

		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		const sql = targetsToSQL(result.targets!);

		// Should use jsonb_build_object instead of to_jsonb
		expect(sql).toContain('jsonb_build_object');
		expect(sql).not.toContain('to_jsonb');
		// Each column appears as key + reference
		expect(sql).toContain("'id'");
		expect(sql).toContain('__t__.id');
		expect(sql).toContain("'title'");
		expect(sql).toContain('__t__.title');
		expect(sql).toContain("'created_at'");
		expect(sql).toContain('__t__.created_at');
	});

	it('uses to_jsonb for wildcard columns', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision({
			columns: ['*'],
		});

		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		const sql = targetsToSQL(result.targets!);

		// Wildcard should fall back to to_jsonb(__t__)
		expect(sql).toContain('to_jsonb');
		expect(sql).not.toContain('jsonb_build_object');
	});

	it('projects columns with nested children (merge via ||)', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision({
			relation: 'userRoles',
			targetTable: 'user_roles',
			relationType: 'hasMany',
			foreignKey: 'user_id',
			parentKey: 'id',
			columns: ['id', 'role_id'],
			children: [
				buildDecision({
					relation: 'role',
					targetTable: 'roles',
					relationType: 'belongsTo',
					foreignKey: 'role_id',
					parentKey: 'id',
				}),
			],
		});

		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		const sql = targetsToSQL(result.targets!);

		// Parent should use jsonb_build_object for column projection
		expect(sql).toContain("jsonb_build_object('id'");
		expect(sql).toContain("'role_id'");
		// Should merge with child via ||
		expect(sql).toContain('||');
		// Child (no columns specified) should use to_jsonb
		expect(sql).toContain('to_jsonb');
	});

	it('produces valid parseable SQL', () => {
		const ctx = makeCtx('users');
		const state = createCompilerState();
		const decision = buildDecision({
			relation: 'userRoles',
			targetTable: 'user_roles',
			relationType: 'hasMany',
			foreignKey: 'user_id',
			parentKey: 'id',
			children: [
				buildDecision({
					relation: 'role',
					targetTable: 'roles',
					relationType: 'belongsTo',
					foreignKey: 'role_id',
					parentKey: 'id',
				}),
			],
		});

		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		const sql = targetsToSQL(result.targets!);

		// Round-trip through parser
		const parsed = parseSync(
			`SELECT ${sql.replace(/^SELECT\s+/i, '').replace(/\s+FROM\s+dummy$/i, '')} FROM dummy`,
		);
		expect(parsed.stmts).toHaveLength(1);
	});
});
