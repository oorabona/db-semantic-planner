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
 * Try to dynamically import pg.
 * pg is an optional peer dependency.
 */
async function createDbConnection(connectionUrl: string) {
	try {
		const { default: pg } = await import('pg');

		const pool = new pg.Pool({
			connectionString: connectionUrl,
		});

		return { pool };
	} catch (_error) {
		throw new Error(
			'pg is required for introspect command. ' +
				'Install it with: pnpm add pg',
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
				const { pool } = await createDbConnection(options.db);

				try {
					// Import adapter from adapter-pgsql
					const { createPgsqlAdapter } = await import('@dbsp/adapter-pgsql');
					const adapter = createPgsqlAdapter(pool, {
						...(options.schemaName ? { schemaName: options.schemaName } : {}),
					});

					// Introspect the database (Phase 4 — may throw "Not implemented")
					const model = await adapter.introspect();

					// Report what we found
					const tableCount = model.tables.size;
					const relationCount = model.relations.size;

					console.log(
						`📊 Found ${tableCount} tables, ${relationCount} relations`,
					);
					console.log('');

					// Generate schema file
					const codegenOptions: SchemaCodegenOptions = {
						sourceUrl: options.db,
						includeDbTypeComments: options.dbTypeComments,
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
