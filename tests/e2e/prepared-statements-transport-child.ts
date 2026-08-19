import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import { projectionlessCompiledQuery } from '@dbsp/types/adapter-sdk';
import { Pool } from 'pg';

const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	max: 1,
	application_name: process.env.DBSP_APPLICATION_NAME,
});
pool.on('error', () => {});
const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
const compiled = (value: boolean) =>
	projectionlessCompiledQuery(
		{
			sql: 'SELECT pg_sleep(30) WHERE $1::boolean',
			parameters: [value],
		},
		'prepared-statements-transport-child',
	);

await adapter.execute(compiled(false));
await adapter.execute(compiled(false));
try {
	console.log('ready-for-termination');
	await adapter.execute(compiled(true));
	console.error('pending named query unexpectedly resolved');
	process.exitCode = 1;
} catch (error) {
	console.log(
		'named-query-rejected:' +
			(error && typeof error === 'object' && 'code' in error
				? error.code
				: 'unknown'),
	);
} finally {
	await pool.end();
}
