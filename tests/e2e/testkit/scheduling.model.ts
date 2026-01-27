/**
 * Scheduling ModelIR
 *
 * Schema definition for range type E2E tests.
 * Demonstrates PostgreSQL-specific range columns:
 * - daterange, tstzrange, int4range
 */

import { ref, schema } from '@dbsp/core';

/**
 * Scheduling schema for E2E tests.
 *
 * Tables:
 * - rooms: Conference rooms
 * - roomBookings: Reservations with daterange
 * - events: Events with tstzrange
 * - priceTiers: Quantity-based pricing with int4range
 */
const schedulingSchema = schema({
	rooms: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		capacity: 'integer',
		floor: 'integer',
	},
	roomBookings: {
		id: { type: 'integer', primaryKey: true },
		roomId: ref('rooms'),
		bookedBy: 'string',
		bookingPeriod: 'daterange', // PostgreSQL daterange
		purpose: { type: 'string', nullable: true },
	},
	events: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		roomId: ref('rooms'),
		timeSlot: 'tstzrange', // PostgreSQL tstzrange
		organizer: 'string',
		maxAttendees: { type: 'integer', nullable: true },
	},
	priceTiers: {
		id: { type: 'integer', primaryKey: true },
		productName: 'string',
		quantityRange: 'int4range', // PostgreSQL int4range
		unitPrice: 'decimal',
	},
});

export const schedulingModel = schedulingSchema.model;
