/**
 * Scheduling ModelIR
 *
 * Schema definition for range type E2E tests.
 * Demonstrates PostgreSQL-specific range columns:
 * - daterange, tstzrange, int4range
 */

import { belongsTo, defineSchema, hasMany } from '@dbsp/core';

/**
 * Scheduling schema model for E2E tests.
 *
 * Tables:
 * - rooms: Conference rooms
 * - room_bookings: Reservations with daterange
 * - events: Events with tstzrange
 * - price_tiers: Quantity-based pricing with int4range
 */
export const schedulingModel = defineSchema({
	rooms: {
		id: 'integer',
		name: 'string',
		capacity: 'integer',
		floor: 'integer',
	},
	room_bookings: {
		id: 'integer',
		room_id: 'integer',
		booked_by: 'string',
		booking_period: 'string', // PostgreSQL daterange stored as string in model
		purpose: 'string',
	},
	events: {
		id: 'integer',
		title: 'string',
		room_id: 'integer',
		time_slot: 'string', // PostgreSQL tstzrange stored as string in model
		organizer: 'string',
		max_attendees: 'integer',
	},
	price_tiers: {
		id: 'integer',
		product_name: 'string',
		quantity_range: 'string', // PostgreSQL int4range stored as string in model
		unit_price: 'decimal',
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
