/**
 * Scheduling ModelIR
 *
 * Schema definition for range type E2E tests.
 * Demonstrates PostgreSQL-specific range columns:
 * - daterange, tstzrange, int4range
 */

import { belongsTo, defineSchemaBuilder, hasMany } from '@dbsp/core';

/**
 * Scheduling schema model for E2E tests.
 *
 * Tables:
 * - rooms: Conference rooms
 * - room_bookings: Reservations with daterange
 * - events: Events with tstzrange
 * - price_tiers: Quantity-based pricing with int4range
 */
export const schedulingModel = defineSchemaBuilder({
	rooms: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'string' },
		capacity: { type: 'integer' },
		floor: { type: 'integer' },
	},
	room_bookings: {
		id: { type: 'integer', primaryKey: true },
		room_id: { type: 'integer' },
		booked_by: { type: 'string' },
		booking_period: { type: 'string' }, // PostgreSQL daterange stored as string in model
		purpose: { type: 'string' },
	},
	events: {
		id: { type: 'integer', primaryKey: true },
		title: { type: 'string' },
		room_id: { type: 'integer' },
		time_slot: { type: 'string' }, // PostgreSQL tstzrange stored as string in model
		organizer: { type: 'string' },
		max_attendees: { type: 'integer' },
	},
	price_tiers: {
		id: { type: 'integer', primaryKey: true },
		product_name: { type: 'string' },
		quantity_range: { type: 'string' }, // PostgreSQL int4range stored as string in model
		unit_price: { type: 'decimal' },
	},
})
	.relations({
		rooms: {
			bookings: hasMany('room_bookings', { foreignKey: 'room_id' }),
			events: hasMany('events', { foreignKey: 'room_id' }),
		},
		room_bookings: {
			room: belongsTo('rooms', { foreignKey: 'room_id' }),
		},
		events: {
			room: belongsTo('rooms', { foreignKey: 'room_id' }),
		},
	})
	.build();
