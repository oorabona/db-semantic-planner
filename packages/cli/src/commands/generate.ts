/**
 * ARCH-002 Block 3+4+5: Generate Command
 *
 * dbsp generate <target> - Generate code from schema.
 *
 * Targets:
 * - manifest: Generate ModelIR manifest (JSON-serializable)
 * - kysely: Generate Kysely DB interface + types
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ResolvedSchema } from '@db-semantic-planner/schema';
import { Command } from 'commander';
import { generateKysely } from '../generators/kysely.js';
import { generateManifest } from '../generators/manifest.js';
import { loadSchema, loadSchemaFromCwd } from '../utils/schema-loader.js';

export const generateCommand = new Command('generate')
	.description('Generate code from schema')
	.argument('<target>', 'Target to generate: manifest | kysely')
	.option('-s, --schema <path>', 'Path to schema file (default: auto-detect)')
	.option('-o, --out <dir>', 'Output directory (default: ./generated/<target>)')
	.option('--output <dir>', 'Output directory (alias for --out)')
	.action(
		async (
			target: string,
			options: { schema?: string; out?: string; output?: string },
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

					default:
						console.error(`❌ Unknown target: ${target}`);
						console.error(`   Available targets: manifest, kysely`);
						process.exit(1);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`❌ ${message}`);
				process.exit(1);
			}
		},
	);
