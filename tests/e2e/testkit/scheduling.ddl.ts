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

import { sql } from 'kysely';
import { getTestDb } from './db.js';

/**
 * Create the Scheduling schema tables in a tenant schema.
 */
export async function createSchedulingSchema(schemaName: string): Promise<void> {
	const db = await getTestDb();

	// Create schema and required extension
	await sql`CREATE EXTENSION IF NOT EXISTS btree_gist`.execute(db);
	await sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref(schemaName)}`.execute(db);

	// Rooms table - conference rooms that can be booked
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.rooms (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      floor INTEGER NOT NULL
    )
  `.execute(db);

	// Room bookings with daterange
	// daterange allows checking for overlapping reservations
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.room_bookings (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.rooms(id),
      booked_by TEXT NOT NULL,
      booking_period DATERANGE NOT NULL,
      purpose TEXT,
      EXCLUDE USING gist (room_id WITH =, booking_period WITH &&)
    )
  `.execute(db);

	// Events table with tstzrange for precise time slots
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      room_id INTEGER REFERENCES ${sql.ref(schemaName)}.rooms(id),
      time_slot TSTZRANGE NOT NULL,
      organizer TEXT NOT NULL,
      max_attendees INTEGER
    )
  `.execute(db);

	// Price tiers with int4range for quantity-based pricing
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.price_tiers (
      id SERIAL PRIMARY KEY,
      product_name TEXT NOT NULL,
      quantity_range INT4RANGE NOT NULL,
      unit_price NUMERIC(10,2) NOT NULL,
      EXCLUDE USING gist (product_name WITH =, quantity_range WITH &&)
    )
  `.execute(db);

	// Indexes for range queries
	await sql`
    CREATE INDEX idx_${sql.raw(schemaName)}_bookings_period
    ON ${sql.ref(schemaName)}.room_bookings USING gist (booking_period)
  `.execute(db);

	await sql`
    CREATE INDEX idx_${sql.raw(schemaName)}_events_timeslot
    ON ${sql.ref(schemaName)}.events USING gist (time_slot)
  `.execute(db);

	await sql`
    CREATE INDEX idx_${sql.raw(schemaName)}_tiers_quantity
    ON ${sql.ref(schemaName)}.price_tiers USING gist (quantity_range)
  `.execute(db);
}

/**
 * Drop the Scheduling schema.
 */
export async function dropSchedulingSchema(schemaName: string): Promise<void> {
	const db = await getTestDb();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(db);
}
