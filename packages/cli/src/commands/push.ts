/**
 * Push Command — Schema Provisioning
 *
 * dbsp push - Push schema to database.
 * Additive by default: only creates missing objects.
 * With --drop: recreates from scratch (preserves _dbsp_migrations).
 */

import {
	comparePgsqlDatabaseSchema,
	generateDDL,
	generateMigrationSQL,
} from '@dbsp/adapter-pgsql';
import { Command } from 'commander';
import { executeDdl } from '../ddl-executor.js';
import { createDbConnection, redactDbUrl } from '../utils/db-utils.js';
import { loadSchema } from '../utils/schema-loader.js';

/** Table name reserved for migration history — never dropped by push. */
const MIGRATIONS_TABLE = '_dbsp_migrations';

export const pushCommand = new Command('push')
	.description('Push schema to database (additive by default)')
	.option(
		'-s, --schema <path>',
		'Path to schema file (default: dbsp.schema.ts)',
	)
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('--schema-name <name>', 'Database schema name (default: public)')
	.option('--drop', 'Drop and recreate all objects (preserves migrations)')
	.option('--dry-run', 'Print SQL without executing')
	.option('--json', 'Output as JSON')
	.action(
		async (options: {
			schema?: string;
			db: string;
			schemaName?: string;
			drop?: boolean;
			dryRun?: boolean;
			json?: boolean;
		}) => {
			const schemaPath = options.schema ?? 'dbsp.schema.ts';
			const redactedUrl = redactDbUrl(options.db);

			if (!options.json) {
				console.log(
					`🚀 Pushing schema: ${schemaPath}${options.drop ? ' (with --drop)' : ''}`,
				);
				console.log(`   Database: ${redactedUrl}`);
				if (options.schemaName) {
					console.log(`   Schema: ${options.schemaName}`);
				}
				if (options.dryRun) {
					console.log(`   Mode: DRY RUN (no changes will be applied)`);
				}
				console.log('');
			}

			try {
				const loaded = await loadSchema(schemaPath);
				const schemaModel = loaded.model;

				const { pool } = await createDbConnection(options.db);

				try {
					if (options.drop) {
						// --drop mode: generate full DDL with drops, excluding _dbsp_migrations
						const statements = generateDDL(schemaModel, {
							includeDropStatements: true,
							...(options.schemaName ? { schemaName: options.schemaName } : {}),
						});

						// SEC-7: Escape MIGRATIONS_TABLE before interpolating into RegExp
						const escapedTable = MIGRATIONS_TABLE.replace(
							/[.*+?^${}()|[\]\\]/g,
							'\\$&',
						);
						// CC-11: Token-based check — match DROP TABLE ... "tableName" (no greedy .*
						// across statement boundaries). The pattern anchors on the quoted table name
						// appearing anywhere in the statement, which is safe for single-statement
						// inputs (generateDDL returns one statement per array entry).
						const migrationsPattern = new RegExp(
							`DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?(?:\\s+"[^"]*"\\s*\\.)?\\s*"${escapedTable}"`,
							'i',
						);
						const filtered = statements.filter(
							(stmt) => !migrationsPattern.test(stmt),
						);

						outputResult(filtered, options);

						const result = await executeDdl(pool, filtered, {
							...(options.dryRun !== undefined
								? { dryRun: options.dryRun }
								: {}),
						});

						// CC-1: --drop --json must emit JSON to stdout on success
						if (options.json) {
							const droppedTables = statements
								.filter((s) => /DROP\s+TABLE/i.test(s))
								.filter((s) => !migrationsPattern.test(s))
								.map((s) => {
									// M6: handle CASCADE between last quoted identifier and semicolon
									// e.g. DROP TABLE IF EXISTS "public"."users" CASCADE;
									const m = s.match(/"([^"]+)"\s*(?:CASCADE\s*)?;?\s*$/i);
									return m ? m[1] : s;
								})
								.filter((t): t is string => t !== undefined);
							console.log(
								JSON.stringify(
									{
										status: options.dryRun ? 'dry-run' : 'dropped',
										tables: droppedTables,
										tablesDropped: droppedTables.length,
										statementsExecuted: result.statementsExecuted,
									},
									null,
									2,
								),
							);
						} else if (!options.dryRun) {
							console.log(
								`\n✅ Push complete: ${result.statementsExecuted} statements executed`,
							);
						}
					} else {
						// Additive mode: live diff -> generate migration SQL (additive only)
						const diff = await comparePgsqlDatabaseSchema(pool, schemaModel, {
							...(options.schemaName ? { schema: options.schemaName } : {}),
							onWarning: (message) => console.warn(`⚠️  ${message}`),
						});

						// Generate SQL for additive changes only (no destructive)
						const statements = generateMigrationSQL(diff, {
							includeDestructive: false,
							...(options.schemaName ? { schemaName: options.schemaName } : {}),
						});

						// Collect warnings for skipped non-additive changes
						const skippedChanges = diff.changes.filter((c) => c.destructive);

						if (!options.json && skippedChanges.length > 0) {
							console.log(
								`⚠️  ${skippedChanges.length} non-additive change(s) skipped:`,
							);
							for (const change of skippedChanges) {
								console.log(`   - ${change.details}`);
							}
							console.log('');
						}

						if (statements.length === 0) {
							if (options.json) {
								console.log(
									JSON.stringify(
										{
											status: 'up-to-date',
											statementsExecuted: 0,
											skippedChanges: skippedChanges.length,
										},
										null,
										2,
									),
								);
							} else {
								console.log('✅ Database is up to date — nothing to push.');
							}
							// EH-14: return instead of process.exit(0) so pool.end() in finally runs
							return;
						}

						outputResult(statements, options);

						const result = await executeDdl(pool, statements, {
							...(options.dryRun !== undefined
								? { dryRun: options.dryRun }
								: {}),
						});

						if (options.json) {
							console.log(
								JSON.stringify(
									{
										status: options.dryRun ? 'dry-run' : 'applied',
										statementsExecuted: result.statementsExecuted,
										skippedChanges: skippedChanges.length,
									},
									null,
									2,
								),
							);
						} else if (!options.dryRun) {
							console.log(
								`\n✅ Push complete: ${result.statementsExecuted} statement(s) executed`,
							);
						}
					}
					// EH-14: return so finally runs pool.end() before the outer success path
				} finally {
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

/**
 * Output SQL statements (dry-run or --json mode).
 */
function outputResult(
	statements: readonly string[],
	options: { dryRun?: boolean; json?: boolean },
): void {
	if (options.dryRun && !options.json) {
		console.log(`-- Dry run: ${statements.length} statement(s)\n`);
		for (const stmt of statements) {
			console.log(`${stmt};\n`);
		}
	}
}
