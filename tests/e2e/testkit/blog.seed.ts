/**
 * Blog Seed Data
 *
 * Test data for Q5 (Blog scenario).
 */

import { getTestPool } from './db.js';
import { sql } from './sql.js';

/**
 * Seed blog data in a schema.
 *
 * - 1 company
 * - 2 authors
 * - 5 posts (3 published)
 * - 10 comments
 */
export async function seedBlogData(schemaName: string): Promise<void> {
	const pool = await getTestPool();

	// Companies
	await sql`
    INSERT INTO ${sql.ref(schemaName)}.companies (id, name)
    VALUES
      (1, 'Type Labs')
  `.execute(pool);

	// Authors
	await sql`
    INSERT INTO ${sql.ref(schemaName)}.authors (id, name, email, company_id)
    VALUES
      (1, 'Alice Johnson', 'alice@example.com', 1),
      (2, 'Bob Smith', 'bob@example.com', NULL)
  `.execute(pool);

	// Posts (3 published, 2 drafts)
	await sql`
    INSERT INTO ${sql.ref(schemaName)}.posts (id, title, content, author_id, published, created_at)
    VALUES
      (1, 'Getting Started with TypeScript', 'TypeScript is awesome...', 1, true, '2024-01-15 10:00:00'),
      (2, 'Advanced TypeScript Patterns', 'Let us explore advanced patterns...', 1, true, '2024-02-20 14:30:00'),
      (3, 'Introduction to PostgreSQL', 'PostgreSQL is a powerful database...', 2, true, '2024-03-10 09:15:00'),
      (4, 'Draft: React Best Practices', 'Work in progress...', 1, false, '2024-04-01 11:00:00'),
      (5, 'Draft: Database Optimization', 'Coming soon...', 2, false, '2024-04-05 16:45:00')
  `.execute(pool);

	// Comments
	await sql`
    INSERT INTO ${sql.ref(schemaName)}.comments (id, post_id, author_name, content, created_at)
    VALUES
      (1, 1, 'Charlie', 'Great introduction!', '2024-01-16 08:00:00'),
      (2, 1, 'Diana', 'Very helpful, thanks!', '2024-01-17 12:30:00'),
      (3, 1, 'Eve', 'I learned a lot from this.', '2024-01-18 15:00:00'),
      (4, 2, 'Frank', 'Mind-blowing patterns!', '2024-02-21 10:00:00'),
      (5, 2, 'Grace', 'Could you elaborate on generics?', '2024-02-22 11:30:00'),
      (6, 3, 'Henry', 'PostgreSQL FTW!', '2024-03-11 09:00:00'),
      (7, 3, 'Ivy', 'Very clear explanation.', '2024-03-12 14:00:00'),
      (8, 3, 'Jack', 'Looking forward to more DB content.', '2024-03-13 16:30:00'),
      (9, 1, 'Kate', 'Bookmarked for later!', '2024-03-20 10:00:00'),
      (10, 2, 'Leo', 'This helped me at work.', '2024-03-25 09:00:00')
  `.execute(pool);
}
