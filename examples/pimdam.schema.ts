/**
 * PIM/DAM Schema Example
 *
 * Product Information Management / Digital Asset Management schema.
 * A realistic use case for e-commerce, media libraries, and content management.
 *
 * Features demonstrated:
 * - Self-referential hierarchy (categories)
 * - Many-to-many via junction table (product_images)
 * - Soft deletes (deleted_at)
 * - Localization (locale on product_images)
 * - Status workflow (approved/pending/rejected)
 *
 * Usage:
 *   pnpm dbsp repl --schema ./examples/pimdam.schema.ts
 *   pnpm dbsp generate ddl --schema ./examples/pimdam.schema.ts
 */

import { defineSchema } from '@dbsp/core';

export default defineSchema(
	{
		/**
		 * Categories - hierarchical product taxonomy
		 * Self-referential for unlimited nesting (Electronics > Phones > Smartphones)
		 */
		categories: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'string', nullable: false },
			slug: { type: 'string', nullable: false, index: true },
			description: { type: 'text', nullable: true },
			parentId: { type: 'integer', nullable: true, references: { table: 'categories', onDelete: 'SET NULL' }, index: true },
			position: { type: 'integer', default: '0' },
			active: { type: 'boolean', default: 'true', index: true },
			createdAt: { type: 'timestamp', default: 'now()' },
		},

		/**
		 * Products - main product catalog
		 * Supports soft deletes via deletedAt
		 */
		products: {
			id: { type: 'integer', primaryKey: true },
			sku: { type: 'string', nullable: false, unique: true },
			title: { type: 'string', nullable: false },
			description: { type: 'text', nullable: true },
			categoryId: { type: 'integer', references: { table: 'categories' }, index: true },
			brand: { type: 'string', nullable: true },
			active: { type: 'boolean', default: 'true', index: true },
			createdAt: { type: 'timestamp', default: 'now()' },
			updatedAt: { type: 'timestamp', nullable: true },
			deletedAt: { type: 'timestamp', nullable: true },
		},

		/**
		 * Assets - Digital Asset Management
		 * Images, videos, PDFs stored with metadata
		 */
		assets: {
			id: { type: 'integer', primaryKey: true },
			kind: { type: 'string', nullable: false, index: true }, // 'image', 'video', 'document'
			filename: { type: 'string', nullable: false },
			sha256: { type: 'string', nullable: false, index: true },
			mime: { type: 'string', nullable: false },
			width: { type: 'integer', nullable: true },
			height: { type: 'integer', nullable: true },
			sizeBytes: { type: 'integer', nullable: false },
			storageKey: { type: 'string', nullable: false },
			altText: { type: 'string', nullable: true },
			expiresAt: { type: 'timestamp', nullable: true },
			createdAt: { type: 'timestamp', default: 'now()' },
		},

		/**
		 * Product Images - junction table with localization and workflow
		 * Links products to assets with locale-specific approval status
		 */
		productImages: {
			id: { type: 'integer', primaryKey: true },
			productId: { type: 'integer', references: { table: 'products', onDelete: 'CASCADE' }, index: true },
			assetId: { type: 'integer', references: { table: 'assets' } },
			locale: { type: 'string', nullable: false, index: true }, // 'en', 'fr', 'de', etc.
			status: { type: 'string', default: "'pending'", index: true }, // 'pending', 'approved', 'rejected'
			isMain: { type: 'boolean', default: 'false' },
			position: { type: 'integer', default: '0' },
			rejectedReason: { type: 'string', nullable: true },
			approvedBy: { type: 'string', nullable: true },
			approvedAt: { type: 'timestamp', nullable: true },
			createdAt: { type: 'timestamp', default: 'now()' },
			deletedAt: { type: 'timestamp', nullable: true },
		},

		/**
		 * Variants - product SKU variations
		 * Size, color, material combinations with pricing and inventory
		 */
		variants: {
			id: { type: 'integer', primaryKey: true },
			productId: { type: 'integer', references: { table: 'products', onDelete: 'CASCADE' }, index: true },
			sku: { type: 'string', nullable: false, unique: true },
			name: { type: 'string', nullable: false },
			priceCents: { type: 'integer', nullable: false },
			compareAtPriceCents: { type: 'integer', nullable: true },
			costCents: { type: 'integer', nullable: true },
			stock: { type: 'integer', default: '0' },
			weightGrams: { type: 'integer', nullable: true },
			barcode: { type: 'string', nullable: true },
			active: { type: 'boolean', default: 'true' },
			createdAt: { type: 'timestamp', default: 'now()' },
		},
	},
	{
		relations: {
			// Self-referencing for category hierarchy
			'categories.parent': {
				kind: 'belongsTo',
				target: 'categories',
				foreignKey: 'parentId',
			},
			'categories.children': {
				kind: 'hasMany',
				target: 'categories',
				foreignKey: 'parentId',
			},
		},
	},
);
// Other relations auto-inferred:
// - products.category, categories.products
// - products.variants, variants.product
// - products.images, productImages.product
// - assets.productImages, productImages.asset
