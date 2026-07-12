/**
 * Push Command — Schema Provisioning
 *
 * dbsp push - Push schema to database.
 * Additive by default: only creates missing objects.
 * With --drop: recreates from scratch (preserves _dbsp_migrations).
 */

import type { SchemaChange, SchemaDiff } from '@dbsp/adapter-pgsql';
import {
	comparePgsqlDatabaseSchema,
	generateDDL,
	generateMigrationSQL,
	getNamingPluginForDbCasing,
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
							...(loaded.dbCasing !== undefined
								? { naming: getNamingPluginForDbCasing(loaded.dbCasing) }
								: {}),
						});

						const migrationsPattern =
							buildMigrationsTableDropPattern(MIGRATIONS_TABLE);
						const filtered = statements.filter(
							(stmt) => !migrationsPattern.test(stmt),
						);

						outputResult(filtered, options);

						const result = await executeDdl(pool, filtered, {
							...(options.dryRun !== undefined
								? { dryRun: options.dryRun }
								: {}),
						});

						if (options.json) {
							const droppedTables = statements
								.filter((s) => /DROP\s+TABLE/i.test(s))
								.filter((s) => !migrationsPattern.test(s))
								.map(extractDroppedTableName)
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
						const compareOptions = {
							...(options.schemaName ? { schema: options.schemaName } : {}),
							...(loaded.dbCasing ? { dbCasing: loaded.dbCasing } : {}),
							onWarning: (message: string) => console.warn(`⚠️  ${message}`),
						};
						const diff = await comparePgsqlDatabaseSchema(
							pool,
							schemaModel,
							compareOptions,
						);

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

						if (!options.dryRun) {
							const postApplyDiff = await comparePgsqlDatabaseSchema(
								pool,
								schemaModel,
								{
									...compareOptions,
									previouslyAppliedDiff: diff,
								},
							);
							assertNoUnexpectedResidualDrift(postApplyDiff, skippedChanges);
						}

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
/**
 * Match a `DROP TABLE` statement that targets the migrations table, so `--drop`
 * can never destroy dbsp's own migration history.
 *
 * The table name is escaped before it reaches the pattern: an unescaped `.` or
 * `$` in it would otherwise match characters it should not, and a table whose
 * name merely resembles the migrations table would be spared — or worse, one
 * that should be spared would be dropped.
 *
 * The pattern matches the quoted name anywhere in the statement rather than
 * anchoring to the end. That is safe because `generateDDL` returns one statement
 * per array entry, so a match can never jump across a statement boundary.
 */
export function buildMigrationsTableDropPattern(tableName: string): RegExp {
	const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
	return new RegExp(
		`DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?(?:\\s+"[^"]*"\\s*\\.)?\\s*"${escaped}"`,
		'i',
	);
}

/**
 * Read the table name out of a `DROP TABLE` statement for the JSON report.
 *
 * The name is the last quoted identifier, which skips the schema in
 * `"public"."users"`, and it may be followed by `CASCADE` before the semicolon.
 * Returns the statement itself when nothing matches, so the report never silently
 * loses a table.
 */
export function extractDroppedTableName(statement: string): string {
	const match = statement.match(/"([^"]+)"\s*(?:CASCADE\s*)?;?\s*$/iu);
	return match?.[1] ?? statement;
}

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

function assertNoUnexpectedResidualDrift(
	postApplyDiff: SchemaDiff,
	skippedChanges: readonly SchemaChange[],
): void {
	const skippedKeys = new Set(skippedChanges.map(changeIdentity));
	const unexpected = postApplyDiff.changes.filter(
		(change) =>
			!(change.destructive && skippedKeys.has(changeIdentity(change))),
	);
	if (unexpected.length === 0) return;

	throw new Error(
		`Push did not converge after applying DDL; ${unexpected.length} outstanding change(s) remain:\n` +
			unexpected.map(formatOutstandingChange).join('\n'),
	);
}

function changeIdentity(change: SchemaChange): string {
	return JSON.stringify([
		change.kind,
		change.table,
		change.column ?? null,
		change.details,
		change.destructive,
	]);
}

function formatOutstandingChange(change: SchemaChange): string {
	const target = change.column
		? `${change.table}.${change.column}`
		: change.table || 'schema';
	return `   - ${change.details} (${change.kind}: ${target})`;
}
