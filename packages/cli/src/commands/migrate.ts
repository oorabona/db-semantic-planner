/**
 * Migrate Command — Migration Infrastructure
 *
 * dbsp migrate dev      - Generate migration from schema diff
 * dbsp migrate apply    - Apply pending migrations
 * dbsp migrate rollback - Roll back applied migrations
 * dbsp migrate status   - Show migration status
 */

import {
	comparePgsqlDatabaseSchema,
	ensureMigrationsTable,
	generateMigrationFile,
	generateMigrationSQL,
	getAppliedMigrations,
	getNextSchemaVersion,
	isDestructiveDown,
	parseMigrationFile,
	recordMigration,
	removeMigrationRecord,
	withMigrationLock,
} from '@dbsp/adapter-pgsql';
import { Command } from 'commander';
import type { Pool } from 'pg';
import {
	DEFAULT_MIGRATIONS_DIR,
	generateMigrationFilename,
	scanMigrationFiles,
	writeMigrationFile,
} from '../migration-file.js';
import { createDbConnection, redactDbUrl } from '../utils/db-utils.js';
import { loadSchema } from '../utils/schema-loader.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Typed error for migration failures.
 * Distinguishes user-facing errors (validation, logic) from unexpected errors.
 */
export class MigrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MigrationError';
	}
}

/**
 * Sanitize a pg error for user-facing output.
 *
 * PostgreSQL errors may carry schema/table/row details in their message text.
 * For pg errors (identifiable by SQLSTATE `.code`), we emit a sanitized message
 * keyed only by the SQLSTATE code. The raw message is available via DEBUG=dbsp.
 *
 * @param err - Any caught value
 * @returns An Error instance safe to display to the user
 */
export function sanitizePgError(err: unknown): Error {
	if (err instanceof Error) {
		// pg errors carry a SQLSTATE `.code` property
		const code = (err as Error & { code?: string }).code;
		if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
			if (process.env.DEBUG?.includes('dbsp')) {
				console.error(`[DEBUG] pg error detail: ${err.message}`);
			}
			return new MigrationError(`Migration failed: database error ${code}`);
		}
		return err;
	}
	return new Error(String(err));
}

/**
 * DRY lifecycle wrapper: create pool → run fn → end pool on success or error.
 * Replaces the repeated try { ... } finally { pool.end() } pattern across commands.
 *
 * process.exit is called OUTSIDE the pool lifecycle so the lock-holding client
 * (from withMigrationLock) is always released before the process terminates.
 */
export async function withMigratePool<T>(
	dbUrl: string,
	fn: (pool: Pool) => Promise<T>,
): Promise<T> {
	const { pool } = await createDbConnection(dbUrl);
	try {
		return await fn(pool);
	} finally {
		let endError: unknown;
		try {
			await pool.end();
		} catch (e) {
			endError = e;
		}
		if (endError !== undefined) {
			// Cleanup failure is non-fatal — log it but don't mask the original error
			console.error(
				`Warning: pool.end() failed: ${endError instanceof Error ? endError.message : String(endError)}`,
			);
		}
	}
}

/**
 * Top-level error handler for migrate commands.
 * Ensures process.exit is only called AFTER pool cleanup (via withMigratePool).
 */
async function runMigrateAction(fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (error) {
		if (error instanceof Error) {
			console.error(`❌ Error: ${error.message}`);
		} else {
			console.error('❌ Unknown error occurred');
		}
		process.exit(1);
	}
}

/**
 * Returns true if a migration statement contains at least one executable SQL
 * line (non-empty, not a comment). Statements that consist entirely of blank
 * lines and `--` comment lines are skipped; statements that begin with a
 * comment header but also contain real SQL are kept (PostgreSQL ignores the
 * comment, so the header is harmless and preserves intent).
 */
export function hasExecutableSql(stmt: string): boolean {
	return stmt.split('\n').some((line) => {
		const t = line.trim();
		return t.length > 0 && !t.startsWith('--');
	});
}

// ============================================================================
// Subcommands
// ============================================================================

const devCommand = new Command('dev')
	.description('Generate a migration from schema changes')
	.option(
		'-s, --schema <path>',
		'Path to schema file (default: dbsp.schema.ts)',
	)
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('--schema-name <name>', 'Database schema name (default: public)')
	.option('--dir <path>', 'Migrations directory', DEFAULT_MIGRATIONS_DIR)
	.option('-n, --name <description>', 'Migration description', 'migration')
	.option('--allow-destructive', 'Include destructive changes (drops)')
	.action(
		(options: {
			schema?: string;
			db: string;
			schemaName?: string;
			dir: string;
			name: string;
			allowDestructive?: boolean;
		}) =>
			runMigrateAction(async () => {
				const schemaPath = options.schema ?? 'dbsp.schema.ts';

				console.log(`📝 Generating migration: ${schemaPath}`);
				console.log(`   Database: ${redactDbUrl(options.db)}`);
				console.log('');

				const loaded = await loadSchema(schemaPath);
				const schemaModel = loaded.model;

				await withMigratePool(options.db, async (pool) => {
					const diff = await comparePgsqlDatabaseSchema(pool, schemaModel, {
						...(options.schemaName ? { schema: options.schemaName } : {}),
						onWarning: (message) => console.warn(`⚠️  ${message}`),
					});

					if (diff.changes.length === 0) {
						console.log('✅ No changes detected — database matches schema.');
						return;
					}

					// Check for destructive changes
					if (diff.hasDestructive && !options.allowDestructive) {
						const destructive = diff.changes.filter((c) => c.destructive);
						throw new MigrationError(
							`${destructive.length} destructive change(s) detected:\n` +
								destructive.map((c) => `   - ${c.details}`).join('\n') +
								'\n\nUse --allow-destructive to include these changes.',
						);
					}

					const sqlOptions = {
						includeDestructive: options.allowDestructive ?? false,
						...(options.schemaName ? { schemaName: options.schemaName } : {}),
					};

					const statements = generateMigrationSQL(diff, sqlOptions);

					if (statements.length === 0) {
						console.log(
							'✅ No migration needed — all changes are non-actionable.',
						);
						return;
					}

					// Generate migration file with UP + DOWN sections
					const existingFiles = scanMigrationFiles(options.dir).map(
						(f) => f.name,
					);
					const filename = generateMigrationFilename(
						existingFiles,
						options.name,
					);
					const content = generateMigrationFile(diff, {
						...sqlOptions,
						name: filename,
					});

					const file = writeMigrationFile(options.dir, filename, content);

					console.log(`✅ Migration created: ${file.path}`);
					console.log(`   Statements: ${statements.length}`);
					console.log(`   Checksum: ${file.checksum.slice(0, 12)}...`);
				});
			}),
	);

const applyCommand = new Command('apply')
	.description('Apply pending migrations')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('--dir <path>', 'Migrations directory', DEFAULT_MIGRATIONS_DIR)
	.option('--dry-run', 'Show pending migrations without applying')
	.action((options: { db: string; dir: string; dryRun?: boolean }) =>
		runMigrateAction(async () => {
			console.log('🔄 Applying migrations');
			console.log(`   Database: ${redactDbUrl(options.db)}`);
			console.log(`   Directory: ${options.dir}`);
			console.log('');

			await withMigratePool(options.db, async (pool) => {
				// Ensure tracking table exists before acquiring lock
				await ensureMigrationsTable(pool);

				await withMigrationLock(pool, async (client) => {
					// Get applied migrations on the lock-holding client
					const applied = await getAppliedMigrations(client as unknown as Pool);
					const appliedMap = new Map(applied.map((m) => [m.name, m.checksum]));

					// Scan migration files
					const files = scanMigrationFiles(options.dir);

					if (files.length === 0) {
						console.log(`No migration files found in ${options.dir}`);
						return;
					}

					// Validate checksums for already-applied migrations
					for (const file of files) {
						const existingChecksum = appliedMap.get(file.name);
						if (
							existingChecksum !== undefined &&
							existingChecksum !== file.checksum
						) {
							throw new MigrationError(
								`Checksum mismatch for ${file.name}\n` +
									`   Expected: ${existingChecksum}\n` +
									`   Got:      ${file.checksum}\n` +
									'\nMigration file has been tampered with after being applied.',
							);
						}
					}

					// Find pending migrations
					const pending = files.filter((f) => !appliedMap.has(f.name));

					if (pending.length === 0) {
						console.log('✅ All migrations already applied.');
						return;
					}

					if (options.dryRun) {
						console.log(`${pending.length} pending migration(s):`);
						for (const file of pending) {
							console.log(`   - ${file.name}`);
						}
						return;
					}

					// Apply each pending migration atomically (DDL + record in one transaction)
					let appliedCount = 0;
					for (const file of pending) {
						console.log(`  Applying: ${file.name}...`);

						// Parse UP section from file
						const parsed = parseMigrationFile(file.content);
						const statements = parsed.upStatements.filter(hasExecutableSql);

						// Determine version and destructive flag before the transaction
						// (read from the lock-held client so we see a consistent view)
						const version = await getNextSchemaVersion(
							client as unknown as Pool,
						);
						const destructive = parsed.destructive === true;

						// Atomic: DDL + record in ONE transaction on the lock-holding client
						try {
							await client.query('BEGIN');

							for (const stmt of statements) {
								await client.query(stmt);
							}

							await recordMigration(
								client as unknown as Pool,
								file.name,
								file.checksum,
								version,
								destructive,
							);

							await client.query('COMMIT');
						} catch (applyError) {
							let rollbackError: unknown;
							try {
								await client.query('ROLLBACK');
							} catch (e) {
								rollbackError = e;
							}
							const primary = sanitizePgError(applyError);
							if (rollbackError !== undefined) {
								console.error(
									`   Note: rollback also failed: ${sanitizePgError(rollbackError).message}`,
								);
							}
							throw primary;
						}

						appliedCount++;
						console.log(`  ✅ Applied: ${file.name}`);
					}

					console.log(
						`\n✅ ${appliedCount} migration(s) applied successfully.`,
					);
				});
			});
		}),
	);

const rollbackCommand = new Command('rollback')
	.description('Roll back applied migrations')
	.argument('<count>', 'Number of migrations to roll back')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('--dir <path>', 'Migrations directory', DEFAULT_MIGRATIONS_DIR)
	.option('--force', 'Force rollback of destructive or empty DOWN migrations')
	.action(
		(
			countArg: string,
			options: { db: string; dir: string; force?: boolean },
		) => {
			const count = Number.parseInt(countArg, 10);
			if (Number.isNaN(count) || count < 1) {
				console.error('❌ Count must be a positive integer');
				process.exit(1);
			}

			return runMigrateAction(async () => {
				console.log(`⏪ Rolling back ${count} migration(s)`);
				console.log(`   Database: ${redactDbUrl(options.db)}`);
				console.log(`   Directory: ${options.dir}`);
				console.log('');

				await withMigratePool(options.db, async (pool) => {
					await ensureMigrationsTable(pool);

					await withMigrationLock(pool, async (client) => {
						// Get applied migrations on the lock-holding client
						const applied = await getAppliedMigrations(
							client as unknown as Pool,
						);
						const sortedDesc = [...applied].sort((a, b) =>
							b.name.localeCompare(a.name),
						);

						// SC-18: Validate count
						if (count > sortedDesc.length) {
							throw new MigrationError(
								`Cannot roll back ${count} migration(s) — only ${sortedDesc.length} applied`,
							);
						}

						const toRollback = sortedDesc.slice(0, count);

						// Load migration files from disk
						const files = scanMigrationFiles(options.dir);
						const fileMap = new Map(files.map((f) => [f.name, f]));

						let rolledBack = 0;
						for (const record of toRollback) {
							const file = fileMap.get(record.name);
							if (!file) {
								throw new MigrationError(
									`Migration file not found on disk: ${record.name}`,
								);
							}

							// SC-17: Verify checksum
							if (file.checksum !== record.checksum) {
								throw new MigrationError(
									`Checksum mismatch for ${record.name}\n` +
										`   Expected: ${record.checksum}\n` +
										`   Got:      ${file.checksum}\n` +
										'\nMigration file has been modified since it was applied.',
								);
							}

							// Parse DOWN section
							const parsed = parseMigrationFile(file.content);

							// SC-10/ERR-01: No DOWN section
							if (!parsed.hasDown) {
								throw new MigrationError(
									`Migration ${record.name} has no DOWN section\n` +
										'   Cannot roll back a migration without a DOWN section.',
								);
							}

							// SC-11/ERR-04: Empty DOWN section
							const downStmts = parsed.downStatements.filter(hasExecutableSql);
							if (downStmts.length === 0 && !options.force) {
								throw new MigrationError(
									`Migration ${record.name} has an empty DOWN section\n` +
										'   Use --force to roll back anyway.',
								);
							}

							// SC-19: Metadata-driven destructive rollback guard
							const safeHeaderContradictedByDown =
								parsed.destructive === false && isDestructiveDown(downStmts);
							if (
								(parsed.destructive !== false ||
									safeHeaderContradictedByDown) &&
								!options.force
							) {
								if (parsed.destructive === true) {
									throw new MigrationError(
										`Migration ${record.name} has destructive DOWN operations\n` +
											'   Use --force to proceed with destructive rollback.',
									);
								}
								if (safeHeaderContradictedByDown) {
									throw new MigrationError(
										`Migration ${record.name} is marked non-destructive but its DOWN section contains an obvious destructive statement\n` +
											'   Re-generate the migration with accurate dbsp metadata or pass --force.',
									);
								}
								throw new MigrationError(
									`Migration ${record.name} is unmarked or legacy\n` +
										'   Re-generate the migration with dbsp metadata or pass --force.',
								);
							}

							// Atomic: DOWN SQL + remove record in ONE transaction on the lock-holding client
							if (downStmts.length > 0 || options.force) {
								console.log(`  Rolling back: ${record.name}...`);
							}

							try {
								await client.query('BEGIN');

								for (const stmt of downStmts) {
									await client.query(stmt);
								}

								await removeMigrationRecord(
									client as unknown as Pool,
									record.name,
								);

								await client.query('COMMIT');
							} catch (rollbackError) {
								let rollbackCleanupError: unknown;
								try {
									await client.query('ROLLBACK');
								} catch (e) {
									rollbackCleanupError = e;
								}
								const primary = sanitizePgError(rollbackError);
								if (rollbackCleanupError !== undefined) {
									console.error(
										`   Note: rollback also failed: ${sanitizePgError(rollbackCleanupError).message}`,
									);
								}
								throw primary;
							}

							rolledBack++;
							console.log(`  ✅ Rolled back: ${record.name}`);
						}

						console.log(
							`\n✅ ${rolledBack} migration(s) rolled back successfully.`,
						);
					});
				});
			});
		},
	);

const statusCommand = new Command('status')
	.description('Show migration status')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('--dir <path>', 'Migrations directory', DEFAULT_MIGRATIONS_DIR)
	.option('--json', 'Output as JSON')
	.action((options: { db: string; dir: string; json?: boolean }) =>
		runMigrateAction(async () => {
			await withMigratePool(options.db, async (pool) => {
				await ensureMigrationsTable(pool);

				const applied = await getAppliedMigrations(pool);
				const appliedMap = new Map(applied.map((m) => [m.name, m]));

				const files = scanMigrationFiles(options.dir);

				const statuses: Array<{
					name: string;
					status: 'pending' | 'applied' | 'checksum_mismatch' | 'missing_file';
					appliedAt?: Date;
				}> = files.map((file) => {
					const record = appliedMap.get(file.name);
					if (record === undefined) {
						return {
							name: file.name,
							status: 'pending' as const,
						};
					}
					if (record.checksum !== file.checksum) {
						return {
							name: file.name,
							status: 'checksum_mismatch' as const,
							appliedAt: record.appliedAt,
						};
					}
					return {
						name: file.name,
						status: 'applied' as const,
						appliedAt: record.appliedAt,
					};
				});

				// Also show applied migrations that don't have files anymore
				for (const record of applied) {
					if (!files.some((f) => f.name === record.name)) {
						statuses.push({
							name: record.name,
							status: 'missing_file' as const,
							appliedAt: record.appliedAt,
						});
					}
				}

				if (options.json) {
					console.log(JSON.stringify(statuses, null, 2));
				} else {
					console.log('Migration Status');
					console.log(`   Database: ${redactDbUrl(options.db)}`);
					console.log(`   Directory: ${options.dir}`);
					console.log('');

					if (statuses.length === 0) {
						console.log('No migrations found.');
					} else {
						for (const s of statuses) {
							const icon =
								s.status === 'applied'
									? '✅'
									: s.status === 'pending'
										? '⏳'
										: s.status === 'checksum_mismatch'
											? '⚠️'
											: '❓';
							const detail =
								'appliedAt' in s && s.appliedAt
									? ` (applied: ${s.appliedAt.toISOString()})`
									: '';
							console.log(`  ${icon} ${s.name} — ${s.status}${detail}`);
						}

						const pendingCount = statuses.filter(
							(s) => s.status === 'pending',
						).length;
						const appliedCount = statuses.filter(
							(s) => s.status === 'applied',
						).length;

						console.log('');
						console.log(
							`Total: ${statuses.length} | Applied: ${appliedCount} | Pending: ${pendingCount}`,
						);
					}
				}
			});
		}),
	);

// ============================================================================
// Main Command
// ============================================================================

export const migrateCommand = new Command('migrate')
	.description('Database migration management')
	.addCommand(devCommand)
	.addCommand(applyCommand)
	.addCommand(rollbackCommand)
	.addCommand(statusCommand);
