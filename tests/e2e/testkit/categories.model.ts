import { ref, schema } from '@dbsp/core';

export const categoriesSchema = schema({
	categories: {
		id: { type: 'integer', primaryKey: true, dbType: 'integer' },
		name: 'string',
		parentId: ref('categories', {
			nullable: true,
			roles: {
				parent: 'parent',
				children: 'children',
				ancestors: 'ascendant',
				descendants: 'descendant',
			},
		}),
	},
});

export const categoriesModel = categoriesSchema.model;
