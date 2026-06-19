import { getTestPool } from './db.js';
import { sql } from './sql.js';

export async function seedCompositeFkData(schemaName: string): Promise<void> {
	const pool = await getTestPool();
	const s = sql.ref(schemaName);

	await sql`
    INSERT INTO ${s}.orders (order_id, tenant_id, status) VALUES
      (100, 1, 'tenant-1-open'),
      (100, 2, 'tenant-2-open'),
      (101, 1, 'tenant-1-review')
  `.execute(pool);

	await sql`
    INSERT INTO ${s}.order_items (id, order_id, tenant_id, sku, quantity) VALUES
      (1, 100, 1, 'sku-a', 2),
      (2, 100, 1, 'sku-b', 1),
      (3, 100, 2, 'sku-c', 5),
      (4, 101, 1, 'sku-a', 3)
  `.execute(pool);
}
