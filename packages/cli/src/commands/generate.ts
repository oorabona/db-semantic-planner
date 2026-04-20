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

				// Validate dialect option
				const dialect = options.dialect ?? 'postgresql';
				if (dialect !== 'postgresql') {
					console.error(
						`⚠️  Warning: Only 'postgresql' dialect is currently supported. Using postgresql.`,
					);
				}

				// Generate based on target
				switch (target) {
					case 'ddl': {
						// Determine casing: explicit option > dialect default > 'snake'
						const casing = options.casing ?? 'snake';

						// Import adapter from adapter-pgsql (compile-only, no DB connection needed)
						const { createPgsqlCompileOnlyAdapter } = await import(
							'@dbsp/adapter-pgsql'
						);

						const dbCasing =
							casing === 'snake'
								? ('snake_case' as const)
								: ('preserve' as const);
						const adapter = createPgsqlCompileOnlyAdapter({
							dbCasing,
							...(options.schemaName ? { schemaName: options.schemaName } : {}),
						});

						{
							// ARCH-005: Use schema.model directly (already ModelIR)
							const ddlStatements = adapter.generateDDL(schema.model, {
								...(options.drop !== undefined && {
									includeDropStatements: options.drop,
								}),
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
						}
						break;
					}

					case 'manifest':
					case 'kysely':
						// EH-10: Throw instead of process.exit(1) inside try — outer catch handles exit
						throw new Error(
							`Target '${target}' has been removed in ARCH-005. ` +
								`These generators required the legacy defineSchema() format. ` +
								`Use 'ddl' target for SQL generation.`,
						);

					default:
						// EH-10: Throw instead of process.exit(1) inside try — outer catch handles exit
						throw new Error(
							`Unknown target: ${target}. Available targets: ddl`,
						);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`❌ ${message}`);
				process.exit(1);
			}
		},
	);
