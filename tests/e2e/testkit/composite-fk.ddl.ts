import { getTestPool } from './db.js';
import { sql } from './sql.js';

export async function createCompositeFkSchema(
	schemaName: string,
): Promise<void> {
	const pool = await getTestPool();
	const s = sql.ref(schemaName);

	await sql`CREATE SCHEMA IF NOT EXISTS ${s}`.execute(pool);

	await sql`
    CREATE TABLE ${s}.orders (
      order_id  INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      status    TEXT    NOT NULL,
      PRIMARY KEY (order_id, tenant_id)
    )
  `.execute(pool);

	await sql`
    CREATE TABLE ${s}.order_items (
      id        SERIAL PRIMARY KEY,
      order_id  INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      sku       TEXT    NOT NULL,
      quantity  INTEGER NOT NULL,
      FOREIGN KEY (order_id, tenant_id)
        REFERENCES ${s}.orders(order_id, tenant_id)
    )
  `.execute(pool);
}

export async function dropCompositeFkSchema(schemaName: string): Promise<void> {
	const pool = await getTestPool();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(pool);
}
