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
 * - manifest: Removed legacy manifest generator
 * - kysely: Removed legacy Kysely generator
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DbCasing, DialectCapabilities } from '@dbsp/types';
import { Command } from 'commander';
import { loadSchema, loadSchemaFromCwd } from '../utils/schema-loader.js';

export type GenerateCasingOption = 'snake' | 'camel' | 'none';

const POSTGRESQL_VERSION_USAGE =
	'expected a PostgreSQL major version or dotted release version such as 14, 14.2, or 14.2.1; PostgreSQL 10 or later is supported';

export const generateCommand = new Command('generate')
	.description('Generate code from schema')
	.argument('<target>', 'Target to generate: ddl')
	.option('-s, --schema <path>', 'Path to schema file (default: auto-detect)')
	.option('-o, --out <dir>', 'Output directory (default: ./generated/<target>)')
	.option('--output <dir>', 'Output directory (alias for --out)')
	.option('--drop', 'Include DROP TABLE IF EXISTS statements (ddl only)')
	.option('--schema-name <name>', 'Database schema name (ddl only)')
	.option(
		'--postgresql-version <version>',
		'Target PostgreSQL major or dotted release version (for example, 14 or 14.2; ddl only)',
	)
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
				postgresqlVersion?: string;
				dialect?: string;
				casing?: GenerateCasingOption;
			},
		) => {
			try {
				// Reject the target BEFORE loading the schema: loading it executes the
				// user's schema module, and there is no reason to run their code for a
				// target we are going to refuse anyway.
				if (target === 'manifest' || target === 'kysely') {
					throw new Error(
						`Target '${target}' has been removed. ` +
							`Use 'ddl' for SQL generation, or the 'introspect' command to generate a schema file.`,
					);
				}
				if (target !== 'ddl') {
					throw new Error(`Unknown target: ${target}. Available targets: ddl`);
				}

				let targetDialectCapabilities: DialectCapabilities | undefined;
				if (options.postgresqlVersion !== undefined) {
					const { derivePostgresqlCapabilitiesForVersion } = await import(
						'@dbsp/adapter-pgsql'
					);
					try {
						targetDialectCapabilities = derivePostgresqlCapabilitiesForVersion(
							options.postgresqlVersion,
						);
					} catch (error) {
						const reason = error instanceof Error ? ` ${error.message}` : '';
						throw new Error(
							`Invalid --postgresql-version "${options.postgresqlVersion}": ${POSTGRESQL_VERSION_USAGE}.${reason}`,
						);
					}
				}

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
				if (!isDialectSupported(dialect)) {
					console.error(
						`⚠️  Warning: Only 'postgresql' dialect is currently supported. Using postgresql.`,
					);
				}

				// Generate based on target
				switch (target) {
					case 'ddl': {
						// Determine casing: explicit option > schema export > dialect default.
						const dbCasing =
							mapCasingToDbCasing(options.casing) ??
							schema.dbCasing ??
							('snake_case' as const);
						const casingLabel = formatGenerateCasingLabel(dbCasing);

						// Import adapter from adapter-pgsql (compile-only, no DB connection needed)
						const { createPgsqlCompileOnlyAdapter } = await import(
							'@dbsp/adapter-pgsql'
						);

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
								...(targetDialectCapabilities !== undefined && {
									dialectCapabilities: targetDialectCapabilities,
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
								console.log(`   Casing: ${casingLabel}`);
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
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`❌ ${message}`);
				process.exit(1);
			}
		},
	);

export function isDialectSupported(dialect: string): dialect is 'postgresql' {
	return dialect === 'postgresql';
}

export function mapCasingToDbCasing(
	casing: GenerateCasingOption | undefined,
): DbCasing | undefined {
	switch (casing) {
		case 'snake':
			return 'snake_case';
		case 'camel':
			return 'camelCase';
		case 'none':
			return 'preserve';
		default:
			return undefined;
	}
}

function formatGenerateCasingLabel(
	dbCasing: DbCasing,
): 'snake' | 'camel' | 'none' {
	switch (dbCasing) {
		case 'snake_case':
			return 'snake';
		case 'camelCase':
			return 'camel';
		case 'preserve':
			return 'none';
	}
}
