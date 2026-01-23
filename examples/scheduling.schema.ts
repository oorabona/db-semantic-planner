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
 * Example queries (NQL uses logical camelCase names):
 *   > roomBookings | where bookingPeriod overlaps [2024-01-15,2024-01-20)
 *   > priceTiers | where quantityRange contains 25
 *   > rooms | with roomBookings | where bookingPeriod containedBy [2024-01-01,2024-02-01)
 */

import { defineSchema } from '@dbsp/core';

export default defineSchema({
	rooms: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: { type: 'string' },
		capacity: { type: 'integer' },
		floor: { type: 'integer' },
	},
	roomBookings: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		roomId: { type: 'integer', references: { table: 'rooms', onDelete: 'CASCADE' }, index: true },
		bookedBy: { type: 'string' },
		bookingPeriod: { type: 'daterange' }, // PostgreSQL daterange
		purpose: { type: 'string', nullable: true },
	},
	events: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		title: { type: 'string' },
		roomId: { type: 'integer', references: { table: 'rooms', onDelete: 'CASCADE' }, index: true },
		timeSlot: { type: 'tstzrange' }, // PostgreSQL tstzrange
		organizer: { type: 'string' },
		maxAttendees: { type: 'integer', nullable: true },
	},
	priceTiers: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		productName: { type: 'string', index: true },
		quantityRange: { type: 'int4range' }, // PostgreSQL int4range
		unitPrice: { type: 'decimal' },
	},
});
// Relations auto-inferred from `references`:
// - rooms.roomBookings (hasMany)
// - rooms.events (hasMany)
// - roomBookings.room (belongsTo)
// - events.room (belongsTo)
