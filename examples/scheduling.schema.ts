/**
 * Example: Scheduling Schema - PostgreSQL Range Types
 *
 * Demonstrates PostgreSQL-specific range columns:
 * - daterange: Date ranges for room bookings
 * - tstzrange: Timestamp ranges for events
 * - int4range: Integer ranges for price tiers
 *
 * Usage:
 *   pnpm dbsp repl --schema ./examples/scheduling.schema.ts
 *   pnpm dbsp generate kysely --schema ./examples/scheduling.schema.ts
 *
 * Example queries:
 *   > room_bookings where booking_period overlaps [2024-01-15,2024-01-20)
 *   > price_tiers where quantity_range contains 25
 *   > rooms include bookings where booking_period containedBy [2024-01-01,2024-02-01)
 */

import { defineSchema } from '@dbsp/schema';

export default defineSchema({
	rooms: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'string' },
		capacity: { type: 'integer' },
		floor: { type: 'integer' },
	},
	room_bookings: {
		id: { type: 'integer', primaryKey: true },
		room_id: { type: 'integer', references: { table: 'rooms' } },
		booked_by: { type: 'string' },
		booking_period: { type: 'string' }, // PostgreSQL daterange
		purpose: { type: 'string', nullable: true },
	},
	events: {
		id: { type: 'integer', primaryKey: true },
		title: { type: 'string' },
		room_id: { type: 'integer', references: { table: 'rooms' } },
		time_slot: { type: 'string' }, // PostgreSQL tstzrange
		organizer: { type: 'string' },
		max_attendees: { type: 'integer', nullable: true },
	},
	price_tiers: {
		id: { type: 'integer', primaryKey: true },
		product_name: { type: 'string' },
		quantity_range: { type: 'string' }, // PostgreSQL int4range
		unit_price: { type: 'decimal' },
	},
});
// Relations auto-inferred from `references`:
// - rooms.room_bookings (hasMany)
// - rooms.events (hasMany)
// - room_bookings.room (belongsTo)
// - events.room (belongsTo)
