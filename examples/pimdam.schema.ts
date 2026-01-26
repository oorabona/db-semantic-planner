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

import { ref, schema } from '@dbsp/core';

export default schema({
	/**
	 * Categories - hierarchical product taxonomy
	 * Self-referential for unlimited nesting (Electronics > Phones > Smartphones)
	 */
	categories: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: 'string',
		slug: { type: 'string', index: true },
		description: { type: 'text', nullable: true },
		parentId: ref('categories', {
			nullable: true,
			onDelete: 'SET NULL',
			roles: { parent: 'parent', children: 'children' },
		}),
		position: { type: 'integer', default: '0' },
		active: { type: 'boolean', default: 'true', index: true },
		createdAt: { type: 'timestamp', default: 'now()' },
	},

	/**
	 * Products - main product catalog
	 * Supports soft deletes via deletedAt
	 */
	products: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		sku: { type: 'string', unique: true },
		title: 'string',
		description: { type: 'text', nullable: true },
		categoryId: ref('categories'),
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
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		kind: { type: 'string', index: true }, // 'image', 'video', 'document'
		filename: 'string',
		sha256: { type: 'string', index: true },
		mime: 'string',
		width: { type: 'integer', nullable: true },
		height: { type: 'integer', nullable: true },
		sizeBytes: 'integer',
		storageKey: 'string',
		altText: { type: 'string', nullable: true },
		expiresAt: { type: 'timestamp', nullable: true },
		createdAt: { type: 'timestamp', default: 'now()' },
	},

	/**
	 * Product Images - junction table with localization and workflow
	 * Links products to assets with locale-specific approval status
	 */
	productImages: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		productId: ref('products', { onDelete: 'CASCADE' }),
		assetId: ref('assets'),
		locale: { type: 'string', index: true }, // 'en', 'fr', 'de', etc.
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
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		productId: ref('products', { onDelete: 'CASCADE' }),
		sku: { type: 'string', unique: true },
		name: 'string',
		priceCents: 'integer',
		compareAtPriceCents: { type: 'integer', nullable: true },
		costCents: { type: 'integer', nullable: true },
		stock: { type: 'integer', default: '0' },
		weightGrams: { type: 'integer', nullable: true },
		barcode: { type: 'string', nullable: true },
		active: { type: 'boolean', default: 'true' },
		createdAt: { type: 'timestamp', default: 'now()' },
	},
});
// Relations auto-inferred from ref():
// - categories.parent, categories.children (self-ref)
// - products.category, categories.categoryId_products
// - products.productId_variants, variants.product
// - productImages.product, productImages.asset
// - products.productId_productImages, assets.assetId_productImages
