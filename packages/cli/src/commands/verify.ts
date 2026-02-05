/**
 * ARCH-002 Block 7: Verify Command
 *
 * dbsp verify - Compare schema vs real database for drift detection.
 */

import { Command } from 'commander';
import { createDbConnection, redactDbUrl } from '../utils/db-utils.js';
import { loadSchema } from '../utils/schema-loader.js';
import {
	type DbColumnInfo,
	type DbTableInfo,
	formatVerifyResult,
	verify,
} from '../verifier.js';

/**
 * Introspect database tables using pg information_schema queries.
 */
async function introspectDatabase(
	pool: import('pg').Pool,
	schemaName?: string,
): Promise<DbTableInfo[]> {
	const targetSchema = schemaName ?? 'public';

	// Get tables in the target schema
	const tablesResult = await pool.query(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = $1 AND table_type = 'BASE TABLE'
		 ORDER BY table_name`,
		[targetSchema],
	);

	const result: DbTableInfo[] = [];

	for (const tableRow of tablesResult.rows) {
		const tableName = tableRow.table_name as string;

		// Get columns for this table
		const columnsResult = await pool.query(
			`SELECT
				column_name,
				data_type,
				is_nullable,
				column_default
			 FROM information_schema.columns
			 WHERE table_schema = $1 AND table_name = $2
			 ORDER BY ordinal_position`,
			[targetSchema, tableName],
		);

		// Get primary key columns
		const pkResult = await pool.query(
			`SELECT kcu.column_name
			 FROM information_schema.table_constraints tc
			 JOIN information_schema.key_column_usage kcu
			   ON tc.constraint_name = kcu.constraint_name
			   AND tc.table_schema = kcu.table_schema
			 WHERE tc.table_schema = $1
			   AND tc.table_name = $2
			   AND tc.constraint_type = 'PRIMARY KEY'`,
			[targetSchema, tableName],
		);
		const pkColumns = new Set(
			pkResult.rows.map((r) => r.column_name as string),
		);

		const columns: DbColumnInfo[] = columnsResult.rows.map((col) => ({
			name: col.column_name as string,
			dataType: col.data_type as string,
			isNullable: (col.is_nullable as string) === 'YES',
			isPrimaryKey: pkColumns.has(col.column_name as string),
			hasDefault: col.column_default != null,
		}));

		result.push({
			name: tableName,
			columns,
		});
	}

	return result;
}

export const verifyCommand = new Command('verify')
	.description('Compare schema vs real database (drift detection)')
	.option(
		'-s, --schema <path>',
		'Path to schema file (default: dbsp.schema.ts)',
	)
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('--schema-name <name>', 'Database schema name (default: public)')
	.option('--json', 'Output as JSON')
	.action(
		async (options: {
			schema?: string;
			db: string;
			schemaName?: string;
			json?: boolean;
		}) => {
			const schemaPath = options.schema ?? 'dbsp.schema.ts';

			const redactedUrl = redactDbUrl(options.db);

			if (!options.json) {
				console.log(`🔍 Verifying schema: ${schemaPath}`);
				console.log(`   Database: ${redactedUrl}`);
				if (options.schemaName) {
					console.log(`   Schema: ${options.schemaName}`);
				}
				console.log('');
			}

			try {
				// Load schema from file
				const schema = await loadSchema(schemaPath);

				// Connect to database
				const { pool } = await createDbConnection(options.db);

				try {
					// Introspect database
					const dbTables = await introspectDatabase(pool, options.schemaName);

					// Verify
					const result = verify(schema, dbTables);

					// Output
					if (options.json) {
						console.log(JSON.stringify(result, null, 2));
					} else {
						console.log(formatVerifyResult(result));
					}

					// Exit with error code if not valid
					process.exit(result.valid ? 0 : 1);
				} finally {
					// Close database connection
					await pool.end();
				}
			} catch (error) {
				if (error instanceof Error) {
					console.error(`❌ Error: ${error.message}`);
				} else {
					console.error('❌ Unknown error occurred');
				}
				process.exit(1);
			}
		},
	);
