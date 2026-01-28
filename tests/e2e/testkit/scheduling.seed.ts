/**
 * Scheduling Seed Data
 *
 * Test data for PostgreSQL range type E2E tests.
 */

import { sql } from 'kysely';
import { getTestDb } from './db.js';

/**
 * Seed scheduling data in a schema.
 *
 * - 3 rooms
 * - 6 room bookings (with various date ranges)
 * - 5 events (with timestamp ranges)
 * - 4 price tiers (with quantity ranges)
 */
export async function seedSchedulingData(schemaName: string): Promise<void> {
	const db = await getTestDb();

	// Rooms
	await sql`
    INSERT INTO ${sql.ref(schemaName)}.rooms (id, name, capacity, floor)
    VALUES
      (1, 'Conference A', 20, 1),
      (2, 'Conference B', 10, 1),
      (3, 'Board Room', 30, 2)
  `.execute(db);

	// Room bookings with daterange
	// Format: '[start, end)' - inclusive start, exclusive end
	await sql`
    INSERT INTO ${sql.ref(schemaName)}.room_bookings (id, room_id, booked_by, booking_period, purpose)
    VALUES
      (1, 1, 'Alice', '[2024-01-15, 2024-01-20)', 'Team offsite'),
      (2, 1, 'Bob', '[2024-01-22, 2024-01-25)', 'Client meeting'),
      (3, 2, 'Charlie', '[2024-01-10, 2024-01-12)', 'Workshop'),
      (4, 2, 'Diana', '[2024-01-18, 2024-01-19)', 'Interview'),
      (5, 3, 'Eve', '[2024-01-01, 2024-01-31)', 'Monthly board meetings'),
      (6, 1, 'Frank', '[2024-02-01, 2024-02-05)', 'Sprint planning')
  `.execute(db);

	// Events with tstzrange (timezone-aware timestamp range)
	await sql`
    INSERT INTO ${sql.ref(schemaName)}.events (id, title, room_id, time_slot, organizer, max_attendees)
    VALUES
      (1, 'Morning Standup', 1, '[2024-01-15 09:00:00+00, 2024-01-15 09:30:00+00)', 'Alice', 15),
      (2, 'Product Demo', 1, '[2024-01-15 14:00:00+00, 2024-01-15 16:00:00+00)', 'Bob', 50),
      (3, 'Tech Talk', 2, '[2024-01-15 11:00:00+00, 2024-01-15 12:00:00+00)', 'Charlie', 20),
      (4, 'All Hands', 3, '[2024-01-16 10:00:00+00, 2024-01-16 11:30:00+00)', 'Diana', 100),
      (5, 'Workshop', 1, '[2024-01-17 09:00:00+00, 2024-01-17 17:00:00+00)', 'Eve', 25)
  `.execute(db);

	// Price tiers with int4range
	// Different prices based on quantity ordered
	await sql`
    INSERT INTO ${sql.ref(schemaName)}.price_tiers (id, product_name, quantity_range, unit_price)
    VALUES
      (1, 'Widget A', '[1, 10)', 99.99),
      (2, 'Widget A', '[10, 50)', 89.99),
      (3, 'Widget A', '[50, 100)', 79.99),
      (4, 'Widget A', '[100,)', 69.99)
  `.execute(db);
}

/**
 * Test data constants for assertions.
 */
export const schedulingTestData = {
	rooms: {
		count: 3,
		names: ['Conference A', 'Conference B', 'Board Room'],
	},
	bookings: {
		count: 6,
		// Bookings that overlap with Jan 17-19
		overlappingJan17_19: ['Team offsite', 'Monthly board meetings'],
		// Bookings fully contained in Jan 1-31
		containedInJan: [
			'Team offsite',
			'Client meeting',
			'Workshop',
			'Interview',
			'Monthly board meetings',
		],
	},
	events: {
		count: 5,
		// Events on Jan 15 (any time)
		onJan15: ['Morning Standup', 'Product Demo', 'Tech Talk'],
	},
	priceTiers: {
		count: 4,
		// Tier for quantity 25
		tierForQty25: { unitPrice: '89.99' },
		// Tier for quantity 75
		tierForQty75: { unitPrice: '79.99' },
	},
};
