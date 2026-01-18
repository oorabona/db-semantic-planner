/**
 * Extended PIM/DAM ModelIR for E2E-002 scenarios
 *
 * Adds support for:
 * - Q1: Completeness (families, family_attributes, product_attributes)
 * - Q2: Locale fallback (name_fr, name_en, name_default on products)
 * - Q3: Variants with locale-specific images (variant_images)
 * - Q6: Category tree (path column for materialized path)
 * - Q7: BOM/Bundles (bundle_components junction)
 * - Q8: Ambiguous relations (author/reviewer pattern)
 */

import { belongsTo, defineSchema, hasMany } from '@dbsp/core';

/**
 * Extended PIM/DAM schema model for E2E-002 tests.
 *
 * New tables:
 * - families: Product families with completeness requirements
 * - channels: Sales channels (web, print, mobile)
 * - family_attributes: Required attributes per family/channel
 * - product_attributes: Actual attribute values per product
 * - bundle_components: BOM junction table
 * - variant_images: Variant-specific images with locale
 * - users: For author/reviewer ambiguity tests
 */
export const pimdamExtendedModel = defineSchema({
	// Core tables (extended from base model)
	categories: {
		id: 'integer',
		name: { type: 'string' },
		parent_id: 'integer',
		path: { type: 'string' }, // Materialized path: /1/2/3/
	},
	products: {
		id: 'integer',
		sku: { type: 'string' },
		title: { type: 'string' },
		// Locale-specific names for COALESCE fallback
		name_fr: { type: 'string' },
		name_en: { type: 'string' },
		name_default: { type: 'string' },
		description_fr: { type: 'string' },
		description_en: { type: 'string' },
		category_id: 'integer',
		family_id: 'integer',
		active: { type: 'boolean' },
		is_bundle: { type: 'boolean' },
		deleted_at: 'timestamp',
		// Ambiguity test: multiple user references
		author_id: 'integer',
		reviewer_id: 'integer',
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
		role: { type: 'string' }, // For ambiguous relations: 'main', 'gallery', 'thumbnail'
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

	// New tables for E2E-002

	// Q1: Completeness - Families define required attributes
	families: {
		id: 'integer',
		name: { type: 'string' },
		code: { type: 'string' },
	},

	// Q1: Completeness - Channels for multi-channel requirements
	channels: {
		id: 'integer',
		name: { type: 'string' },
		code: { type: 'string' },
	},

	// Q1: Completeness - Which attributes are required per family/channel
	family_attributes: {
		id: 'integer',
		family_id: 'integer',
		channel_id: 'integer',
		attribute_name: { type: 'string' },
		is_required: { type: 'boolean' },
	},

	// Q1: Completeness - Actual attribute values per product
	product_attributes: {
		id: 'integer',
		product_id: 'integer',
		attribute_name: { type: 'string' },
		value: { type: 'string' },
		locale: { type: 'string' },
	},

	// Q7: BOM/Bundles - Components junction
	bundle_components: {
		id: 'integer',
		bundle_id: 'integer',
		component_id: 'integer',
		quantity: 'integer',
		position: 'integer',
	},

	// Q3: Variant-specific images with locale
	variant_images: {
		id: 'integer',
		variant_id: 'integer',
		asset_id: 'integer',
		locale: { type: 'string' },
		is_main: { type: 'boolean' },
		position: 'integer',
	},

	// Q8: Users for author/reviewer ambiguity
	users: {
		id: 'integer',
		name: { type: 'string' },
		email: { type: 'string' },
		role: { type: 'string' },
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
			family: belongsTo('families', { foreignKey: 'family_id' }),
			images: hasMany('product_images', { foreignKey: 'product_id' }),
			variants: hasMany('variants', { foreignKey: 'product_id' }),
			attributes: hasMany('product_attributes', { foreignKey: 'product_id' }),
			// BOM relations
			components: hasMany('bundle_components', { foreignKey: 'bundle_id' }),
			bundles: hasMany('bundle_components', { foreignKey: 'component_id' }),
			// Ambiguous user relations (Q8)
			author: belongsTo('users', { foreignKey: 'author_id' }),
			reviewer: belongsTo('users', { foreignKey: 'reviewer_id' }),
		},
		assets: {
			productImages: hasMany('product_images', { foreignKey: 'asset_id' }),
			variantImages: hasMany('variant_images', { foreignKey: 'asset_id' }),
		},
		product_images: {
			product: belongsTo('products', { foreignKey: 'product_id' }),
			asset: belongsTo('assets', { foreignKey: 'asset_id' }),
		},
		variants: {
			product: belongsTo('products', { foreignKey: 'product_id' }),
			images: hasMany('variant_images', { foreignKey: 'variant_id' }),
		},
		families: {
			products: hasMany('products', { foreignKey: 'family_id' }),
			attributes: hasMany('family_attributes', { foreignKey: 'family_id' }),
		},
		channels: {
			familyAttributes: hasMany('family_attributes', {
				foreignKey: 'channel_id',
			}),
		},
		family_attributes: {
			family: belongsTo('families', { foreignKey: 'family_id' }),
			channel: belongsTo('channels', { foreignKey: 'channel_id' }),
		},
		product_attributes: {
			product: belongsTo('products', { foreignKey: 'product_id' }),
		},
		bundle_components: {
			bundle: belongsTo('products', { foreignKey: 'bundle_id' }),
			component: belongsTo('products', { foreignKey: 'component_id' }),
		},
		variant_images: {
			variant: belongsTo('variants', { foreignKey: 'variant_id' }),
			asset: belongsTo('assets', { foreignKey: 'asset_id' }),
		},
		users: {
			authoredProducts: hasMany('products', { foreignKey: 'author_id' }),
			reviewedProducts: hasMany('products', { foreignKey: 'reviewer_id' }),
		},
	})
	.build();
