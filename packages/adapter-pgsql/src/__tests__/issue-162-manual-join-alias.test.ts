import {
	createOrm,
	eq,
	exprRef,
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
		alt_file_id: ref('files', { as: 'file_1', inverse: 'alt_uses' }),
	},
});

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({
		model: issue162Schema.model,
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
