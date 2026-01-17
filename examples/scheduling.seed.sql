-- Scheduling Schema Seed Data
-- Sample data for testing range type queries
--
-- Usage:
--   psql -d your_db -f examples/scheduling.seed.sql

-- Clear existing data
TRUNCATE price_tiers, events, room_bookings, rooms RESTART IDENTITY CASCADE;

-- Insert rooms
INSERT INTO rooms (name, capacity, floor) VALUES
    ('Conference Room A', 20, 1),
    ('Conference Room B', 10, 1),
    ('Board Room', 30, 2),
    ('Training Room', 50, 2),
    ('Huddle Space 1', 4, 1),
    ('Huddle Space 2', 4, 1),
    ('Executive Suite', 15, 3),
    ('Auditorium', 200, 0);

-- Insert room bookings (daterange)
-- Format: [start_date, end_date) - inclusive start, exclusive end
INSERT INTO room_bookings (room_id, booked_by, booking_period, purpose) VALUES
    -- Conference Room A bookings
    (1, 'Alice Johnson', '[2024-01-15, 2024-01-17)', 'Product planning'),
    (1, 'Bob Smith', '[2024-01-20, 2024-01-21)', 'Client meeting'),
    (1, 'Carol White', '[2024-01-25, 2024-01-28)', 'Team workshop'),

    -- Conference Room B bookings
    (2, 'David Brown', '[2024-01-10, 2024-01-12)', 'Interview sessions'),
    (2, 'Eve Davis', '[2024-01-18, 2024-01-19)', 'Code review'),

    -- Board Room bookings
    (3, 'Frank Miller', '[2024-01-08, 2024-01-09)', 'Board meeting'),
    (3, 'Grace Lee', '[2024-01-15, 2024-01-16)', 'Strategy session'),
    (3, 'Henry Wilson', '[2024-01-22, 2024-01-24)', 'Investor presentation'),

    -- Training Room bookings
    (4, 'Ivy Chen', '[2024-01-02, 2024-01-05)', 'New hire onboarding'),
    (4, 'Jack Taylor', '[2024-01-15, 2024-01-20)', 'Technical training'),
    (4, 'Karen Adams', '[2024-01-29, 2024-02-02)', 'Certification prep'),

    -- Longer term bookings
    (7, 'CEO Office', '[2024-01-01, 2024-01-31)', 'Executive reserved'),
    (8, 'HR Team', '[2024-01-10, 2024-01-11)', 'All-hands meeting');

-- Insert events (tstzrange - timestamp with timezone)
-- Format: [start_timestamp, end_timestamp)
INSERT INTO events (title, room_id, time_slot, organizer, max_attendees) VALUES
    -- Morning events
    ('Daily Standup', 5, '[2024-01-15 09:00:00+00, 2024-01-15 09:30:00+00)', 'Scrum Master', 10),
    ('Sprint Planning', 1, '[2024-01-15 10:00:00+00, 2024-01-15 12:00:00+00)', 'Product Owner', 15),
    ('Design Review', 2, '[2024-01-15 11:00:00+00, 2024-01-15 12:00:00+00)', 'Design Lead', 8),

    -- Afternoon events
    ('Tech Talk: PostgreSQL', 4, '[2024-01-15 14:00:00+00, 2024-01-15 15:30:00+00)', 'Senior Dev', 40),
    ('1:1 Meeting', 6, '[2024-01-15 14:00:00+00, 2024-01-15 14:30:00+00)', 'Manager', 2),
    ('Code Review Session', 2, '[2024-01-15 15:00:00+00, 2024-01-15 16:00:00+00)', 'Tech Lead', 6),

    -- All-day and multi-day events
    ('Company Offsite', 8, '[2024-01-20 08:00:00+00, 2024-01-20 18:00:00+00)', 'HR Director', 150),
    ('Hackathon', 4, '[2024-01-25 09:00:00+00, 2024-01-26 18:00:00+00)', 'Engineering', 50),

    -- Evening events
    ('Team Happy Hour', 1, '[2024-01-15 17:00:00+00, 2024-01-15 19:00:00+00)', 'Team Lead', 20),
    ('Board Dinner', 7, '[2024-01-15 18:00:00+00, 2024-01-15 21:00:00+00)', 'Executive Assistant', 12);

-- Insert price tiers (int4range)
-- Volume-based pricing: [min_quantity, max_quantity)
INSERT INTO price_tiers (product_name, quantity_range, unit_price) VALUES
    -- Widget pricing tiers
    ('Widget Pro', '[1, 10)', 99.99),
    ('Widget Pro', '[10, 50)', 89.99),
    ('Widget Pro', '[50, 100)', 79.99),
    ('Widget Pro', '[100, 500)', 69.99),
    ('Widget Pro', '[500,)', 59.99),  -- Unbounded upper (500+)

    -- Gadget pricing tiers
    ('Gadget Basic', '[1, 5)', 29.99),
    ('Gadget Basic', '[5, 25)', 24.99),
    ('Gadget Basic', '[25, 100)', 19.99),
    ('Gadget Basic', '[100,)', 14.99),

    -- Service pricing tiers
    ('API Calls', '[1, 1000)', 0.01),
    ('API Calls', '[1000, 10000)', 0.008),
    ('API Calls', '[10000, 100000)', 0.005),
    ('API Calls', '[100000,)', 0.002),

    -- License pricing
    ('Team License', '[1, 5)', 199.00),
    ('Team License', '[5, 20)', 149.00),
    ('Team License', '[20, 100)', 99.00),
    ('Team License', '[100,)', 79.00);

-- Verify data
SELECT 'Rooms:', count(*) FROM rooms;
SELECT 'Bookings:', count(*) FROM room_bookings;
SELECT 'Events:', count(*) FROM events;
SELECT 'Price Tiers:', count(*) FROM price_tiers;

-- Example range queries to test:
-- Find bookings overlapping Jan 15-20:
-- SELECT * FROM room_bookings WHERE booking_period && '[2024-01-15, 2024-01-20)'::daterange;

-- Find price tier for quantity 25:
-- SELECT * FROM price_tiers WHERE quantity_range @> 25;

-- Find events between 10am-2pm on Jan 15:
-- SELECT * FROM events WHERE time_slot && '[2024-01-15 10:00:00+00, 2024-01-15 14:00:00+00)'::tstzrange;
