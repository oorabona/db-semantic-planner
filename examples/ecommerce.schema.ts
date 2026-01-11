/**
 * Example: E-Commerce Schema
 *
 * Online store with products, categories, orders, and customers.
 * Demonstrates: hierarchical relations, M:N, complex FKs.
 *
 * Usage:
 *   pnpm dbsp repl --schema ./examples/ecommerce.schema.ts
 *   pnpm dbsp generate kysely --schema ./examples/ecommerce.schema.ts
 */

import { defineSchema } from '@db-semantic-planner/schema';

export default defineSchema({
	tables: {
		// Hierarchical categories (self-referencing)
		categories: {
			id: { type: 'integer', primaryKey: true },
			name: { type: 'string', nullable: false },
			slug: { type: 'string', nullable: false, unique: true },
			parentId: { type: 'integer', nullable: true, references: { table: 'categories' } },
			sortOrder: { type: 'integer', default: '0' },
		},

		// Products belong to categories
		products: {
			id: { type: 'integer', primaryKey: true },
			sku: { type: 'string', nullable: false, unique: true },
			name: { type: 'string', nullable: false },
			description: { type: 'text', nullable: true },
			price: { type: 'decimal', nullable: false },
			stock: { type: 'integer', default: '0' },
			categoryId: { type: 'integer', references: { table: 'categories' } },
			active: { type: 'boolean', default: 'true' },
			createdAt: { type: 'timestamp', default: 'now()' },
		},

		// Product variants (size, color, etc.)
		variants: {
			id: { type: 'integer', primaryKey: true },
			productId: { type: 'integer', references: { table: 'products' } },
			sku: { type: 'string', nullable: false, unique: true },
			name: { type: 'string', nullable: false },
			priceModifier: { type: 'decimal', default: '0' },
			stock: { type: 'integer', default: '0' },
		},

		// Customers
		customers: {
			id: { type: 'integer', primaryKey: true },
			email: { type: 'string', nullable: false, unique: true },
			firstName: { type: 'string', nullable: false },
			lastName: { type: 'string', nullable: false },
			phone: { type: 'string', nullable: true },
			createdAt: { type: 'timestamp', default: 'now()' },
		},

		// Customer addresses
		addresses: {
			id: { type: 'integer', primaryKey: true },
			customerId: { type: 'integer', references: { table: 'customers' } },
			type: { type: 'string', nullable: false }, // 'billing' | 'shipping'
			street: { type: 'string', nullable: false },
			city: { type: 'string', nullable: false },
			postalCode: { type: 'string', nullable: false },
			country: { type: 'string', nullable: false },
			isDefault: { type: 'boolean', default: 'false' },
		},

		// Orders
		orders: {
			id: { type: 'integer', primaryKey: true },
			orderNumber: { type: 'string', nullable: false, unique: true },
			customerId: { type: 'integer', references: { table: 'customers' } },
			status: { type: 'string', default: "'pending'" }, // pending, paid, shipped, delivered
			total: { type: 'decimal', nullable: false },
			shippingAddressId: { type: 'integer', references: { table: 'addresses' } },
			billingAddressId: { type: 'integer', references: { table: 'addresses' } },
			createdAt: { type: 'timestamp', default: 'now()' },
			updatedAt: { type: 'timestamp', nullable: true },
		},

		// Order line items
		orderItems: {
			id: { type: 'integer', primaryKey: true },
			orderId: { type: 'integer', references: { table: 'orders' } },
			productId: { type: 'integer', references: { table: 'products' } },
			variantId: { type: 'integer', nullable: true, references: { table: 'variants' } },
			quantity: { type: 'integer', nullable: false },
			unitPrice: { type: 'decimal', nullable: false },
			totalPrice: { type: 'decimal', nullable: false },
		},
	},

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

		// Orders have two addresses (shipping + billing)
		// Need explicit relations because of multiple FKs to same table
		'orders.shippingAddress': {
			kind: 'belongsTo',
			target: 'addresses',
			foreignKey: 'shippingAddressId',
		},
		'orders.billingAddress': {
			kind: 'belongsTo',
			target: 'addresses',
			foreignKey: 'billingAddressId',
		},
	},
	// Other relations auto-inferred:
	// - products.category, categories.products
	// - products.variants, variants.product
	// - customers.addresses, addresses.customer
	// - customers.orders, orders.customer
	// - orders.orderItems, orderItems.order
	// - orderItems.product, orderItems.variant
});
