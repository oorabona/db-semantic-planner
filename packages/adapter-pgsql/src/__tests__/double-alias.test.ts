/**
 * DOUBLE-ALIAS regression tests
 *
 * When two includes resolve to the same table with the same relation name
 * (e.g., include('def.file') + include('file')), both would previously generate
 * a JOIN alias of 'file', causing PostgreSQL error:
 *   "table name "file" specified more than once"
 *
 * The compiler must deduplicate aliases by suffixing with _N.
 */

import { createOrm, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

/**
 * Schema under test:
 *   uses         --file_id-->   files        (direct relation 'file')
 *   uses         --def_id--->   definitions
 *   definitions  --file_id-->   files        (nested: 'definition.file', alias also 'file')
 *   uses         --owner_id-->  owners
 *   owners       --file_id-->   files        (nested: 'owner.file', alias also 'file')
 */
const doubleAliasSchema = schema({
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
	},
});

function buildOrm() {
	const model = doubleAliasSchema.model;
	return createOrm({
		model,
		adapter: createPgCompileOnlyAdapter({ model }),
	});
}

describe('DOUBLE-ALIAS: duplicate join aliases are deduplicated', () => {
	it('include("def.file") + include("file") produces two JOINs with distinct aliases', () => {
		const { sql, params } = buildOrm()
			.select('uses')
			.include('definition.file', { join: 'inner' })
			.include('file', { join: 'inner' })
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT uses.*, definition.id AS "definition.id", definition.file_id AS "definition.file_id", definition.id AS __dbsp_presence_definition, file.id AS "definition.file.id", file.path AS "definition.file.path", file.id AS "__dbsp_presence_definition.file", file_1.id AS "file.id", file_1.path AS "file.path", file_1.id AS __dbsp_presence_file FROM uses JOIN definitions AS definition ON uses.def_id = definition.id JOIN files AS file ON definition.file_id = file.id JOIN files AS file_1 ON uses.file_id = file_1.id',
			params: [],
		});
	});

	it('three includes with same alias get incremental suffixes: file, file_1, file_2', () => {
		const { sql, params } = buildOrm()
			.select('uses')
			.include('definition.file', { join: 'inner' })
			.include('file', { join: 'inner' })
			.include('owner.file', { join: 'inner' })
			.dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT uses.*, definition.id AS "definition.id", definition.file_id AS "definition.file_id", definition.id AS __dbsp_presence_definition, file.id AS "definition.file.id", file.path AS "definition.file.path", file.id AS "__dbsp_presence_definition.file", file_1.id AS "file.id", file_1.path AS "file.path", file_1.id AS __dbsp_presence_file, owner.id AS "owner.id", owner.file_id AS "owner.file_id", owner.id AS __dbsp_presence_owner, file_2.id AS "owner.file.id", file_2.path AS "owner.file.path", file_2.id AS "__dbsp_presence_owner.file" FROM uses JOIN definitions AS definition ON uses.def_id = definition.id JOIN files AS file ON definition.file_id = file.id JOIN files AS file_1 ON uses.file_id = file_1.id JOIN owners AS owner ON uses.owner_id = owner.id JOIN files AS file_2 ON owner.file_id = file_2.id',
			params: [],
		});
	});
});
