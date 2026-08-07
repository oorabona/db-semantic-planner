/** Separately privileged ledger cutover; it never routes through apply. */
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	type PgReinitializePreflightPool,
	runPgReinitializePreflight,
} from '@dbsp/adapter-pgsql';
import { declarationSetFromModel } from '@dbsp/core';
import type { DeclarationSet, ReinitializePreflightReport } from '@dbsp/types';
import { Command } from 'commander';
import { createDbConnection } from '../utils/db-utils.js';
import { loadSchema } from '../utils/schema-loader.js';

export interface PreflightOptions {
	readonly db: string;
	readonly schemaFile: string;
	readonly scopes: readonly string[];
	readonly reinitialize: boolean;
	readonly out: string;
}

interface CommanderPreflightOptions extends Omit<PreflightOptions, 'scopes'> {
	readonly scope: readonly string[];
}

export interface PreflightDeps {
	readonly createDbConnection: typeof createDbConnection;
	readonly loadSchema: typeof loadSchema;
}

const defaultDeps: PreflightDeps = { createDbConnection, loadSchema };

/** The only observable destination is `out`; the temporary name is never published. */
export async function writeAdoptionFileAtomically(
	out: string,
	report: ReinitializePreflightReport,
): Promise<void> {
	const tempDirectory = await mkdtemp(
		join(dirname(out), '.dbsp-reinitialize-'),
	);
	const tempPath = join(tempDirectory, 'adoption.json');
	try {
		await writeFile(
			tempPath,
			JSON.stringify(
				{
					version: 1,
					adoptions: report.adoptionCandidates,
				},
				null,
			),
			'utf8',
		);
		await rename(tempPath, out);
	} finally {
		await rm(tempDirectory, { recursive: true, force: true });
	}
}

async function databaseName(pool: {
	query(sql: string): Promise<{ rows: readonly Record<string, unknown>[] }>;
}): Promise<string> {
	const result = await pool.query(
		'SELECT pg_catalog.current_database() AS database',
	);
	const name = result.rows[0]?.database;
	if (typeof name !== 'string')
		throw new Error('current database could not be read');
	return name;
}

function declarationsForScopes(
	model: Awaited<ReturnType<typeof loadSchema>>['model'],
	database: string,
	scopes: readonly string[],
): DeclarationSet {
	const declarations = scopes.flatMap(
		(schema) =>
			declarationSetFromModel(model, { engine: 'postgresql', database, schema })
				.declarations,
	);
	// Database-scoped declarations (extensions) are shared by every tenant
	// model, while their home ledger is singular. Keep one exact declaration.
	const seen = new Set<string>();
	return {
		version: 1,
		digest: 'reinitialize-preflight-current-declaration-set',
		declarations: declarations.filter((declaration) => {
			const key = JSON.stringify([
				declaration.address.kind,
				declaration.address.schema ?? null,
				declaration.address.parent ?? null,
				declaration.address.name,
			]);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}),
	};
}

export async function runPreflight(
	options: PreflightOptions,
	deps: PreflightDeps = defaultDeps,
): Promise<ReinitializePreflightReport> {
	if (!options.reinitialize)
		throw new Error('dbsp preflight requires --reinitialize');
	if (!options.out)
		throw new Error('dbsp preflight --reinitialize requires --out <file>');
	if (options.scopes.length === 0)
		throw new Error(
			'dbsp preflight requires at least one explicit --scope <schema>',
		);
	const loaded = await deps.loadSchema(options.schemaFile);
	const connection = await deps.createDbConnection(options.db);
	try {
		const database = await databaseName(connection.pool);
		const declarations = declarationsForScopes(
			loaded.model,
			database,
			options.scopes,
		);
		return await runPgReinitializePreflight({
			pool: connection.pool as unknown as PgReinitializePreflightPool,
			schemas: options.scopes,
			declarations,
			writeAdoptionFile: (report) =>
				writeAdoptionFileAtomically(options.out, report),
		});
	} finally {
		await connection.pool.end();
	}
}

function formatScope(
	scope: ReinitializePreflightReport['scopes'][number],
): string {
	const name =
		scope.ledger.scope === 'database'
			? 'dbsp_meta'
			: (scope.ledger.schema ?? 'unknown');
	if (scope.outcome === 'failed')
		return `${name}: failed (${scope.reason.step}: ${scope.reason.message})`;
	return scope.refusal
		? `${name}: ${scope.outcome} (${scope.refusal.code}: ${scope.refusal.detail})`
		: `${name}: ${scope.outcome}`;
}

export const preflightCommand = new Command('preflight')
	.description(
		'Run the separately privileged managed-ledger reinitialize cutover',
	)
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.requiredOption(
		'--reinitialize',
		'Allow only the explicit reinitialize-preflight flow',
	)
	.requiredOption(
		'--out <file>',
		'Write adoption candidates to this exact file',
	)
	.requiredOption('--schema-file <path>', 'Current Schema DSL file')
	.requiredOption('--scope <schema...>', 'Explicit tenant schema scope list')
	.action(async (options: CommanderPreflightOptions) => {
		// This instruction deliberately precedes opening the database connection.
		console.log(
			'Before continuing, take a database dump. This reinitialize-preflight changes managed-ledger structures but appends no events.',
		);
		try {
			const report = await runPreflight({ ...options, scopes: options.scope });
			for (const scope of report.scopes) console.log(formatScope(scope));
			if (report.scopes.some((scope) => scope.outcome === 'failed')) {
				process.exitCode = 1;
				return;
			}
			console.log(
				`Wrote ${report.adoptionCandidates.length} adoption candidate(s) to ${options.out}.`,
			);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	});
