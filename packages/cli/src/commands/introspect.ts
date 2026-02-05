/**
 * CLI-DDL: Introspect Command
 *
 * dbsp introspect - Generate schema.ts from database introspection.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import {
	generateSchemaFile,
	type SchemaCodegenOptions,
} from '../generators/schema-codegen.js';
import { createDbConnection, redactDbUrl } from '../utils/db-utils.js';

export const introspectCommand = new Command('introspect')
	.description('Generate schema.ts from database introspection')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('-o, --out <file>', 'Output schema file', './dbsp.schema.ts')
	.option('--schema-name <name>', 'Database schema name', 'public')
	.option(
		'--exclude <patterns>',
		'Tables to exclude (comma-separated glob patterns)',
		'_migrations,_prisma*,pg_*',
	)
	.option('--include <patterns>', 'Tables to include (comma-separated)')
	.option('--no-db-type-comments', 'Omit original DB type comments')
	.option(
		'--db-casing <casing>',
		'Database column casing (snake_case → camelCase in generated code)',
		'snake_case',
	)
	.action(
		async (options: {
			db: string;
			out: string;
			schemaName: string;
			exclude: string;
			include?: string;
			dbTypeComments: boolean;
			dbCasing: 'snake_case' | 'camelCase' | 'preserve';
		}) => {
			const redactedUrl = redactDbUrl(options.db);

			console.log(`🔍 Introspecting database: ${redactedUrl}`);
			console.log(`   Schema: ${options.schemaName}`);
			if (options.exclude) {
				console.log(`   Excluding: ${options.exclude}`);
			}
			console.log('');

			try {
				// Connect to database
				const { pool } = await createDbConnection(options.db);

				try {
					// Import introspect from adapter-pgsql
					const { introspect } = await import('@dbsp/adapter-pgsql');

					// Build introspection options from CLI flags
					const excludePatterns = options.exclude
						? options.exclude.split(',').map((s) => s.trim())
						: undefined;
					const includePatterns = options.include
						? options.include.split(',').map((s) => s.trim())
						: undefined;

					// Introspect the database directly (returns IntrospectedModelIR)
					const model = await introspect(pool, {
						schema: options.schemaName,
						...(excludePatterns ? { exclude: excludePatterns } : {}),
						...(includePatterns ? { include: includePatterns } : {}),
					});

					// Report what we found
					const tableCount = model.tables.size;
					const relationCount = model.relations.size;
					const hierarchyCount = model.hierarchies?.length ?? 0;

					console.log(
						`📊 Found ${tableCount} tables, ${relationCount} relations, ${hierarchyCount} hierarchies`,
					);
					if (model.warnings?.length) {
						for (const w of model.warnings) {
							console.log(`   ⚠️  ${w}`);
						}
					}
					console.log('');

					// Generate schema file — pass metadata from introspection
					const codegenOptions: SchemaCodegenOptions = {
						sourceUrl: options.db,
						includeDbTypeComments: options.dbTypeComments,
						warnings: model.warnings,
						introspectedAt: model.introspectedAt,
						dbCasing: options.dbCasing,
					};

					const schemaCode = generateSchemaFile(model, codegenOptions);

					// Write output file
					const outPath = resolve(process.cwd(), options.out);
					mkdirSync(dirname(outPath), { recursive: true });
					writeFileSync(outPath, schemaCode, 'utf-8');

					console.log(`✅ Generated schema: ${outPath}`);
					console.log(`   Tables: ${tableCount}`);
					console.log(`   Relations: ${relationCount}`);
				} finally {
					// Close database connection
					await pool.end();
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`❌ ${message}`);
				process.exit(1);
			}
		},
	);
