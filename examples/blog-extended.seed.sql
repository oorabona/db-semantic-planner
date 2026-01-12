-- Blog Extended Seed Data
-- Run after DDL: psql -d your_db -f examples/blog-extended.seed.sql
--
-- Data structure:
-- - 3 authors (2 active, 1 inactive)
-- - 4 categories (hierarchical: Tech > Web, Tech > DB, Lifestyle)
-- - 8 posts (mix of published/draft, featured, various view counts)
-- - 15 comments (mix of approved/pending)
-- - 5 tags with M:N relationships

-- Authors
INSERT INTO authors (id, name, email, active) VALUES
  (1, 'Alice Johnson', 'alice@example.com', true),
  (2, 'Bob Smith', 'bob@example.com', true),
  (3, 'Charlie Brown', 'charlie@example.com', false);

-- Categories (hierarchical)
INSERT INTO categories (id, name, parent_id) VALUES
  (1, 'Technology', NULL),
  (2, 'Web Development', 1),
  (3, 'Databases', 1),
  (4, 'Lifestyle', NULL);

-- Tags
INSERT INTO tags (id, name, slug) VALUES
  (1, 'TypeScript', 'typescript'),
  (2, 'PostgreSQL', 'postgresql'),
  (3, 'Tutorial', 'tutorial'),
  (4, 'Advanced', 'advanced'),
  (5, 'Beginner', 'beginner');

-- Posts (varied data for complex filtering)
INSERT INTO posts (id, title, content, author_id, category_id, published, featured, view_count, created_at) VALUES
  (1, 'TypeScript Fundamentals', 'Learn TS basics...', 1, 2, true, true, 1500, '2024-01-15'),
  (2, 'Advanced TypeScript', 'Generics and beyond...', 1, 2, true, false, 800, '2024-02-20'),
  (3, 'PostgreSQL Deep Dive', 'Master PostgreSQL...', 2, 3, true, true, 2000, '2024-03-10'),
  (4, 'MongoDB vs PostgreSQL', 'Comparison guide...', 2, 3, true, false, 600, '2024-03-15'),
  (5, 'Work-Life Balance', 'Tips for developers...', 1, 4, true, false, 300, '2024-04-01'),
  (6, 'Draft: React Patterns', 'WIP...', 1, 2, false, false, 0, '2024-04-10'),
  (7, 'Draft: Redis Caching', 'Coming soon...', 2, 3, false, false, 0, '2024-04-15'),
  (8, 'Inactive Author Post', 'Old content...', 3, 1, true, false, 50, '2023-12-01');

-- Comments (mix of approved/pending)
INSERT INTO comments (id, post_id, author_name, content, approved, created_at) VALUES
  (1, 1, 'David', 'Great intro!', true, '2024-01-16'),
  (2, 1, 'Eva', 'Very helpful!', true, '2024-01-17'),
  (3, 1, 'Spam Bot', 'Buy crypto now!!!', false, '2024-01-18'),
  (4, 2, 'Frank', 'Mind-blowing!', true, '2024-02-21'),
  (5, 2, 'Grace', 'Need more examples', true, '2024-02-22'),
  (6, 3, 'Henry', 'PostgreSQL FTW!', true, '2024-03-11'),
  (7, 3, 'Ivy', 'Clear explanation', true, '2024-03-12'),
  (8, 3, 'Jack', 'More DB content please', true, '2024-03-13'),
  (9, 3, 'Spammer', 'Visit my site!!!', false, '2024-03-14'),
  (10, 4, 'Kate', 'Good comparison', true, '2024-03-16'),
  (11, 5, 'Leo', 'Needed this!', true, '2024-04-02'),
  (12, 5, 'Mia', 'Pending review', false, '2024-04-03'),
  (13, 1, 'Noah', 'Still relevant!', true, '2024-04-05'),
  (14, 8, 'Olivia', 'Old but gold', true, '2024-01-01'),
  (15, 8, 'Peter', 'Pending...', false, '2024-01-02');

-- Post-Tags (M:N relationships)
INSERT INTO post_tags (post_id, tag_id) VALUES
  (1, 1), (1, 3), (1, 5),  -- TS Fundamentals: typescript, tutorial, beginner
  (2, 1), (2, 4),          -- Advanced TS: typescript, advanced
  (3, 2), (3, 3), (3, 4),  -- PG Deep Dive: postgresql, tutorial, advanced
  (4, 2),                   -- MongoDB vs PG: postgresql
  (5, 5),                   -- Work-Life: beginner
  (6, 1), (6, 4),          -- Draft React: typescript, advanced
  (7, 2);                   -- Draft Redis: postgresql

-- Reset sequences to continue from max id
SELECT setval('authors_id_seq', (SELECT MAX(id) FROM authors));
SELECT setval('categories_id_seq', (SELECT MAX(id) FROM categories));
SELECT setval('tags_id_seq', (SELECT MAX(id) FROM tags));
SELECT setval('posts_id_seq', (SELECT MAX(id) FROM posts));
SELECT setval('comments_id_seq', (SELECT MAX(id) FROM comments));
