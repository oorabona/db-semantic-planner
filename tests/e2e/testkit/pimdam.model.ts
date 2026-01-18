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
		name: { type: 'string' },
		parent_id: 'integer',
	},
	products: {
		id: 'integer',
		sku: { type: 'string' },
		title: { type: 'string' },
		category_id: 'integer',
		active: { type: 'boolean' },
		deleted_at: 'timestamp',
	},
	assets: {
		id: 'integer',
		kind: { type: 'string' },
		sha256: { type: 'string' },
		mime: { type: 'string' },
		width: 'integer',
		height: 'integer',
		size_bytes: 'integer',
		storage_key: { type: 'string' },
		expires_at: 'timestamp',
		created_at: 'timestamp',
	},
	product_images: {
		id: 'integer',
		product_id: 'integer',
		asset_id: 'integer',
		locale: { type: 'string' },
		status: { type: 'string' },
		is_main: { type: 'boolean' },
		position: 'integer',
		deleted_at: 'timestamp',
	},
	variants: {
		id: 'integer',
		product_id: 'integer',
		sku: { type: 'string' },
		name: { type: 'string' },
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
