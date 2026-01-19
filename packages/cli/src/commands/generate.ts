/**
 * ARCH-002 Block 3+4+5: Generate Command
 * CLI-DDL: Added DDL generation target
 *
 * dbsp generate <target> - Generate code from schema.
 *
 * Targets:
 * - manifest: Generate ModelIR manifest (JSON-serializable)
 * - kysely: Generate Kysely DB interface + types
 * - ddl: Generate SQL DDL (CREATE TABLE statements)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ResolvedSchema } from '@dbsp/core';
import { Command } from 'commander';
import { generateKysely } from '../generators/kysely.js';
import { generateManifest } from '../generators/manifest.js';
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
	.argument('<target>', 'Target to generate: manifest | kysely | ddl')
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
				// Load schema
				let schema: ResolvedSchema;
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

				// Determine output directory (only used when writing to file)
				const outDir = outputPath ?? `./generated/${target}`;
				const resolvedOutDir = resolve(process.cwd(), outDir);

				// Generate based on target
				switch (target) {
					case 'manifest': {
						const manifest = generateManifest(schema);
						const outPath = resolve(resolvedOutDir, 'schema.json');

						mkdirSync(dirname(outPath), { recursive: true });
						writeFileSync(outPath, manifest.json, 'utf-8');

						console.log(`✅ Generated manifest: ${outPath}`);
						console.log(`   Tables: ${Object.keys(schema.tables).length}`);
						console.log(
							`   Relations: ${Object.keys(schema.relations).length}`,
						);
						break;
					}

					case 'kysely': {
						const kysely = generateKysely(schema);

						mkdirSync(resolvedOutDir, { recursive: true });

						const dbPath = resolve(resolvedOutDir, 'DB.ts');
						const typesPath = resolve(resolvedOutDir, 'types.ts');

						writeFileSync(dbPath, kysely.dbInterface, 'utf-8');
						writeFileSync(typesPath, kysely.tableTypes, 'utf-8');

						console.log(`✅ Generated Kysely types:`);
						console.log(`   ${dbPath}`);
						console.log(`   ${typesPath}`);
						break;
					}

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
							// Import generateDDL from adapter-kysely and defineSchemaBuilder from core
							const { generateDDL } = await import('@dbsp/adapter-kysely');
							const { defineSchemaBuilder } = await import('@dbsp/core');

							// Convert ResolvedSchema tables to ModelIR using defineSchemaBuilder
							const model = defineSchemaBuilder(
								schema.tables as Parameters<typeof defineSchemaBuilder>[0],
							).build();

							const ddlStatements = generateDDL(db, model, {
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
								console.log(`   Tables: ${Object.keys(schema.tables).length}`);
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

					default:
						console.error(`❌ Unknown target: ${target}`);
						console.error(`   Available targets: manifest, kysely, ddl`);
						process.exit(1);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`❌ ${message}`);
				process.exit(1);
			}
		},
	);
