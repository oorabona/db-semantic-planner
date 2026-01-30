/**
 * Scheduling Schema DDL
 *
 * PostgreSQL-specific schema demonstrating range types:
 * - daterange: for date ranges (booking periods)
 * - tstzrange: for timestamp ranges (event schedules)
 * - int4range: for integer ranges (price tiers, capacity)
 *
 * Use cases:
 * - Event scheduling with time ranges
 * - Room bookings with date ranges
 * - Price tiers with quantity ranges
 */

import { getTestPool } from './db.js';
import { sql } from './sql.js';

/**
 * Create the Scheduling schema tables in a tenant schema.
 */
export async function createSchedulingSchema(
	schemaName: string,
): Promise<void> {
	const pool = await getTestPool();
	const s = sql.ref(schemaName);

	// Create schema and required extension
	await pool.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
	await sql`CREATE SCHEMA IF NOT EXISTS ${s}`.execute(pool);

	// Rooms table - conference rooms that can be booked
	await sql`
    CREATE TABLE ${s}.rooms (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      floor INTEGER NOT NULL
    )
  `.execute(pool);

	// Room bookings with daterange
	await sql`
    CREATE TABLE ${s}.room_bookings (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES ${s}.rooms(id),
      booked_by TEXT NOT NULL,
      booking_period DATERANGE NOT NULL,
      purpose TEXT,
      EXCLUDE USING gist (room_id WITH =, booking_period WITH &&)
    )
  `.execute(pool);

	// Events table with tstzrange for precise time slots
	await sql`
    CREATE TABLE ${s}.events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      room_id INTEGER REFERENCES ${s}.rooms(id),
      time_slot TSTZRANGE NOT NULL,
      organizer TEXT NOT NULL,
      max_attendees INTEGER
    )
  `.execute(pool);

	// Price tiers with int4range for quantity-based pricing
	await sql`
    CREATE TABLE ${s}.price_tiers (
      id SERIAL PRIMARY KEY,
      product_name TEXT NOT NULL,
      quantity_range INT4RANGE NOT NULL,
      unit_price NUMERIC(10,2) NOT NULL,
      EXCLUDE USING gist (product_name WITH =, quantity_range WITH &&)
    )
  `.execute(pool);

	// Indexes for range queries
	await sql`
    CREATE INDEX ${sql.ref(`idx_${schemaName}_bookings_period`)}
    ON ${s}.room_bookings USING gist (booking_period)
  `.execute(pool);

	await sql`
    CREATE INDEX ${sql.ref(`idx_${schemaName}_events_timeslot`)}
    ON ${s}.events USING gist (time_slot)
  `.execute(pool);

	await sql`
    CREATE INDEX ${sql.ref(`idx_${schemaName}_tiers_quantity`)}
    ON ${s}.price_tiers USING gist (quantity_range)
  `.execute(pool);
}

/**
 * Drop the Scheduling schema.
 */
export async function dropSchedulingSchema(schemaName: string): Promise<void> {
	const pool = await getTestPool();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(pool);
}
