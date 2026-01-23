/**
 * PIM/DAM ModelIR
 *
 * Schema definition for semantic query planning.
 */

import { defineSchemaBuilder, hasMany, belongsTo } from '@dbsp/core';

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
export const pimdamModel = defineSchemaBuilder({
	categories: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'string' },
		parent_id: { type: 'integer' },
	},
	products: {
		id: { type: 'integer', primaryKey: true },
		sku: { type: 'string' },
		title: { type: 'string' },
		category_id: { type: 'integer' },
		active: { type: 'boolean' },
		deleted_at: { type: 'timestamp' },
	},
	assets: {
		id: { type: 'integer', primaryKey: true },
		kind: { type: 'string' },
		sha256: { type: 'string' },
		mime: { type: 'string' },
		width: { type: 'integer' },
		height: { type: 'integer' },
		size_bytes: { type: 'integer' },
		storage_key: { type: 'string' },
		expires_at: { type: 'timestamp' },
		created_at: { type: 'timestamp' },
	},
	product_images: {
		id: { type: 'integer', primaryKey: true },
		product_id: { type: 'integer' },
		asset_id: { type: 'integer' },
		locale: { type: 'string' },
		status: { type: 'string' },
		is_main: { type: 'boolean' },
		position: { type: 'integer' },
		deleted_at: { type: 'timestamp' },
	},
	variants: {
		id: { type: 'integer', primaryKey: true },
		product_id: { type: 'integer' },
		sku: { type: 'string' },
		name: { type: 'string' },
		price_cents: { type: 'integer' },
		stock: { type: 'integer' },
	},
})
	.relations({
		// Self-referential categories
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
		product_images: {
			product: belongsTo('products', { foreignKey: 'product_id' }),
			asset: belongsTo('assets', { foreignKey: 'asset_id' }),
		},
		assets: {
			productImages: hasMany('product_images', { foreignKey: 'asset_id' }),
		},
		variants: {
			product: belongsTo('products', { foreignKey: 'product_id' }),
		},
	})
	.build();
