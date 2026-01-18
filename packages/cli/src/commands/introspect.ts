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

/**
 * Try to dynamically import Kysely and pg.
 * These are optional peer dependencies.
 */
async function createDbConnection(connectionUrl: string) {
	try {
		// Dynamic import of Kysely
		const { Kysely, PostgresDialect } = await import('kysely');
		const { default: pg } = await import('pg');

		const pool = new pg.Pool({
			connectionString: connectionUrl,
		});

		const db = new Kysely<unknown>({
			dialect: new PostgresDialect({ pool }),
		});

		return { db, pool };
	} catch (_error) {
		throw new Error(
			'kysely and pg are required for introspect command. ' +
				'Install them with: pnpm add kysely pg',
		);
	}
}

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
	.action(
		async (options: {
			db: string;
			out: string;
			schemaName: string;
			exclude: string;
			include?: string;
			dbTypeComments: boolean;
		}) => {
			// Redact password in URL for logging
			const redactedUrl = options.db.replace(/:[^:@]+@/, ':***@');

			console.log(`🔍 Introspecting database: ${redactedUrl}`);
			console.log(`   Schema: ${options.schemaName}`);
			if (options.exclude) {
				console.log(`   Excluding: ${options.exclude}`);
			}
			console.log('');

			try {
				// Connect to database
				const { db, pool } = await createDbConnection(options.db);

				try {
					// Import introspect from adapter-kysely
					const { introspect } = await import('@dbsp/adapter-kysely');

					// Parse exclude/include patterns
					const excludePatterns = options.exclude
						? options.exclude.split(',').map((p) => p.trim())
						: [];
					const includePatterns = options.include
						? options.include.split(',').map((p) => p.trim())
						: undefined;

					// Introspect the database
					// Note: We spread to build options to handle exactOptionalPropertyTypes
					const model = await introspect(db, {
						schema: options.schemaName,
						exclude: excludePatterns,
						...(includePatterns && { include: includePatterns }),
					});

					// Report what we found
					const tableCount = model.tables.size;
					const relationCount = model.relations.size;
					const warningCount = model.warnings.length;

					console.log(
						`📊 Found ${tableCount} tables, ${relationCount} relations`,
					);
					if (warningCount > 0) {
						console.log(`⚠️  ${warningCount} warnings (see generated file)`);
					}
					console.log('');

					// Generate schema file
					const codegenOptions: SchemaCodegenOptions = {
						sourceUrl: options.db,
						includeDbTypeComments: options.dbTypeComments,
						warnings: model.warnings,
						introspectedAt: model.introspectedAt,
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
					await db.destroy();
					await pool.end();
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`❌ ${message}`);
				process.exit(1);
			}
		},
	);
