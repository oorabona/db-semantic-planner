/**
 * @module compiler-inner-join.test
 * Tests for INNER JOIN compilation via include(join: 'inner').
 *
 * With `join: 'inner'` the compiler produces JOIN (SQL INNER JOIN, no LEFT keyword)
 * instead of LEFT JOIN.
 *
 * Note: The pgsql deparser renders JOIN_INNER as plain "JOIN" (not "INNER JOIN"),
 * which is semantically equivalent.
 */

import { createOrm, eq, exprRef, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	symbols: {
		id: { type: 'integer', primaryKey: true },
		file_id: ref('files', { as: 'file', inverse: 'symbols' }),
		project_id: ref('projects', { as: 'project', inverse: 'symbols' }),
		author_id: ref('users', { as: 'author', inverse: 'symbols' }),
	},
	files: {
		id: { type: 'integer', primaryKey: true },
		path: { type: 'text' },
	},
	projects: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	definitions: {
		id: { type: 'integer', primaryKey: true },
	},
} as const);
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

describe('INNER JOIN include compilation', () => {
	describe('join: "inner" — produces INNER JOIN', () => {
		it('two inner JOINs to different tables', () => {
			const { sql, params } = orm
				.select('symbols')
				.include('file', {
					join: 'inner',
					select: { type: 'fields', fields: ['path'] },
				})
				.include('project', {
					join: 'inner',
					select: { type: 'fields', fields: ['name'] },
				})
				.dump();

			expect({ sql, params }).toEqual({
				sql: 'SELECT symbols.*, file.path AS "file.path", file.id AS __dbsp_presence_file, project.name AS "project.name", project.id AS __dbsp_presence_project FROM symbols JOIN files AS file ON symbols.file_id = file.id JOIN projects AS project ON symbols.project_id = project.id',
				params: [],
			});
		});

		it('mixed inner JOIN and LEFT JOIN includes', () => {
			const { sql, params } = orm
				.select('symbols')
				.include('file', {
					join: 'inner',
					select: { type: 'fields', fields: ['path'] },
				})
				.include('author', {
					join: 'left',
					select: { type: 'fields', fields: ['name'] },
				})
				.dump();

			expect({ sql, params }).toEqual({
				sql: 'SELECT symbols.*, file.path AS "file.path", file.id AS __dbsp_presence_file, author.name AS "author.name", author.id AS __dbsp_presence_author FROM symbols JOIN files AS file ON symbols.file_id = file.id LEFT JOIN users AS author ON symbols.author_id = author.id',
				params: [],
			});
		});
	});
});

describe('join decision authority', () => {
	it('reserves manual aliases beside join includes', () => {
		const { sql, params } = orm
			.select('symbols')
			.join('definitions', {
				on: eq('id', exprRef('definitions.id')),
				as: 'file',
			})
			.include('file', { join: 'inner' })
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT symbols.*, file_1.id AS "file.id", file_1.path AS "file.path", file_1.id AS __dbsp_presence_file FROM symbols JOIN definitions AS file ON symbols.id = file.id JOIN files AS file_1 ON symbols.file_id = file_1.id',
			params: [],
		});
	});
});
