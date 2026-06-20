import { getTestPool } from './db.js';
import { sql } from './sql.js';

export async function seedCategoriesData(schemaName: string): Promise<void> {
	const pool = await getTestPool();
	const s = sql.ref(schemaName);

	await sql`
		INSERT INTO ${s}.categories (id, name, parent_id)
		VALUES
			(1, 'Root', NULL),
			(2, 'Hardware', 1),
			(3, 'Laptops', 2),
			(4, 'Ultrabooks', 3),
			(10, 'Cycle A', NULL),
			(11, 'Cycle B', NULL),
			(12, 'Cycle C', NULL)
	`.execute(pool);

	await sql`
		UPDATE ${s}.categories
		SET parent_id = CASE id
			WHEN 10 THEN 12
			WHEN 11 THEN 10
			WHEN 12 THEN 11
			ELSE parent_id
		END
		WHERE id IN (10, 11, 12)
	`.execute(pool);
}
