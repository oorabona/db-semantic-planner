/**
 * ARCH-002 Block 3+4+5: Generate Command
 * CLI-DDL: Added DDL generation target
 * ARCH-005: Migrated to schema() API, removed legacy generators
 *
 * dbsp generate <target> - Generate code from schema.
 *
 * Targets:
 * - ddl: Generate SQL DDL (CREATE TABLE statements)
 *
 * Deprecated targets (removed in ARCH-005):
 * - manifest: Was for legacy defineSchema() format
 * - kysely: Was for legacy defineSchema() format
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { loadSchema, loadSchemaFromCwd } from '../utils/schema-loader.js';

/** Default casing by dialect (follows database conventions) */
const DEFAULT_CASING: Record<string, 'snake' | 'camel'> = {
	postgresql: 'snake',
	mysql: 'snake',
	sqlite: 'snake',
	mssql: 'camel', // MSSQL convention is PascalCase, camel is close enough
};

export const generateCommand = new Command('generate')
	.description('Generate code from schema')
	.argument('<target>', 'Target to generate: ddl')
	.option('-s, --schema <path>', 'Path to schema file (default: auto-detect)')
	.option('-o, --out <dir>', 'Output directory (default: ./generated/<target>)')
	.option('--output <dir>', 'Output directory (alias for --out)')
	.option('--drop', 'Include DROP TABLE IF EXISTS statements (ddl only)')
	.option('--schema-name <name>', 'Database schema name (ddl only)')
	.option(
		'--dialect <name>',
		'Database dialect: postgresql | mysql | sqlite | mssql (default: postgresql)',
	)
	.option(
		'--casing <type>',
		'Column naming: snake | camel | none (default: based on dialect)',
	)
	.action(
		async (
			target: string,
			options: {
				schema?: string;
				out?: string;
				output?: string;
				drop?: boolean;
				schemaName?: string;
				dialect?: string;
				casing?: 'snake' | 'camel' | 'none';
			},
		) => {
			try {
				// Load schema (ARCH-005: only schema() format supported)
				let schema: Awaited<ReturnType<typeof loadSchema>>;
				let schemaPath: string;

				if (options.schema) {
					schema = await loadSchema(options.schema);
					schemaPath = options.schema;
				} else {
					const result = await loadSchemaFromCwd();
					schema = result.schema;
					schemaPath = result.path;
				}

				// For DDL without --output, we output to stdout so use stderr for info
				const outputPath = options.out ?? options.output;
				const useStdout = target === 'ddl' && !outputPath;
				const log = useStdout ? console.error : console.log;

				log(`📄 Loaded schema from: ${schemaPath}`);

				// Generate based on target
				switch (target) {
					case 'ddl': {
						// Dynamic import of Kysely and pg (optional peer deps)
						const { CamelCasePlugin, Kysely, PostgresDialect } = await import(
							'kysely'
						);
						const { default: pg } = await import('pg');

						// Determine casing: explicit option > dialect default > 'snake'
						const dialect = options.dialect ?? 'postgresql';
						const casing = options.casing ?? DEFAULT_CASING[dialect] ?? 'snake';

						// Create a Kysely instance with a mock pool (no actual connection)
						// This is sufficient for DDL generation which only builds SQL strings
						const mockPool = new pg.Pool({
							connectionString: 'postgresql://localhost/mock',
						});

						// Apply CamelCasePlugin for snake_case transformation
						const plugins = casing === 'snake' ? [new CamelCasePlugin()] : [];

						const db = new Kysely<unknown>({
							dialect: new PostgresDialect({ pool: mockPool }),
							plugins,
						});

						try {
							// Import generateDDL from adapter-kysely
							const { generateDDL } = await import('@dbsp/adapter-kysely');

							// ARCH-005: Use schema.model directly (already ModelIR)
							const ddlStatements = generateDDL(db, schema.model, {
								includeDropStatements: options.drop,
								schemaName: options.schemaName,
							});

							const ddlContent = ddlStatements.join('\n\n');
							const outputPath = options.out ?? options.output;

							if (outputPath) {
								// Write to file if --output is specified
								const outPath = outputPath.endsWith('.sql')
									? resolve(process.cwd(), outputPath)
									: resolve(process.cwd(), outputPath, 'schema.sql');

								mkdirSync(dirname(outPath), { recursive: true });
								writeFileSync(outPath, ddlContent, 'utf-8');

								console.log(`✅ Generated DDL: ${outPath}`);
								console.log(`   Tables: ${schema.tableNames.length}`);
								console.log(`   Statements: ${ddlStatements.length}`);
								console.log(`   Casing: ${casing}`);
								if (options.drop) {
									console.log(`   Includes DROP statements`);
								}
								if (options.schemaName) {
									console.log(`   Schema: ${options.schemaName}`);
								}
							} else {
								// Output DDL to stdout (for piping)
								// Info messages (schema loaded) went to stderr
								console.log(ddlContent);
							}
						} finally {
							await db.destroy();
							await mockPool.end();
						}
						break;
					}

					case 'manifest':
					case 'kysely':
						console.error(
							`❌ Target '${target}' has been removed in ARCH-005.`,
						);
						console.error(
							`   These generators required the legacy defineSchema() format.`,
						);
						console.error(`   Use 'ddl' target for SQL generation.`);
						process.exit(1);
						break;

					default:
						console.error(`❌ Unknown target: ${target}`);
						console.error(`   Available targets: ddl`);
						process.exit(1);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`❌ ${message}`);
				process.exit(1);
			}
		},
	);
