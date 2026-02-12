/**
 * Push Command — Schema Provisioning
 *
 * dbsp push - Push schema to database.
 * Additive by default: only creates missing objects.
 * With --drop: recreates from scratch (preserves _dbsp_migrations).
 */

import {
	compareSchemata,
	generateDDL,
	generateMigrationSQL,
	introspect,
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

						// Filter out any statement that would DROP the migrations table
						const migrationsPattern = new RegExp(
							`DROP\\s+TABLE.*"${MIGRATIONS_TABLE}"`,
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

						if (!options.json && !options.dryRun) {
							console.log(
								`\n✅ Push complete: ${result.statementsExecuted} statements executed`,
							);
						}
					} else {
						// Additive mode: introspect → diff → generate migration SQL (additive only)
						const dbModel = await introspect(pool, {
							...(options.schemaName ? { schema: options.schemaName } : {}),
						});

						const diff = compareSchemata(schemaModel, dbModel);

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
							process.exit(0);
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

					process.exit(0);
				} finally {
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
