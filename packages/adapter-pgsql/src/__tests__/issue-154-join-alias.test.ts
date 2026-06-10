import {
	createOrm,
	InvalidOperationError,
	ref,
	relationColumn,
	schema,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const issue154Schema = schema({
	files: {
		id: { type: 'integer', primaryKey: true },
		path: 'string',
	},
	definitions: {
		id: { type: 'integer', primaryKey: true },
		file_id: ref('files', { as: 'file', inverse: 'definitions' }),
	},
	owners: {
		id: { type: 'integer', primaryKey: true },
		file_id: ref('files', { as: 'file', inverse: 'owners' }),
	},
	uses: {
		id: { type: 'integer', primaryKey: true },
		def_id: ref('definitions', { as: 'definition', inverse: 'uses' }),
		file_id: ref('files', { as: 'file', inverse: 'uses' }),
		owner_id: ref('owners', { as: 'owner', inverse: 'uses' }),
		alt_file_id: ref('files', { as: 'file_1', inverse: 'alt_uses' }),
	},
});

function buildOrm(model = issue154Schema.model) {
	const adapter = createPgsqlCompileOnlyAdapter({ model });
	return createOrm({ model, adapter });
}

function compact(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

function joinCount(sql: string): number {
	return compact(sql).match(/\bJOIN\b/g)?.length ?? 0;
}

describe('FIX-154: path-based join identity for multi-path includes', () => {
	it('S2/D1-D3: two paths to files keep column aliases, reuse definition, and anchor ON clauses by path', () => {
		const orm = buildOrm();
		const sql = compact(
			orm
				.select('uses')
				.include('definition', { join: 'inner' })
				.include('definition.file', { join: 'inner' })
				.include('file', { join: 'inner' })
				.columns([
					relationColumn('definition.file', 'path', 'def_file'),
					relationColumn('file', 'path', 'use_file'),
				])
				.dump().sql,
		);

		expect(joinCount(sql)).toBe(3);
		expect(sql).toMatch(/JOIN definitions AS definition\b/);
		expect(sql).not.toMatch(/JOIN definitions AS definition_1\b/);
		expect(sql).toMatch(/JOIN files AS file\b/);
		expect(sql).toMatch(/JOIN files AS file_1\b/);
		expect(sql).toContain('definition.file_id = file.id');
		expect(sql).toContain('uses.file_id = file_1.id');
		expect(sql).toContain('file.path AS def_file');
		expect(sql).toContain('file_1.path AS use_file');
	});

	it('locks fallback hydration keys to relation-dotted paths when relation names collide', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'uses',
			decisions: [
				{
					type: 'includeStrategy',
					choice: 'join',
					joinType: 'inner',
					relationName: 'definition',
					relationPath: 'definition',
					targetTable: 'definitions',
					sourceTable: 'uses',
					relationType: 'belongsTo',
					foreignKey: 'def_id',
					parentKey: 'id',
					columns: [],
				},
				{
					type: 'includeStrategy',
					choice: 'join',
					joinType: 'inner',
					relationName: 'file',
					relationPath: 'definition.file',
					hydrationPrefix: 'definition.file',
					targetTable: 'files',
					sourceTable: 'definitions',
					relationType: 'belongsTo',
					foreignKey: 'file_id',
					parentKey: 'id',
					columns: ['path'],
				},
				{
					type: 'includeStrategy',
					choice: 'join',
					joinType: 'inner',
					relationName: 'file',
					relationPath: 'file',
					hydrationPrefix: 'file',
					targetTable: 'files',
					sourceTable: 'uses',
					relationType: 'belongsTo',
					foreignKey: 'file_id',
					parentKey: 'id',
					columns: ['path'],
				},
			],
		};
		const sql = compact(compilePlan(plan).sql);

		expect(joinCount(sql)).toBe(3);
		expect(sql).toContain('file.path AS "definition.file.path"');
		expect(sql).toContain('file_1.path AS "file.path"');
		expect(sql).not.toContain('AS "file_1.path"');
	});

	it('generalizes to three paths to the same target table', () => {
		const orm = buildOrm();
		const sql = compact(
			orm
				.select('uses')
				.include('definition.file', { join: 'inner' })
				.include('file', { join: 'inner' })
				.include('owner.file', { join: 'inner' })
				.columns([
					relationColumn('definition.file', 'path', 'def_file'),
					relationColumn('file', 'path', 'use_file'),
					relationColumn('owner.file', 'path', 'owner_file'),
				])
				.dump().sql,
		);

		expect(joinCount(sql)).toBe(5);
		expect(sql).toMatch(/JOIN files AS file\b/);
		expect(sql).toMatch(/JOIN files AS file_1\b/);
		expect(sql).toMatch(/JOIN files AS file_2\b/);
		expect(sql).toContain('definition.file_id = file.id');
		expect(sql).toContain('uses.file_id = file_1.id');
		expect(sql).toContain('owner.file_id = file_2.id');
	});

	it('S6: same relation at two self-referential depths uses parent alias for the second hop', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'employees',
			decisions: [
				{
					type: 'includeStrategy',
					choice: 'join',
					joinType: 'left',
					relationName: 'manager',
					relationPath: 'manager',
					targetTable: 'employees',
					sourceTable: 'employees',
					relationType: 'belongsTo',
					foreignKey: 'manager_id',
					parentKey: 'id',
					columns: ['name'],
					columnAliases: { name: 'manager_name' },
				},
				{
					type: 'includeStrategy',
					choice: 'join',
					joinType: 'left',
					relationName: 'manager',
					relationPath: 'manager.manager',
					targetTable: 'employees',
					sourceTable: 'employees',
					relationType: 'belongsTo',
					foreignKey: 'manager_id',
					parentKey: 'id',
					columns: ['name'],
					columnAliases: { name: 'grandmanager_name' },
				},
			],
		};
		const sql = compact(compilePlan(plan).sql);

		expect(joinCount(sql)).toBe(2);
		expect(sql).toMatch(/LEFT JOIN employees AS manager\b/);
		expect(sql).toMatch(/LEFT JOIN employees AS manager_1\b/);
		expect(sql).toContain('employees.manager_id = manager.id');
		expect(sql).toContain('manager.manager_id = manager_1.id');
		expect(sql).toContain('manager.name AS manager_name');
		expect(sql).toContain('manager_1.name AS grandmanager_name');
	});

	it('same path twice with identical options dedupes, but conflicting join types throw', () => {
		const orm = buildOrm();
		const identical = compact(
			orm
				.select('uses')
				.include('definition', { join: 'inner' })
				.include('definition', { join: 'inner' })
				.dump().sql,
		);
		expect(joinCount(identical)).toBe(1);

		expect(() =>
			orm
				.select('uses')
				.include('definition', { join: 'inner' })
				.include('definition', { join: 'left' })
				.dump(),
		).toThrow(InvalidOperationError);
		expect(() =>
			orm
				.select('uses')
				.include('definition', { join: 'inner' })
				.include('definition', { join: 'left' })
				.dump(),
		).toThrow(/definition/);
	});

	it('implicit intermediate and later explicit intermediate share one join', () => {
		const orm = buildOrm();
		const implicit = compact(
			orm.select('uses').include('definition.file', { join: 'inner' }).dump()
				.sql,
		);
		const explicitAfter = compact(
			orm
				.select('uses')
				.include('definition.file', { join: 'inner' })
				.include('definition', { join: 'inner' })
				.dump().sql,
		);

		expect(joinCount(implicit)).toBe(2);
		expect(joinCount(explicitAfter)).toBe(2);
		expect(explicitAfter).not.toMatch(/JOIN definitions AS definition_1\b/);
		expect(explicitAfter).toContain('definition.file_id = file.id');
	});

	it('sibling include order keeps path-specific ON anchors and explicit output aliases', () => {
		const orm = buildOrm();
		const sql = compact(
			orm
				.select('uses')
				.include('file', { join: 'inner' })
				.include('definition.file', { join: 'inner' })
				.include('definition', { join: 'inner' })
				.columns([
					relationColumn('definition.file', 'path', 'def_file'),
					relationColumn('file', 'path', 'use_file'),
				])
				.dump().sql,
		);

		expect(joinCount(sql)).toBe(3);
		expect(sql).toContain('uses.file_id = file.id');
		expect(sql).toContain('definition.file_id = file_1.id');
		expect(sql).toContain('file_1.path AS def_file');
		expect(sql).toContain('file.path AS use_file');
	});

	it('base-vs-generated alias collisions skip occupied generated names', () => {
		const orm = buildOrm();
		const sql = compact(
			orm
				.select('uses')
				.include('file', { join: 'inner' })
				.include('file_1', { join: 'inner' })
				.include('definition.file', { join: 'inner' })
				.dump().sql,
		);

		expect(sql).toMatch(/JOIN files AS file\b/);
		expect(sql).toMatch(/JOIN files AS file_1\b/);
		expect(sql).toMatch(/JOIN files AS file_2\b/);
		expect(sql).toContain('definition.file_id = file_2.id');
	});

	it('withSchema plus limit/offset keeps schema-qualified joins and path anchors', () => {
		const orm = buildOrm();
		const sql = compact(
			orm
				.withSchema('tenant_s')
				.select('uses')
				.include('definition', { join: 'inner' })
				.include('definition.file', { join: 'inner' })
				.include('file', { join: 'inner' })
				.columns([
					relationColumn('definition.file', 'path', 'def_file'),
					relationColumn('file', 'path', 'use_file'),
				])
				.limit(10)
				.offset(5)
				.dump().sql,
		);

		expect(sql).toBe(
			'SELECT file.path AS def_file, file_1.path AS use_file FROM tenant_s.uses JOIN tenant_s.definitions AS definition ON uses.def_id = definition.id JOIN tenant_s.files AS file ON definition.file_id = file.id JOIN tenant_s.files AS file_1 ON uses.file_id = file_1.id LIMIT 10 OFFSET 5',
		);
	});

	it('compiling the same query twice on one adapter instance is deterministic', () => {
		const adapter = createPgsqlCompileOnlyAdapter({
			model: issue154Schema.model,
		});
		const orm = createOrm({ model: issue154Schema.model, adapter });
		const buildQuery = () =>
			orm
				.select('uses')
				.include('definition.file', { join: 'inner' })
				.include('file', { join: 'inner' })
				.columns([
					relationColumn('definition.file', 'path', 'def_file'),
					relationColumn('file', 'path', 'use_file'),
				]);

		const first = buildQuery().dump().sql;
		const second = buildQuery().dump().sql;
		expect(second).toBe(first);
	});
});
