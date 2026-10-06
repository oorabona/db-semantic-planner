import {
	createOrm,
	eq,
	exists,
	isNull,
	notExists,
	outerRef,
	rawExists,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const longName = 'r'.repeat(63);
const model = schema({
	roots: {
		id: { type: 'integer', primaryKey: true },
		targetId: ref('targets', { as: 'target' }),
		fileId: ref('files', { as: 'file' }),
	},
	targets: {
		id: { type: 'integer', primaryKey: true },
		fileId: ref('files', { as: 'callerFile' }),
		childId: ref('children', { as: 'child' }),
		longId: ref('files', { as: longName }),
	},
	children: {
		id: { type: 'integer', primaryKey: true },
		fileId: ref('files', { as: 'callerFile' }),
	},
	files: { id: { type: 'integer', primaryKey: true } },
	[longName]: {
		id: { type: 'integer', primaryKey: true },
		targetId: ref('targets', { as: 'target' }),
	},
}).model;
const orm = createOrm({
	model,
	adapter: createPgCompileOnlyAdapter({ model }),
});
for (const [title, predicate] of [
	['exists', exists],
	['notExists', notExists],
] as const) {
	it(`${title} binds a renamed include by its written qualifier`, () => {
		const sql = orm
			.select('roots')
			.join('file', { as: 'callerFile' })
			.where(
				predicate('target', {
					include: { callerFile: { join: 'left' } },
					where: isNull('callerFile.id'),
				}),
			)
			.dump().sql;
		expect(sql).toBe(
			'SELECT roots.* FROM roots JOIN files AS "callerFile" ON roots."fileId" = "callerFile".id WHERE ' +
				(title === 'exists'
					? 'EXISTS (SELECT 1 FROM targets AS targets_exists_1 LEFT JOIN files AS "callerFile_1" ON targets_exists_1."fileId" = "callerFile_1".id WHERE roots."targetId" = targets_exists_1.id AND "callerFile_1".id IS NULL)'
					: 'NOT (EXISTS (SELECT 1 FROM targets AS targets_exists_1 LEFT JOIN files AS "callerFile_1" ON targets_exists_1."fileId" = "callerFile_1".id WHERE roots."targetId" = targets_exists_1.id AND "callerFile_1".id IS NULL))'),
		);
	});
}
it('nested outerRef binds the nearest renamed include by its written qualifier', () => {
	const sql = orm
		.select('roots')
		.join('file', { as: 'callerFile' })
		.where(
			exists('target', {
				include: { callerFile: { join: 'left' } },
				where: rawExists(
					subquery('files')
						.where(eq('id', outerRef('callerFile.id')))
						.select('id'),
				),
			}),
		)
		.dump().sql;
	expect(sql).toBe(
		'SELECT roots.* FROM roots JOIN files AS "callerFile" ON roots."fileId" = "callerFile".id WHERE EXISTS (SELECT 1 FROM targets AS targets_exists_1 LEFT JOIN files AS "callerFile_1" ON targets_exists_1."fileId" = "callerFile_1".id WHERE roots."targetId" = targets_exists_1.id AND EXISTS (SELECT files_sq.id FROM files AS files_sq WHERE files_sq.id = "callerFile_1".id))',
	);
});
it('nested relation body binds a renamed include by its written qualifier', () => {
	const sql = orm
		.select('roots')
		.join('file', { as: 'callerFile' })
		.where(
			exists('target', {
				where: exists('child', {
					include: { callerFile: { join: 'left' } },
					where: isNull('callerFile.id'),
				}),
			}),
		)
		.dump().sql;
	expect(sql).toBe(
		'SELECT roots.* FROM roots JOIN files AS "callerFile" ON roots."fileId" = "callerFile".id WHERE EXISTS (SELECT 1 FROM targets AS targets_exists_1 WHERE roots."targetId" = targets_exists_1.id AND EXISTS (SELECT 1 FROM children AS children_exists_2 LEFT JOIN files AS "callerFile_1" ON children_exists_2."fileId" = "callerFile_1".id WHERE targets_exists_1."childId" = children_exists_2.id AND "callerFile_1".id IS NULL))',
	);
});
it('same-named include and 63-byte root use distinct aliases and preserve correlation', () => {
	const sql = orm
		.select(longName)
		.where(
			exists('target', {
				include: { [longName]: { join: 'left' } },
				where: isNull(`${longName}.id`),
			}),
		)
		.dump().sql;
	const includeAlias = `${'r'.repeat(61)}_1`;
	expect(sql).toBe(
		`SELECT ${longName}.* FROM ${longName} WHERE EXISTS (SELECT 1 FROM targets AS targets_exists_0 LEFT JOIN files AS ${includeAlias} ON targets_exists_0."longId" = ${includeAlias}.id WHERE ${longName}."targetId" = targets_exists_0.id AND ${includeAlias}.id IS NULL)`,
	);
	expect(includeAlias).not.toBe(longName);
	for (const alias of [longName, includeAlias])
		expect(new TextEncoder().encode(alias).length).toBeLessThanOrEqual(63);
});
