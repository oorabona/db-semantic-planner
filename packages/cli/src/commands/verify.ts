/**
 * Verify Command — Schema Drift Detection
 *
 * dbsp verify - Compare schema vs real database using the comparison engine.
 * Detects drift in tables, columns, types, nullable, defaults, FKs, indexes.
 */

import { comparePgsqlDatabaseSchema, introspect } from '@dbsp/adapter-pgsql';
import { Command } from 'commander';
import { createDbConnection, redactDbUrl } from '../utils/db-utils.js';
import { loadSchema } from '../utils/schema-loader.js';
import { formatVerifyResult, verifyFromDiff } from '../verifier.js';

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
				// Load schema from file → ModelIR
				const loaded = await loadSchema(schemaPath);
				const schemaModel = loaded.model;

				// Connect to database
				const { pool } = await createDbConnection(options.db);

				try {
					// Live diff: introspect database and canonicalise PostgreSQL CHECK
					// expressions before comparing.
					const diff = await comparePgsqlDatabaseSchema(pool, schemaModel, {
						...(options.schemaName ? { schema: options.schemaName } : {}),
						...(loaded.dbCasing !== undefined
							? { dbCasing: loaded.dbCasing }
							: {}),
						onWarning: (message) => console.warn(`⚠️  ${message}`),
					});

					// Convert to verify result
					// Keep the legacy reporting fields sourced from introspection so
					// --json consumers continue to see database table names as before.
					const dbModel = await introspect(pool, {
						...(options.schemaName ? { schema: options.schemaName } : {}),
					});
					const schemaTables = Array.from(schemaModel.tables.keys());
					const dbTables = Array.from(dbModel.tables.keys());
					const result = verifyFromDiff(diff, schemaTables, dbTables);

					// Output
					if (options.json) {
						// Exclude the full diff meta from JSON output (too verbose)
						const { diff: _diff, ...jsonResult } = result;
						console.log(
							JSON.stringify(
								{
									...jsonResult,
									summary: diff.summary,
									hasDestructive: diff.hasDestructive,
								},
								null,
								2,
							),
						);
					} else {
						console.log(formatVerifyResult(result));
					}

					// EH-14: set exit code; let finally run pool.end() before process exits
					process.exitCode = result.valid ? 0 : 1;
					return;
				} finally {
					// Close database connection
					await pool.end();
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : 'Unknown error occurred';
				// CC-2+EH-7: If --json, error goes to stdout as JSON; otherwise stderr
				if (options.json) {
					console.log(
						JSON.stringify({ status: 'error', error: message }, null, 2),
					);
				} else {
					console.error(`❌ Error: ${message}`);
				}
				process.exit(1);
			}
		},
	);
