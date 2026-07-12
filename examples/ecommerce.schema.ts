/**
 * Example: E-Commerce Schema
 *
 * Online store with products, categories, orders, and customers.
 * Demonstrates: hierarchical relations, M:N, complex FKs.
 *
 * Usage:
 *   pnpm dbsp repl --schema ./examples/ecommerce.schema.ts
 *   pnpm dbsp generate ddl --schema ./examples/ecommerce.schema.ts
 */

// ARCH-005: Use ref() alias to avoid conflict with subquery ref()
import { ref, schema } from '@dbsp/core';

export default schema({
	// Hierarchical categories (self-referencing)
	categories: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: 'string',
		slug: { type: 'string', unique: true },
		// ARCH-005: Self-ref with roles for parent/children
		parentId: ref('categories', {
			nullable: true,
			onDelete: 'SET NULL',
			roles: {
				parent: 'parent',
				children: 'children',
				ancestors: 'ancestors',
				descendants: 'descendants',
			},
		}),
		sortOrder: { type: 'integer', default: '0' },
	},

	// Products belong to categories
	products: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		sku: { type: 'string', unique: true },
		name: 'string',
		description: { type: 'text', nullable: true },
		price: 'decimal',
		stock: { type: 'integer', default: '0' },
		categoryId: ref('categories', { onDelete: 'RESTRICT', inverse: 'products' }),
		active: { type: 'boolean', default: 'true', index: true },
		createdAt: { type: 'timestamp', default: 'now()' },
	},

	// Product variants (size, color, etc.)
	variants: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		productId: ref('products', { onDelete: 'CASCADE', inverse: 'variants' }),
		sku: { type: 'string', unique: true },
		name: 'string',
		priceModifier: { type: 'decimal', default: '0' },
		stock: { type: 'integer', default: '0' },
	},

	// Customers
	customers: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		email: { type: 'string', unique: true },
		firstName: 'string',
		lastName: 'string',
		phone: { type: 'string', nullable: true },
		createdAt: { type: 'timestamp', default: 'now()' },
	},

	// Customer addresses
	addresses: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		customerId: ref('customers', { onDelete: 'CASCADE' }),
		type: 'string', // 'billing' | 'shipping'
		street: 'string',
		city: 'string',
		postalCode: 'string',
		country: 'string',
		isDefault: { type: 'boolean', default: 'false' },
	},

	// Orders
	orders: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		orderNumber: { type: 'string', unique: true },
		customerId: ref('customers', { onDelete: 'RESTRICT', inverse: 'orders' }),
		status: { type: 'string', default: "'pending'", index: true },
		total: 'decimal',
		// ARCH-005: Multi-FK to same table - use 'as' for explicit naming
		shippingAddressId: ref('addresses', { as: 'shippingAddress', inverse: 'shippingOrders' }),
		billingAddressId: ref('addresses', { as: 'billingAddress', inverse: 'billingOrders' }),
		createdAt: { type: 'timestamp', default: 'now()' },
		updatedAt: { type: 'timestamp', nullable: true },
	},

	// Order line items
	orderItems: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		orderId: ref('orders', { onDelete: 'CASCADE' }),
		productId: ref('products', { onDelete: 'RESTRICT' }),
		variantId: ref('variants', { nullable: true, onDelete: 'SET NULL' }),
		quantity: 'integer',
		unitPrice: 'decimal',
		totalPrice: 'decimal',
	},
});
// Relations auto-inferred from ref():
// - categories.parent, categories.children, categories.ancestors, categories.descendants (self-ref)
// - products.category, categories.categoryId_products
// - products.productId_variants, variants.product
// - customers.customerId_addresses, addresses.customer
// - customers.customerId_orders, orders.customer
// - orders.shippingAddress, orders.billingAddress (explicit 'as')
// - orders.orderId_orderItems, orderItems.order
// - orderItems.product, orderItems.variant
