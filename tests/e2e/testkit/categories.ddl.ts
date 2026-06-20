import { getTestPool } from './db.js';
import { sql } from './sql.js';

export async function createCategoriesSchema(
	schemaName: string,
): Promise<void> {
	const pool = await getTestPool();
	const s = sql.ref(schemaName);

	await sql`CREATE SCHEMA IF NOT EXISTS ${s}`.execute(pool);

	await sql`
		CREATE TABLE ${s}.categories (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			parent_id INTEGER REFERENCES ${s}.categories(id)
		)
	`.execute(pool);

	await sql`
		CREATE INDEX ${sql.ref(`idx_${schemaName}_categories_parent`)}
		ON ${s}.categories(parent_id)
	`.execute(pool);
}

export async function dropCategoriesSchema(schemaName: string): Promise<void> {
	const pool = await getTestPool();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(pool);
}
