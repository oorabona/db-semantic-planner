/**
 * PIM/DAM ModelIR
 *
 * Schema definition for semantic query planning.
 */

import { belongsTo, defineSchema, hasMany } from '@dbsp/core';

/**
 * PIM/DAM schema model for E2E tests.
 *
 * Includes:
 * - categories (self-referential hierarchy)
 * - products
 * - assets (DAM)
 * - product_images
 * - variants
 */
export const pimdamModel = defineSchema({
	categories: {
		id: 'integer',
		name: 'string',
		parent_id: 'integer',
	},
	products: {
		id: 'integer',
		sku: 'string',
		title: 'string',
		category_id: 'integer',
		active: 'boolean',
		deleted_at: 'timestamp',
	},
	assets: {
		id: 'integer',
		kind: 'string',
		sha256: 'string',
		mime: 'string',
		width: 'integer',
		height: 'integer',
		size_bytes: 'integer',
		storage_key: 'string',
		expires_at: 'timestamp',
		created_at: 'timestamp',
	},
	product_images: {
		id: 'integer',
		product_id: 'integer',
		asset_id: 'integer',
		locale: 'string',
		status: 'string',
		is_main: 'boolean',
		position: 'integer',
		deleted_at: 'timestamp',
	},
	variants: {
		id: 'integer',
		product_id: 'integer',
		sku: 'string',
		name: 'string',
		price_cents: 'integer',
		stock: 'integer',
	},
})
	.relations({
		categories: {
			parent: belongsTo('categories', { foreignKey: 'parent_id' }),
			children: hasMany('categories', { foreignKey: 'parent_id' }),
			products: hasMany('products', { foreignKey: 'category_id' }),
		},
		products: {
			category: belongsTo('categories', { foreignKey: 'category_id' }),
			images: hasMany('product_images', { foreignKey: 'product_id' }),
			variants: hasMany('variants', { foreignKey: 'product_id' }),
		},
		assets: {
			productImages: hasMany('product_images', { foreignKey: 'asset_id' }),
		},
		product_images: {
			product: belongsTo('products', { foreignKey: 'product_id' }),
			asset: belongsTo('assets', { foreignKey: 'asset_id' }),
		},
		variants: {
			product: belongsTo('products', { foreignKey: 'product_id' }),
		},
	})
	.build();
