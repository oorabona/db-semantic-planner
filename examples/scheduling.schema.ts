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
 *   pnpm dbsp generate ddl --schema ./examples/scheduling.schema.ts
 *
 * Example queries (NQL uses logical camelCase names):
 *   > roomBookings | where bookingPeriod overlaps [2024-01-15,2024-01-20)
 *   > priceTiers | where quantityRange contains 25
 *   > rooms | with roomBookings | where bookingPeriod containedBy [2024-01-01,2024-02-01)
 */

import { ref, schema } from '@dbsp/core';

export default schema({
	rooms: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: 'string',
		capacity: 'integer',
		floor: 'integer',
	},
	roomBookings: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		roomId: ref('rooms', { onDelete: 'CASCADE', inverse: 'roomBookings' }),
		bookedBy: 'string',
		bookingPeriod: 'daterange', // PostgreSQL daterange
		purpose: { type: 'string', nullable: true },
	},
	events: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		title: 'string',
		roomId: ref('rooms', { onDelete: 'CASCADE' }),
		timeSlot: 'tstzrange', // PostgreSQL tstzrange
		organizer: 'string',
		maxAttendees: { type: 'integer', nullable: true },
	},
	priceTiers: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		productName: { type: 'string', index: true },
		quantityRange: 'int4range', // PostgreSQL int4range
		unitPrice: 'decimal',
	},
});
// Relations auto-inferred from ref():
// - rooms.roomId_roomBookings (hasMany)
// - rooms.roomId_events (hasMany)
// - roomBookings.room (belongsTo)
// - events.room (belongsTo)
