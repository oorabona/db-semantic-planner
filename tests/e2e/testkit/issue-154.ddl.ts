import { getTestPool } from './db.js';
import { sql } from './sql.js';

export async function createIssue154Schema(schemaName: string): Promise<void> {
	const pool = await getTestPool();
	const s = sql.ref(schemaName);

	await sql`CREATE SCHEMA IF NOT EXISTS ${s}`.execute(pool);

	await sql`
		CREATE TABLE ${s}.files (
			id INTEGER PRIMARY KEY,
			path TEXT NOT NULL
		)
	`.execute(pool);

	await sql`
		CREATE TABLE ${s}.definitions (
			id INTEGER PRIMARY KEY,
			file_id INTEGER REFERENCES ${s}.files(id)
		)
	`.execute(pool);

	await sql`
		CREATE TABLE ${s}.uses (
			id INTEGER PRIMARY KEY,
			def_id INTEGER REFERENCES ${s}.definitions(id),
			file_id INTEGER REFERENCES ${s}.files(id),
			alt_file_id INTEGER REFERENCES ${s}.files(id)
		)
	`.execute(pool);

	await sql`
		CREATE TABLE ${s}.dependencies (
			id INTEGER PRIMARY KEY,
			target_id INTEGER NOT NULL
		)
	`.execute(pool);
}

export async function dropIssue154Schema(schemaName: string): Promise<void> {
	const pool = await getTestPool();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(pool);
}
