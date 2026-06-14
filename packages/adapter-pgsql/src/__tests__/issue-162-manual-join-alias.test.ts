import {
	createOrm,
	eq,
	exprRef,
	fn,
	ref,
	relationColumn,
	schema,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const issue162Schema = schema({
	files: {
		id: { type: 'integer', primaryKey: true },
		path: 'string',
	},
	definitions: {
		id: { type: 'integer', primaryKey: true },
		file_id: ref('files', { as: 'file', inverse: 'definitions' }),
	},
	uses: {
		id: { type: 'integer', primaryKey: true },
		def_id: ref('definitions', { as: 'definition', inverse: 'uses' }),
		file_id: ref('files', { as: 'file', inverse: 'uses' }),
		file_one_id: ref('files', { as: 'file_one', inverse: 'file_one_uses' }),
		alt_file_id: ref('files', { as: 'file_1', inverse: 'alt_uses' }),
	},
});

function buildOrm(dbCasing?: 'snake_case' | 'camelCase' | 'preserve') {
	const adapter = createPgsqlCompileOnlyAdapter({
		model: issue162Schema.model,
		...(dbCasing ? { dbCasing } : {}),
	});
	return createOrm({ model: issue162Schema.model, adapter });
}

function compact(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

function occurrenceCount(sql: string, pattern: RegExp): number {
	return sql.match(pattern)?.length ?? 0;
}

describe('FIX-162: manual join aliases reserve include-generated aliases', () => {
	it('manual explicit .join() alias wins and include-generated alias skips to the next suffix', () => {
		const orm = buildOrm();
		const sql = compact(
			orm
				.select('uses')
				.join('definitions', {
					as: 'file_1',
					on: eq('uses.def_id', exprRef('file_1.id')),
				})
				.include('definition.file', { join: 'inner' })
				.include('file', { join: 'inner' })
				.columns([
					relationColumn('definition.file', 'path', 'def_file'),
					relationColumn('file', 'path', 'use_file'),
				])
				.dump().sql,
		);

		expect(occurrenceCount(sql, /\bJOIN\b/g)).toBe(4);
		expect(sql).toMatch(/JOIN definitions AS file_1\b/);
		expect(sql).toMatch(/JOIN files AS file\b/);
		expect(sql).toMatch(/JOIN files AS file_2\b/);
		expect(sql).not.toContain('uses.file_id = file_1.id');
		expect(sql).toContain('uses.file_id = file_2.id');
		expect(sql).toContain('file.path AS def_file');
		expect(sql).toContain('file_2.path AS use_file');
	});

	it('reserves manual aliases in emitted DB-cased alias space', () => {
		const orm = buildOrm('snake_case');
		const sql = compact(
			orm
				.select('uses')
				.join('definitions', {
					as: 'fileOne',
					on: eq('uses.def_id', exprRef('fileOne.id')),
				})
				.include('file_one', { join: 'inner' })
				.columns([relationColumn('file_one', 'path', 'file_one_path')])
				.dump().sql,
		);

		expect(occurrenceCount(sql, /\bAS file_one\b/g)).toBe(1);
		expect(sql).toMatch(/JOIN definitions AS file_one\b/);
		expect(sql).toMatch(/JOIN files AS file_one_1\b/);
		expect(sql).toContain('uses.file_one_id = file_one_1.id');
		expect(sql).toContain('file_one_1.path AS file_one_path');
	});

	it('uses the final bumped include alias in relationColumn ORDER BY expressions', () => {
		const orm = buildOrm();
		const sql = compact(
			orm
				.select('uses')
				.join('definitions', {
					as: 'file',
					on: eq('uses.def_id', exprRef('file.id')),
				})
				.include('file', { join: 'inner' })
				.orderBy(relationColumn('file', 'path', 'path'), 'asc')
				.dump().sql,
		);

		expect(sql).toMatch(/JOIN definitions AS file\b/);
		expect(sql).toMatch(/JOIN files AS file_1\b/);
		expect(sql).toContain('uses.file_id = file_1.id');
		expect(sql).toMatch(/ORDER BY file_1\.path ASC\b/);
		expect(sql).not.toMatch(/ORDER BY file\.path ASC\b/);
	});

	it('uses the final bumped include alias in SELECT custom expressions', () => {
		const orm = buildOrm();
		const sql = compact(
			orm
				.select('uses')
				.join('definitions', {
					as: 'file',
					on: eq('uses.def_id', exprRef('file.id')),
				})
				.include('file', { join: 'inner' })
				.columns([
					fn('upper', relationColumn('file', 'path', 'file_path')).as(
						'upper_path',
					),
				])
				.dump().sql,
		);

		expect(sql).toMatch(/JOIN definitions AS file\b/);
		expect(sql).toMatch(/JOIN files AS file_1\b/);
		expect(sql).toContain('uses.file_id = file_1.id');
		expect(sql).toMatch(/upper\(file_1\.path\) AS upper_path\b/);
		expect(sql).not.toMatch(/upper\(file\.path\) AS upper_path\b/);
	});

	it('uses the final bumped include alias in GROUP BY relation references', () => {
		const orm = buildOrm();
		const sql = compact(
			orm
				.select('uses')
				.join('definitions', {
					as: 'file',
					on: eq('uses.def_id', exprRef('file.id')),
				})
				.include('file', { join: 'inner' })
				.groupBy(['id', 'file.path'])
				.columns(['id'])
				.dump().sql,
		);

		expect(sql).toMatch(/JOIN definitions AS file\b/);
		expect(sql).toMatch(/JOIN files AS file_1\b/);
		expect(sql).toContain('uses.file_id = file_1.id');
		expect(sql).toMatch(/GROUP BY uses\.id, file_1\.path\b/);
		expect(sql).not.toMatch(/GROUP BY uses\.id, file\.path\b/);
	});

	it('uses the final bumped include alias in DISTINCT ON relation references', () => {
		const orm = buildOrm();
		const sql = compact(
			orm
				.select('uses')
				.join('definitions', {
					as: 'file',
					on: eq('uses.def_id', exprRef('file.id')),
				})
				.include('file', { join: 'inner' })
				.distinctOn('file.path')
				.columns(['id'])
				.dump().sql,
		);

		expect(sql).toMatch(/JOIN definitions AS file\b/);
		expect(sql).toMatch(/JOIN files AS file_1\b/);
		expect(sql).toContain('uses.file_id = file_1.id');
		expect(sql).toMatch(/SELECT DISTINCT ON \(file_1\.path\)/);
		expect(sql).not.toMatch(/SELECT DISTINCT ON \(file\.path\)/);
	});

	it('uses the final bumped include alias in HAVING relationColumn expressions', () => {
		const orm = buildOrm();
		const sql = compact(
			orm
				.select('uses')
				.join('definitions', {
					as: 'file',
					on: eq('uses.def_id', exprRef('file.id')),
				})
				.include('file', { join: 'inner' })
				.groupBy(['id', 'file.path'])
				.columns(['id'])
				.having(fn('length', relationColumn('file', 'path', 'file_path')).gt(3))
				.dump().sql,
		);

		expect(sql).toMatch(/JOIN definitions AS file\b/);
		expect(sql).toMatch(/JOIN files AS file_1\b/);
		expect(sql).toContain('uses.file_id = file_1.id');
		expect(sql).toMatch(/HAVING length\(file_1\.path\) > \$1\b/);
		expect(sql).not.toMatch(/HAVING length\(file\.path\) > \$1\b/);
	});

	it('duplicate manual .join() aliases are preserved as user-authored SQL aliases', () => {
		const orm = buildOrm();
		const sql = compact(
			orm
				.select('uses')
				.join('files', {
					as: 'dup',
					on: eq('uses.file_id', exprRef('dup.id')),
				})
				.join('files', {
					as: 'dup',
					on: eq('uses.alt_file_id', exprRef('dup.id')),
				})
				.dump().sql,
		);

		expect(occurrenceCount(sql, /JOIN files AS dup\b/g)).toBe(2);
	});
});
