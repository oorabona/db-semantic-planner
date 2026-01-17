-- Scheduling Schema DDL
-- PostgreSQL Range Types demonstration
--
-- Usage:
--   psql -d your_db -f examples/scheduling.ddl.sql
--   Or via REPL: pnpm dbsp repl --schema ./examples/scheduling.schema.ts --db postgres://...

-- Drop tables if exist (reverse order for FK constraints)
DROP TABLE IF EXISTS price_tiers CASCADE;
DROP TABLE IF EXISTS events CASCADE;
DROP TABLE IF EXISTS room_bookings CASCADE;
DROP TABLE IF EXISTS rooms CASCADE;

-- Rooms table
CREATE TABLE rooms (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    floor INTEGER NOT NULL
);

-- Room bookings with daterange
CREATE TABLE room_bookings (
    id SERIAL PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    booked_by VARCHAR(100) NOT NULL,
    booking_period DATERANGE NOT NULL,
    purpose VARCHAR(255),
    -- Prevent overlapping bookings for the same room
    EXCLUDE USING gist (room_id WITH =, booking_period WITH &&)
);

-- Events with tstzrange (timestamp with timezone range)
CREATE TABLE events (
    id SERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    time_slot TSTZRANGE NOT NULL,
    organizer VARCHAR(100) NOT NULL,
    max_attendees INTEGER,
    -- Prevent overlapping events in the same room
    EXCLUDE USING gist (room_id WITH =, time_slot WITH &&)
);

-- Price tiers with int4range for quantity-based pricing
CREATE TABLE price_tiers (
    id SERIAL PRIMARY KEY,
    product_name VARCHAR(100) NOT NULL,
    quantity_range INT4RANGE NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL CHECK (unit_price >= 0),
    -- Prevent overlapping quantity ranges for same product
    EXCLUDE USING gist (product_name WITH =, quantity_range WITH &&)
);

-- Indexes for range queries
CREATE INDEX idx_bookings_period ON room_bookings USING gist (booking_period);
CREATE INDEX idx_events_time_slot ON events USING gist (time_slot);
CREATE INDEX idx_price_tiers_quantity ON price_tiers USING gist (quantity_range);

-- Regular indexes
CREATE INDEX idx_bookings_room ON room_bookings(room_id);
CREATE INDEX idx_events_room ON events(room_id);
CREATE INDEX idx_price_tiers_product ON price_tiers(product_name);

COMMENT ON TABLE rooms IS 'Meeting rooms and conference spaces';
COMMENT ON TABLE room_bookings IS 'Room reservations with date ranges';
COMMENT ON TABLE events IS 'Scheduled events with timestamp ranges';
COMMENT ON TABLE price_tiers IS 'Quantity-based pricing tiers';

COMMENT ON COLUMN room_bookings.booking_period IS 'PostgreSQL daterange type';
COMMENT ON COLUMN events.time_slot IS 'PostgreSQL tstzrange type';
COMMENT ON COLUMN price_tiers.quantity_range IS 'PostgreSQL int4range type';
