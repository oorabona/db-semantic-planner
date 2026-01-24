/**
 * PIM/DAM ModelIR
 *
 * Schema definition for semantic query planning.
 */

import { buildModelFromResolvedSchema, defineSchema } from '@dbsp/core';

/**
 * PIM/DAM schema for E2E tests.
 *
 * Includes:
 * - categories (self-referential hierarchy)
 * - products
 * - assets (DAM)
 * - product_images
 * - variants
 */
const pimdamSchema = defineSchema(
	{
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
	},
	{
		relations: {
			// Self-referential categories
			'categories.parent': {
				kind: 'belongsTo',
				target: 'categories',
				foreignKey: 'parent_id',
			},
			'categories.children': {
				kind: 'hasMany',
				target: 'categories',
				foreignKey: 'parent_id',
			},
			'categories.products': {
				kind: 'hasMany',
				target: 'products',
				foreignKey: 'category_id',
			},
			'products.category': {
				kind: 'belongsTo',
				target: 'categories',
				foreignKey: 'category_id',
			},
			'products.images': {
				kind: 'hasMany',
				target: 'product_images',
				foreignKey: 'product_id',
			},
			'products.variants': {
				kind: 'hasMany',
				target: 'variants',
				foreignKey: 'product_id',
			},
			'product_images.product': {
				kind: 'belongsTo',
				target: 'products',
				foreignKey: 'product_id',
			},
			'product_images.asset': {
				kind: 'belongsTo',
				target: 'assets',
				foreignKey: 'asset_id',
			},
			'assets.productImages': {
				kind: 'hasMany',
				target: 'product_images',
				foreignKey: 'asset_id',
			},
			'variants.product': {
				kind: 'belongsTo',
				target: 'products',
				foreignKey: 'product_id',
			},
		},
	},
);

export const pimdamModel = buildModelFromResolvedSchema(pimdamSchema);
