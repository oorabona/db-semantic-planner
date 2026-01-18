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
import type { ResolvedSchema } from '@dbsp/schema';
import { Command } from 'commander';
import { generateKysely } from '../generators/kysely.js';
import { generateManifest } from '../generators/manifest.js';
import { loadSchema, loadSchemaFromCwd } from '../utils/schema-loader.js';

export const generateCommand = new Command('generate')
	.description('Generate code from schema')
	.argument('<target>', 'Target to generate: manifest | kysely | ddl')
	.option('-s, --schema <path>', 'Path to schema file (default: auto-detect)')
	.option('-o, --out <dir>', 'Output directory (default: ./generated/<target>)')
	.option('--output <dir>', 'Output directory (alias for --out)')
	.option('--drop', 'Include DROP TABLE IF EXISTS statements (ddl only)')
	.option('--schema-name <name>', 'Database schema name (ddl only)')
	.action(
		async (
			target: string,
			options: {
				schema?: string;
				out?: string;
				output?: string;
				drop?: boolean;
				schemaName?: string;
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

				console.log(`📄 Loaded schema from: ${schemaPath}`);

				// Determine output directory
				const outDir = options.out ?? options.output ?? `./generated/${target}`;
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
						const { Kysely, PostgresDialect } = await import('kysely');
						const { default: pg } = await import('pg');

						// Create a Kysely instance with a mock pool (no actual connection)
						// This is sufficient for DDL generation which only builds SQL strings
						const mockPool = new pg.Pool({
							connectionString: 'postgresql://localhost/mock',
						});

						const db = new Kysely<unknown>({
							dialect: new PostgresDialect({ pool: mockPool }),
						});

						try {
							// Import generateDDL from adapter-kysely and defineSchema from core
							const { generateDDL } = await import('@dbsp/adapter-kysely');
							const { defineSchema: defineSchemaCore } = await import(
								'@dbsp/core'
							);

							// Convert ResolvedSchema tables to ModelIR using core's defineSchema
							// The table format is compatible between @dbsp/schema and @dbsp/core
							const model = defineSchemaCore(
								schema.tables as Parameters<typeof defineSchemaCore>[0],
							).build();

							const ddlStatements = generateDDL(db, model, {
								includeDropStatements: options.drop,
								schemaName: options.schemaName,
							});

							// Output path for DDL is a single file, not a directory
							const outPath = resolvedOutDir.endsWith('.sql')
								? resolvedOutDir
								: resolve(resolvedOutDir, 'schema.sql');

							mkdirSync(dirname(outPath), { recursive: true });
							writeFileSync(outPath, ddlStatements.join('\n\n'), 'utf-8');

							console.log(`✅ Generated DDL: ${outPath}`);
							console.log(`   Tables: ${Object.keys(schema.tables).length}`);
							console.log(`   Statements: ${ddlStatements.length}`);
							if (options.drop) {
								console.log(`   Includes DROP statements`);
							}
							if (options.schemaName) {
								console.log(`   Schema: ${options.schemaName}`);
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
