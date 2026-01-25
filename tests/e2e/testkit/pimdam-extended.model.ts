/**
 * Extended PIM/DAM ModelIR for E2E-002 scenarios
 *
 * Adds support for:
 * - Q1: Completeness (families, familyAttributes, productAttributes)
 * - Q2: Locale fallback (nameFr, nameEn, nameDefault on products)
 * - Q3: Variants with locale-specific images (variantImages)
 * - Q6: Category tree (path column for materialized path)
 * - Q7: BOM/Bundles (bundleComponents junction)
 * - Q8: Ambiguous relations (author/reviewer pattern)
 *
 * Uses schema() + fk() API with auto-inferred relations.
 */

import { fk, schema } from '@dbsp/core';

/**
 * Extended PIM/DAM schema for E2E-002 tests.
 *
 * New tables:
 * - families: Product families with completeness requirements
 * - channels: Sales channels (web, print, mobile)
 * - familyAttributes: Required attributes per family/channel
 * - productAttributes: Actual attribute values per product
 * - bundleComponents: BOM junction table
 * - variantImages: Variant-specific images with locale
 * - users: For author/reviewer ambiguity tests
 */
const pimdamExtendedSchema = schema({
	// Core tables (extended from base model)
	categories: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		path: { type: 'string', nullable: true }, // Materialized path: /1/2/3/
		// Self-ref with parent/children
		parentId: fk('categories', {
			nullable: true,
			roles: { parent: 'parent', children: 'children' },
		}),
	},

	// Q8: Users for author/reviewer ambiguity - define BEFORE products
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		role: { type: 'string', nullable: true },
	},

	// Q1: Completeness - Families define required attributes
	families: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		code: 'string',
	},

	products: {
		id: { type: 'integer', primaryKey: true },
		sku: 'string',
		title: 'string',
		// Locale-specific names for COALESCE fallback
		nameFr: { type: 'string', nullable: true },
		nameEn: { type: 'string', nullable: true },
		nameDefault: { type: 'string', nullable: true },
		descriptionFr: { type: 'string', nullable: true },
		descriptionEn: { type: 'string', nullable: true },
		categoryId: fk('categories'),
		familyId: fk('families', { nullable: true }),
		active: 'boolean',
		isBundle: { type: 'boolean', default: 'false' },
		deletedAt: { type: 'timestamp', nullable: true },
		// Ambiguity test: multiple user references with explicit naming
		authorId: fk('users', { as: 'author', inverse: 'authoredProducts' }),
		reviewerId: fk('users', { nullable: true, as: 'reviewer', inverse: 'reviewedProducts' }),
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
		productId: fk('products'),
		assetId: fk('assets'),
		locale: 'string',
		status: 'string',
		isMain: 'boolean',
		role: { type: 'string', nullable: true }, // For ambiguous relations: 'main', 'gallery', 'thumbnail'
		position: 'integer',
		deletedAt: { type: 'timestamp', nullable: true },
	},

	variants: {
		id: { type: 'integer', primaryKey: true },
		productId: fk('products'),
		sku: 'string',
		name: 'string',
		priceCents: 'integer',
		stock: 'integer',
	},

	// Q1: Completeness - Channels for multi-channel requirements
	channels: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		code: 'string',
	},

	// Q1: Completeness - Which attributes are required per family/channel
	familyAttributes: {
		id: { type: 'integer', primaryKey: true },
		familyId: fk('families'),
		channelId: fk('channels'),
		attributeName: 'string',
		isRequired: 'boolean',
	},

	// Q1: Completeness - Actual attribute values per product
	productAttributes: {
		id: { type: 'integer', primaryKey: true },
		productId: fk('products'),
		attributeName: 'string',
		value: { type: 'string', nullable: true },
		locale: { type: 'string', nullable: true },
	},

	// Q7: BOM/Bundles - Components junction (multiple FKs to products)
	bundleComponents: {
		id: { type: 'integer', primaryKey: true },
		bundleId: fk('products', { as: 'bundle', inverse: 'components' }),
		componentId: fk('products', { as: 'component', inverse: 'bundles' }),
		quantity: 'integer',
		position: 'integer',
	},

	// Q3: Variant-specific images with locale
	variantImages: {
		id: { type: 'integer', primaryKey: true },
		variantId: fk('variants'),
		assetId: fk('assets'),
		locale: 'string',
		isMain: 'boolean',
		position: 'integer',
	},
});

export const pimdamExtendedModel = pimdamExtendedSchema.model;
