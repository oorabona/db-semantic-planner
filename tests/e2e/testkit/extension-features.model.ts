import { schema } from '@dbsp/core';

export const extensionFeaturesSchema = schema({
	vectors: {
		id: { type: 'integer', primaryKey: true, dbType: 'integer' },
		label: 'text',
		embedding: { type: 'text', dbType: 'vector(3)' },
	},
	documents: {
		id: { type: 'integer', primaryKey: true, dbType: 'integer' },
		title: 'text',
		body: 'text',
		category: 'text',
	},
});

export const extensionFeaturesModel = extensionFeaturesSchema.model;
