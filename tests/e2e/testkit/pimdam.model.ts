/**
 * PIM/DAM ModelIR
 *
 * Schema definition for semantic query planning.
 * Uses schema() + ref() API with auto-inferred relations.
 */

import { ref, schema } from '@dbsp/core';

/**
 * PIM/DAM schema for E2E tests.
 *
 * Includes:
 * - categories (self-referential hierarchy)
 * - products
 * - assets (DAM)
 * - productImages
 * - variants
 */
const pimdamSchema = schema({
	categories: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		// Self-ref with parent/children
		parentId: ref('categories', {
			nullable: true,
			roles: { parent: 'parent', children: 'children' },
		}),
	},
	products: {
		id: { type: 'integer', primaryKey: true },
		sku: 'string',
		title: 'string',
		categoryId: ref('categories'),
		active: 'boolean',
		deletedAt: { type: 'timestamp', nullable: true },
	},
	assets: {
		id: { type: 'integer', primaryKey: true },
		kind: 'string',
		sha256: 'string',
		mime: 'string',
		width: { type: 'integer', nullable: true },
		height: { type: 'integer', nullable: true },
		sizeBytes: 'integer',
		storageKey: 'string',
		expiresAt: { type: 'timestamp', nullable: true },
		createdAt: 'timestamp',
	},
	productImages: {
		id: { type: 'integer', primaryKey: true },
		productId: ref('products'),
		assetId: ref('assets'),
		locale: 'string',
		status: 'string',
		isMain: 'boolean',
		position: 'integer',
		deletedAt: { type: 'timestamp', nullable: true },
	},
	variants: {
		id: { type: 'integer', primaryKey: true },
		productId: ref('products'),
		sku: 'string',
		name: 'string',
		priceCents: 'integer',
		stock: 'integer',
	},
});

export const pimdamModel = pimdamSchema.model;
