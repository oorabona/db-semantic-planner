-- Blog Schema Seed Data
--
-- Usage:
--   psql -d your_db -f examples/blog.seed.sql

TRUNCATE post_tags, comments, posts, tags, authors RESTART IDENTITY CASCADE;

-- Authors
INSERT INTO authors (name, email, bio) VALUES
    ('Jane Doe', 'jane@blog.com', 'Senior tech writer and developer advocate.'),
    ('John Smith', 'john@blog.com', 'Full-stack developer passionate about databases.'),
    ('Emily Chen', 'emily@blog.com', NULL);

-- Tags
INSERT INTO tags (name, slug) VALUES
    ('PostgreSQL', 'postgresql'),
    ('TypeScript', 'typescript'),
    ('Tutorial', 'tutorial'),
    ('Database', 'database'),
    ('Performance', 'performance'),
    ('Best Practices', 'best-practices');

-- Posts
INSERT INTO posts (title, slug, content, published, author_id, created_at) VALUES
    ('Getting Started with PostgreSQL', 'getting-started-postgresql',
     'PostgreSQL is a powerful, open source object-relational database system...',
     TRUE, 1, '2024-01-05 10:00:00+00'),

    ('TypeScript Best Practices 2024', 'typescript-best-practices-2024',
     'In this guide, we cover the essential TypeScript patterns...',
     TRUE, 1, '2024-01-10 14:30:00+00'),

    ('Query Optimization Techniques', 'query-optimization-techniques',
     'Learn how to optimize your database queries for maximum performance...',
     TRUE, 2, '2024-01-12 09:00:00+00'),

    ('Introduction to Range Types', 'introduction-range-types',
     'PostgreSQL range types allow you to represent ranges of values...',
     TRUE, 2, '2024-01-15 11:00:00+00'),

    ('Draft: Advanced Indexing', 'advanced-indexing-draft',
     'This post covers advanced indexing strategies...',
     FALSE, 2, '2024-01-18 16:00:00+00'),

    ('Why Type Safety Matters', 'why-type-safety-matters',
     'Type safety catches bugs at compile time instead of runtime...',
     TRUE, 3, '2024-01-20 08:00:00+00');

-- Post-Tag associations
INSERT INTO post_tags (post_id, tag_id) VALUES
    (1, 1), (1, 3), (1, 4),           -- PostgreSQL post: postgresql, tutorial, database
    (2, 2), (2, 6),                   -- TypeScript post: typescript, best-practices
    (3, 4), (3, 5),                   -- Query optimization: database, performance
    (4, 1), (4, 4), (4, 3),           -- Range types: postgresql, database, tutorial
    (5, 4), (5, 5),                   -- Draft indexing: database, performance
    (6, 2), (6, 6);                   -- Type safety: typescript, best-practices

-- Comments
INSERT INTO comments (post_id, author_name, author_email, content, approved, created_at) VALUES
    (1, 'Alex Reader', 'alex@email.com', 'Great introduction! Very helpful.', TRUE, '2024-01-06 12:00:00+00'),
    (1, 'Sam Dev', 'sam@email.com', 'Could you cover more advanced topics?', TRUE, '2024-01-07 09:30:00+00'),
    (2, 'Chris Coder', 'chris@email.com', 'This is exactly what I needed!', TRUE, '2024-01-11 15:00:00+00'),
    (3, 'Pat DBA', NULL, 'Excellent tips on EXPLAIN ANALYZE.', TRUE, '2024-01-13 10:00:00+00'),
    (4, 'Jordan Query', 'jordan@email.com', 'Range types are so useful!', TRUE, '2024-01-16 14:00:00+00'),
    (4, 'Spam Bot', 'spam@spam.com', 'Buy cheap watches!', FALSE, '2024-01-17 02:00:00+00'),
    (6, 'Taylor Types', 'taylor@email.com', 'TypeScript changed my workflow.', TRUE, '2024-01-21 11:00:00+00');

-- Verify
SELECT 'Authors:', count(*) FROM authors;
SELECT 'Posts:', count(*) FROM posts;
SELECT 'Tags:', count(*) FROM tags;
SELECT 'Post-Tags:', count(*) FROM post_tags;
SELECT 'Comments:', count(*) FROM comments;
