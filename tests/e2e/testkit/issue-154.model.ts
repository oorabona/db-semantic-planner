import { ref, schema } from '@dbsp/core';

export const issue154Schema = schema({
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
	dependencies: {
		id: { type: 'integer', primaryKey: true },
		target_id: 'integer',
	},
});

export const issue154Model = issue154Schema.model;
