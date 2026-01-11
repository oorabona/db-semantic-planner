/**
 * ARCH-002 Block 7: Verify Command
 *
 * dbsp verify - Compare schema vs real database for drift detection.
 */

import { Command } from 'commander';
import { loadSchema } from '../utils/schema-loader.js';
import {
	type DbColumnInfo,
	type DbTableInfo,
	formatVerifyResult,
	verify,
} from '../verifier.js';

/**
 * Try to dynamically import Kysely and pg.
 * These are optional peer dependencies.
 */
async function createDbConnection(connectionUrl: string) {
	try {
		// Dynamic import of Kysely
		const { Kysely, PostgresDialect } = await import('kysely');
		const { default: pg } = await import('pg');

		const pool = new pg.Pool({
			connectionString: connectionUrl,
		});

		const db = new Kysely<unknown>({
			dialect: new PostgresDialect({ pool }),
		});

		return { db, pool };
	} catch (_error) {
		throw new Error(
			'kysely and pg are required for verify command. ' +
				'Install them with: pnpm add kysely pg',
		);
	}
}

/**
 * Introspect database tables using Kysely's introspection API.
 * Note: Using 'any' types for dynamically-imported Kysely introspection results.
 */
async function introspectDatabase(
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic import - accepting any Kysely instance
	db: any,
	schemaName?: string,
): Promise<DbTableInfo[]> {
	const tables = await db.introspection.getTables({
		withInternalKyselyTables: false,
	});

	// Filter by schema if specified
	const filteredTables = schemaName
		? // biome-ignore lint/suspicious/noExplicitAny: Kysely TableMetadata from introspection
			tables.filter((t: any) => t.schema === schemaName)
		: // biome-ignore lint/suspicious/noExplicitAny: Kysely TableMetadata from introspection
			tables.filter((t: any) => t.schema === 'public');

	// Get column info for each table
	const result: DbTableInfo[] = [];
	for (const table of filteredTables) {
		// biome-ignore lint/suspicious/noExplicitAny: Kysely ColumnMetadata type from introspection
		const columns: DbColumnInfo[] = table.columns.map((col: any) => ({
			name: col.name,
			dataType: col.dataType,
			isNullable: col.isNullable,
			isPrimaryKey:
				col.name ===
				// biome-ignore lint/suspicious/noExplicitAny: Kysely ColumnMetadata type
				table.columns.find((c: any) => c.hasDefaultValue && c.name === 'id')
					?.name,
			hasDefault: col.hasDefaultValue,
		}));

		result.push({
			name: table.name,
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

			// Redact password in URL for logging
			const redactedUrl = options.db.replace(/:[^:@]+@/, ':***@');

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
				const { db, pool } = await createDbConnection(options.db);

				try {
					// Introspect database
					const dbTables = await introspectDatabase(db, options.schemaName);

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
					await db.destroy();
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
