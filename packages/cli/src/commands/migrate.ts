/**
 * Migrate Command — Migration Infrastructure
 *
 * dbsp migrate dev      - Generate migration from schema diff
 * dbsp migrate apply    - Apply pending migrations
 * dbsp migrate rollback - Roll back applied migrations
 * dbsp migrate status   - Show migration status
 */

import {
	acquireMigrationLock,
	compareSchemata,
	ensureMigrationsTable,
	generateMigrationFile,
	generateMigrationSQL,
	getAppliedMigrations,
	getNextSchemaVersion,
	introspect,
	isDestructiveDown,
	parseMigrationFile,
	recordMigration,
	releaseMigrationLock,
	removeMigrationRecord,
	withMigrationLock,
} from '@dbsp/adapter-pgsql';
import { Command } from 'commander';
import { executeDdl } from '../ddl-executor.js';
import {
	DEFAULT_MIGRATIONS_DIR,
	generateMigrationFilename,
	scanMigrationFiles,
	writeMigrationFile,
} from '../migration-file.js';
import { createDbConnection, redactDbUrl } from '../utils/db-utils.js';
import { loadSchema } from '../utils/schema-loader.js';

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
		async (options: {
			schema?: string;
			db: string;
			schemaName?: string;
			dir: string;
			name: string;
			allowDestructive?: boolean;
		}) => {
			const schemaPath = options.schema ?? 'dbsp.schema.ts';

			console.log(`📝 Generating migration: ${schemaPath}`);
			console.log(`   Database: ${redactDbUrl(options.db)}`);
			console.log('');

			try {
				const loaded = await loadSchema(schemaPath);
				const schemaModel = loaded.model;

				const { pool } = await createDbConnection(options.db);

				try {
					const dbModel = await introspect(pool, {
						...(options.schemaName ? { schema: options.schemaName } : {}),
					});

					const diff = compareSchemata(schemaModel, dbModel);

					if (diff.changes.length === 0) {
						console.log('✅ No changes detected — database matches schema.');
						process.exit(0);
					}

					// Check for destructive changes
					if (diff.hasDestructive && !options.allowDestructive) {
						const destructive = diff.changes.filter((c) => c.destructive);
						console.error(
							`❌ ${destructive.length} destructive change(s) detected:`,
						);
						for (const change of destructive) {
							console.error(`   - ${change.details}`);
						}
						console.error(
							'\nUse --allow-destructive to include these changes.',
						);
						process.exit(1);
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
						process.exit(0);
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

const applyCommand = new Command('apply')
	.description('Apply pending migrations')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('--dir <path>', 'Migrations directory', DEFAULT_MIGRATIONS_DIR)
	.option('--dry-run', 'Show pending migrations without applying')
	.action(async (options: { db: string; dir: string; dryRun?: boolean }) => {
		console.log('🔄 Applying migrations');
		console.log(`   Database: ${redactDbUrl(options.db)}`);
		console.log(`   Directory: ${options.dir}`);
		console.log('');

		try {
			const { pool } = await createDbConnection(options.db);

			try {
				// Ensure tracking table exists
				await ensureMigrationsTable(pool);

				// Acquire advisory lock
				await acquireMigrationLock(pool);

				try {
					// Get applied migrations
					const applied = await getAppliedMigrations(pool);
					const appliedMap = new Map(applied.map((m) => [m.name, m.checksum]));

					// Scan migration files
					const files = scanMigrationFiles(options.dir);

					if (files.length === 0) {
						console.log(`No migration files found in ${options.dir}`);
						process.exit(0);
					}

					// Validate checksums for already-applied migrations
					for (const file of files) {
						const existingChecksum = appliedMap.get(file.name);
						if (
							existingChecksum !== undefined &&
							existingChecksum !== file.checksum
						) {
							console.error(`❌ Checksum mismatch for ${file.name}`);
							console.error(`   Expected: ${existingChecksum}`);
							console.error(`   Got:      ${file.checksum}`);
							console.error(
								'\nMigration file has been tampered with after being applied.',
							);
							process.exit(1);
						}
					}

					// Find pending migrations
					const pending = files.filter((f) => !appliedMap.has(f.name));

					if (pending.length === 0) {
						console.log('✅ All migrations already applied.');
						process.exit(0);
					}

					if (options.dryRun) {
						console.log(`${pending.length} pending migration(s):`);
						for (const file of pending) {
							console.log(`   - ${file.name}`);
						}
						process.exit(0);
					}

					// Apply each pending migration
					let appliedCount = 0;
					for (const file of pending) {
						console.log(`  Applying: ${file.name}...`);

						// Parse UP section from file (v2 format)
						const parsed = parseMigrationFile(file.content);
						const statements = parsed.upStatements.filter(
							(s) => s.length > 0 && !s.startsWith('-- '),
						);

						await executeDdl(pool, statements);

						// Determine version and destructive flag
						const version = await getNextSchemaVersion(pool);
						const destructive = isDestructiveDown(parsed.upStatements);

						await recordMigration(
							pool,
							file.name,
							file.checksum,
							version,
							destructive,
						);
						appliedCount++;

						console.log(`  ✅ Applied: ${file.name}`);
					}

					console.log(
						`\n✅ ${appliedCount} migration(s) applied successfully.`,
					);
					process.exit(0);
				} finally {
					await releaseMigrationLock(pool);
				}
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
	});

const rollbackCommand = new Command('rollback')
	.description('Roll back applied migrations')
	.argument('<count>', 'Number of migrations to roll back')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('--dir <path>', 'Migrations directory', DEFAULT_MIGRATIONS_DIR)
	.option('--force', 'Force rollback of destructive or empty DOWN migrations')
	.action(
		async (
			countArg: string,
			options: { db: string; dir: string; force?: boolean },
		) => {
			const count = Number.parseInt(countArg, 10);
			if (Number.isNaN(count) || count < 1) {
				console.error('❌ Count must be a positive integer');
				process.exit(1);
			}

			console.log(`⏪ Rolling back ${count} migration(s)`);
			console.log(`   Database: ${redactDbUrl(options.db)}`);
			console.log(`   Directory: ${options.dir}`);
			console.log('');

			try {
				const { pool } = await createDbConnection(options.db);

				try {
					await ensureMigrationsTable(pool);

					await withMigrationLock(pool, async () => {
						// Get applied migrations, sorted by name DESC (most recent first)
						const applied = await getAppliedMigrations(pool);
						const sortedDesc = [...applied].sort((a, b) =>
							b.name.localeCompare(a.name),
						);

						// SC-18: Validate count
						if (count > sortedDesc.length) {
							console.error(
								`❌ Cannot roll back ${count} migration(s) — only ${sortedDesc.length} applied`,
							);
							process.exit(1);
						}

						const toRollback = sortedDesc.slice(0, count);

						// Load migration files from disk
						const files = scanMigrationFiles(options.dir);
						const fileMap = new Map(files.map((f) => [f.name, f]));

						let rolledBack = 0;
						for (const record of toRollback) {
							const file = fileMap.get(record.name);
							if (!file) {
								console.error(
									`❌ Migration file not found on disk: ${record.name}`,
								);
								process.exit(1);
							}

							// SC-17: Verify checksum
							if (file.checksum !== record.checksum) {
								console.error(`❌ Checksum mismatch for ${record.name}`);
								console.error(`   Expected: ${record.checksum}`);
								console.error(`   Got:      ${file.checksum}`);
								console.error(
									'\nMigration file has been modified since it was applied.',
								);
								process.exit(1);
							}

							// Parse DOWN section
							const parsed = parseMigrationFile(file.content);

							// SC-10/ERR-01: No DOWN section
							if (!parsed.hasDown) {
								console.error(
									`❌ Migration ${record.name} has no DOWN section`,
								);
								console.error(
									'   Cannot roll back a migration without a DOWN section.',
								);
								process.exit(1);
							}

							// SC-11/ERR-04: Empty DOWN section
							const downStmts = parsed.downStatements.filter(
								(s) => s.length > 0 && !s.startsWith('-- '),
							);
							if (downStmts.length === 0 && !options.force) {
								console.error(
									`❌ Migration ${record.name} has an empty DOWN section`,
								);
								console.error('   Use --force to roll back anyway.');
								process.exit(1);
							}

							// SC-19: Destructive DOWN check
							if (isDestructiveDown(parsed.downStatements) && !options.force) {
								console.error(
									`❌ Migration ${record.name} has destructive DOWN operations`,
								);
								console.error(
									'   Use --force to proceed with destructive rollback.',
								);
								process.exit(1);
							}

							// Execute DOWN SQL
							if (downStmts.length > 0) {
								console.log(`  Rolling back: ${record.name}...`);
								await executeDdl(pool, downStmts);
							}

							// Remove migration record
							await removeMigrationRecord(pool, record.name);
							rolledBack++;

							console.log(`  ✅ Rolled back: ${record.name}`);
						}

						console.log(
							`\n✅ ${rolledBack} migration(s) rolled back successfully.`,
						);
					});

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

const statusCommand = new Command('status')
	.description('Show migration status')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('--dir <path>', 'Migrations directory', DEFAULT_MIGRATIONS_DIR)
	.option('--json', 'Output as JSON')
	.action(async (options: { db: string; dir: string; json?: boolean }) => {
		try {
			const { pool } = await createDbConnection(options.db);

			try {
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
	});

// ============================================================================
// Main Command
// ============================================================================

export const migrateCommand = new Command('migrate')
	.description('Database migration management')
	.addCommand(devCommand)
	.addCommand(applyCommand)
	.addCommand(rollbackCommand)
	.addCommand(statusCommand);
