import { getTestPool } from './db.js';
import { sql } from './sql.js';

export async function seedIssue154Data(schemaName: string): Promise<void> {
	const pool = await getTestPool();
	const s = sql.ref(schemaName);

	await sql`
		INSERT INTO ${s}.files (id, path)
		VALUES
			(10, '/def.ts'),
			(20, '/use.ts')
	`.execute(pool);

	await sql`
		INSERT INTO ${s}.definitions (id, file_id)
		VALUES
			(100, 10),
			(200, NULL)
	`.execute(pool);

	await sql`
		INSERT INTO ${s}.uses (id, def_id, file_id)
		VALUES
			(1000, 100, 20),
			(1001, 100, 20)
	`.execute(pool);

	await sql`
		INSERT INTO ${s}.dependencies (id, target_id)
		VALUES
			(1, 500),
			(2, 500),
			(3, 600)
	`.execute(pool);
}
