import { ref, schema } from '@dbsp/core';

export const issue154Schema = schema({
	files: {
		id: { type: 'integer', primaryKey: true },
		path: 'string',
	},
	definitions: {
		id: { type: 'integer', primaryKey: true },
		fileId: ref('files', { as: 'file', inverse: 'definitions' }),
	},
	uses: {
		id: { type: 'integer', primaryKey: true },
		defId: ref('definitions', { as: 'definition', inverse: 'uses' }),
		fileId: ref('files', { as: 'file', inverse: 'uses' }),
		altFileId: ref('files', { as: 'file_1', inverse: 'alt_uses' }),
	},
	dependencies: {
		id: { type: 'integer', primaryKey: true },
		targetId: 'integer',
	},
});

export const issue154Model = issue154Schema.model;
