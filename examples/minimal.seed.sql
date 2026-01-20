-- Minimal Schema Seed Data
--
-- Prerequisites: Run minimal.ddl.sql first
-- Usage: psql -d your_db -f examples/minimal.seed.sql

INSERT INTO users (name, email) VALUES
    ('Alice', 'alice@example.com'),
    ('Bob', 'bob@example.com'),
    ('Charlie', 'charlie@example.com');

INSERT INTO posts (title, content, user_id) VALUES
    ('Hello World', 'My first post!', 1),
    ('Getting Started', 'Here is how to begin...', 1),
    ('Tips and Tricks', 'Some useful tips for beginners.', 2),
    ('Advanced Topics', NULL, 2),
    ('Final Thoughts', 'Wrapping up the series.', 3);

-- Verify
SELECT 'Users:', count(*) FROM users;
SELECT 'Posts:', count(*) FROM posts;
