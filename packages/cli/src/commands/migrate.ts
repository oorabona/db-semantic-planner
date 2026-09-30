/** Execute the deliberately narrow, additive PostgreSQL convergence entry point. */

import type { PgPhysicalModel } from '@dbsp/adapter-pgsql';
import {
	type ConvergePgOptions,
	convergePg,
	createPgPhysicalModel,
	escapeDiagnosticText,
	type PgConvergeRefusal,
	PgConvergeRefusalError,
	type PgConvergeResult,
} from '@dbsp/adapter-pgsql';
import { Command } from 'commander';
import type { Pool } from 'pg';
import { createDbConnection } from '../utils/db-utils.js';
import { printCliJson } from '../utils/output.js';
import { type LoadedSchema, loadSchema } from '../utils/schema-loader.js';

export type MigrateFormat = 'text' | 'json';

export interface MigrateOptions {
	readonly db: string;
	readonly schemaFile: string;
	readonly schema?: string;
	readonly externalIndex?: readonly string[];
	readonly format?: MigrateFormat | string;
}

export const MIGRATE_OUTCOME_CONTRACT = [
	['no-drift', 0, 'database matches declaration'],
	['applied', 0, 'admitted additions or adoptions applied'],
	['partially-applied', 11, 'some target effects may be durable'],
	['busy', 21, 'ledger lock or claims are busy; retry later'],
	['database-read-only', 34, 'target cannot accept managed writes'],
	['load-failed', 27, 'schema file could not be loaded'],
	['migrate-failed', 29, 'migration, connection, or planning failure'],
	['adoption-refused', 62, 'declared adoption no longer matches live object'],
	[
		'recovery-required',
		64,
		'admitted claim remains open; reconcile before retrying',
	],
	[
		'transport-ambiguous',
		65,
		'admitted operation has ambiguous transport outcome',
	],
	[
		'invalid-options',
		70,
		'an --external-index or --format value is malformed, or convergePg refused its options',
	],
	['ledger-absent', 71, 'convergence ledger is not initialized'],
	['incompatible-ledger', 72, 'ledger version is unsupported'],
	['unsupported-server', 73, 'PostgreSQL server is unsupported'],
	['unsupported-change', 74, 'requested schema change is not admitted'],
	['unmanaged-object', 75, 'live object is not ledger-managed'],
	['unmanaged-parent', 76, 'parent live object is not ledger-managed'],
	['concurrent-drift', 77, 'live schema changed during admission'],
	['execution-refused', 78, 'admitted execution step was refused'],
	['cleanup-failed', 79, 'pool failed to close after convergence'],
] as const;

export type MigrateOutcome = (typeof MIGRATE_OUTCOME_CONTRACT)[number][0];

const migrateExitCodes = new Map<MigrateOutcome, number>(
	MIGRATE_OUTCOME_CONTRACT.map(([outcome, exitCode]) => [outcome, exitCode]),
);

export function exitCodeForMigrateOutcome(outcome: MigrateOutcome): number {
	return migrateExitCodes.get(outcome) as number;
}

const refusalOutcomes = {
	'invalid-options': 'invalid-options',
	'unsupported-change': 'unsupported-change',
	'unmanaged-object': 'unmanaged-object',
	'unmanaged-parent': 'unmanaged-parent',
	'concurrent-drift': 'concurrent-drift',
	'ledger-absent': 'ledger-absent',
	'incompatible-ledger': 'incompatible-ledger',
	'unsupported-server': 'unsupported-server',
	busy: 'busy',
	'recovery-required': 'recovery-required',
	'database-read-only': 'database-read-only',
	'execution-refused': 'execution-refused',
	'adoption-refused': 'adoption-refused',
	// dbsp migrate never supplies application steps, but preserve the closed converge map.
	'application-step-changed': 'migrate-failed',
	'application-step-failed': 'migrate-failed',
	// dbsp migrate never supplies initialize, but preserve the closed converge map.
	'initialization-refused': 'migrate-failed',
} as const satisfies Record<PgConvergeRefusal, MigrateOutcome>;

type ExternalIndex = NonNullable<ConvergePgOptions['externalIndexes']>[number];

export interface MigrateDeps {
	readonly loadSchema: (path: string) => Promise<LoadedSchema>;
	readonly createDbConnection: (db: string) => Promise<{ readonly pool: Pool }>;
	readonly converge: (
		pool: Pool,
		model: PgPhysicalModel,
		options: ConvergePgOptions,
	) => Promise<PgConvergeResult>;
}

const defaultMigrateDeps: MigrateDeps = {
	loadSchema,
	createDbConnection,
	converge: convergePg,
};

export interface MigrateResult {
	readonly outcome: MigrateOutcome;
	readonly exitCode: number;
	readonly schema: string;
	readonly schemaFile: string;
	readonly applied?: readonly string[];
	readonly completedStepKeys?: readonly string[];
	readonly notStartedStepKeys?: readonly string[];
	readonly detail?: string;
	readonly changes?: readonly {
		readonly kind: string;
		readonly table?: string;
		readonly column?: string;
		readonly details?: string;
	}[];
	readonly runIds?: readonly string[];
	readonly busyRunIds?: readonly string[];
	readonly executionIds?: readonly string[];
	readonly error?: string;
	readonly cleanupError?: string;
	readonly result?: PgConvergeResult;
}

function resolvedDeps(overrides?: Partial<MigrateDeps>): MigrateDeps {
	return { ...defaultMigrateDeps, ...overrides };
}

function describeThrown(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseExternalIndexes(
	entries: readonly string[] | undefined,
): readonly ExternalIndex[] | undefined {
	if (entries === undefined || entries.length === 0) return undefined;
	return entries.map((entry) => {
		const separator = entry.indexOf(':');
		if (separator <= 0 || separator === entry.length - 1)
			throw new Error(
				`invalid --external-index ${entry}; expected <table>:<index>`,
			);
		return {
			table: entry.slice(0, separator),
			name: entry.slice(separator + 1),
		};
	});
}

function resultForConverge(
	result: PgConvergeResult,
	schema: string,
	schemaFile: string,
): MigrateResult {
	switch (result.kind) {
		case 'no-drift':
		case 'applied':
			return {
				outcome: result.kind,
				exitCode: exitCodeForMigrateOutcome(result.kind),
				schema,
				schemaFile,
				applied: result.applied,
			};
		case 'partially-applied':
			return {
				outcome: result.kind,
				exitCode: exitCodeForMigrateOutcome(result.kind),
				schema,
				schemaFile,
				completedStepKeys: result.completedStepKeys,
				notStartedStepKeys: result.notStartedStepKeys,
				detail: result.detail,
			};
		case 'transport-ambiguous':
			return {
				outcome: result.kind,
				exitCode: exitCodeForMigrateOutcome(result.kind),
				schema,
				schemaFile,
				detail: result.detail,
			};
	}
	const unhandled: never = result;
	return unhandled;
}

function refusalResult(
	error: PgConvergeRefusalError,
	schema: string,
	schemaFile: string,
): MigrateResult {
	const outcome = refusalOutcomes[error.refusal];
	return {
		outcome,
		exitCode: exitCodeForMigrateOutcome(outcome),
		schema,
		schemaFile,
		changes: error.changes,
		...(error.detail === undefined ? {} : { detail: error.detail }),
		...(error.runIds === undefined ? {} : { runIds: error.runIds }),
		...(error.busyRunIds === undefined ? {} : { busyRunIds: error.busyRunIds }),
		...(error.executionIds === undefined
			? {}
			: { executionIds: error.executionIds }),
	};
}

function failureResult(
	outcome: 'invalid-options' | 'load-failed' | 'migrate-failed',
	error: unknown,
	schema: string,
	schemaFile: string,
): MigrateResult {
	return {
		outcome,
		exitCode: exitCodeForMigrateOutcome(outcome),
		schema,
		schemaFile,
		error: describeThrown(error),
	};
}

/** Execute converge once, preserving its refusal/result boundary as CLI outcomes. */
export async function runMigrate(
	schemaPath: string,
	options: Omit<MigrateOptions, 'schemaFile'>,
	overrides?: Partial<MigrateDeps>,
): Promise<MigrateResult> {
	const schema = options.schema ?? 'public';
	const deps = resolvedDeps(overrides);
	if (
		options.format !== undefined &&
		options.format !== 'text' &&
		options.format !== 'json'
	)
		return failureResult(
			'invalid-options',
			new Error(
				`unsupported migrate format ${options.format}; expected text or json`,
			),
			schema,
			schemaPath,
		);
	let externalIndexes: readonly ExternalIndex[] | undefined;
	try {
		externalIndexes = parseExternalIndexes(options.externalIndex);
	} catch (error) {
		return failureResult('invalid-options', error, schema, schemaPath);
	}
	let loaded: LoadedSchema;
	try {
		loaded = await deps.loadSchema(schemaPath);
	} catch (error) {
		return failureResult('load-failed', error, schema, schemaPath);
	}
	let pool: Pool;
	try {
		({ pool } = await deps.createDbConnection(options.db));
	} catch (error) {
		return failureResult('migrate-failed', error, schema, schemaPath);
	}
	let result: MigrateResult;
	let convergeResult: PgConvergeResult | undefined;
	try {
		const physical = createPgPhysicalModel({
			mode: 'logical',
			model: loaded.model,
			schema,
			...(loaded.dbCasing === undefined ? {} : { dbCasing: loaded.dbCasing }),
		});
		convergeResult = await deps.converge(pool, physical, {
			...(externalIndexes === undefined ? {} : { externalIndexes }),
		});
		result = resultForConverge(convergeResult, schema, schemaPath);
	} catch (error) {
		result =
			error instanceof PgConvergeRefusalError
				? refusalResult(error, schema, schemaPath)
				: failureResult('migrate-failed', error, schema, schemaPath);
	}
	try {
		await pool.end();
	} catch (error) {
		const cleanupError = describeThrown(error);
		if (result.exitCode === 0 && convergeResult !== undefined) {
			return {
				outcome: 'cleanup-failed',
				exitCode: exitCodeForMigrateOutcome('cleanup-failed'),
				schema,
				schemaFile: schemaPath,
				cleanupError,
				result: convergeResult,
			};
		}
		return { ...result, cleanupError };
	}
	return result;
}

function redactDiagnostic(value: string, db: string): string {
	const sensitive = new Set([db]);
	try {
		const url = new URL(db);
		const password = url.password;
		if (password) {
			sensitive.add(password);
			try {
				sensitive.add(decodeURIComponent(password));
			} catch {}
		}
		for (const password of url.searchParams.getAll('password'))
			sensitive.add(password);
		for (const pair of url.search.slice(1).split('&')) {
			const separator = pair.indexOf('=');
			const name = separator === -1 ? pair : pair.slice(0, separator);
			if (name !== 'password') continue;
			if (separator !== -1) sensitive.add(pair.slice(separator + 1));
		}
	} catch {
		const match = /:\/\/[^/:]+:([^@]+)@/.exec(db);
		if (match?.[1]) sensitive.add(match[1]);
	}
	return [...sensitive]
		.filter((entry) => entry.length > 0)
		.sort((left, right) => right.length - left.length)
		.reduce((text, entry) => text.replaceAll(entry, '<redacted>'), value);
}

function redactedConvergeResult(
	result: PgConvergeResult,
	db: string,
): PgConvergeResult {
	return result.kind === 'partially-applied' ||
		result.kind === 'transport-ambiguous'
		? { ...result, detail: redactDiagnostic(result.detail, db) }
		: result;
}

function redactedResult(result: MigrateResult, db: string): MigrateResult {
	return {
		...result,
		...(result.detail === undefined
			? {}
			: { detail: redactDiagnostic(result.detail, db) }),
		...(result.error === undefined
			? {}
			: { error: redactDiagnostic(result.error, db) }),
		...(result.cleanupError === undefined
			? {}
			: { cleanupError: redactDiagnostic(result.cleanupError, db) }),
		...(result.result === undefined
			? {}
			: { result: redactedConvergeResult(result.result, db) }),
	};
}

export function formatMigrateJson(result: MigrateResult, db: string) {
	const safe = redactedResult(result, db);
	const { schemaFile: _schemaFile, ...document } = safe;
	return document;
}

export function formatMigrateHuman(result: MigrateResult, db: string): string {
	const safe = redactedResult(result, db);
	const diagnostic = (value: string) => escapeDiagnosticText(value);
	const lines = [`${diagnostic(safe.outcome)}: ${diagnostic(safe.schema)}`];
	if (safe.applied?.length)
		for (const applied of safe.applied) lines.push(diagnostic(applied));
	if (safe.outcome === 'partially-applied') {
		const stepKeys = (entries: readonly string[] | undefined) =>
			entries?.length ? entries.map(diagnostic).join(', ') : 'none';
		lines.push(`completed: ${stepKeys(safe.completedStepKeys)}`);
		lines.push(`not started: ${stepKeys(safe.notStartedStepKeys)}`);
	}
	if (safe.detail !== undefined) lines.push(diagnostic(safe.detail));
	if (safe.changes?.length)
		for (const change of safe.changes)
			lines.push(diagnostic(JSON.stringify(change)));
	if (safe.outcome === 'recovery-required') {
		if (safe.runIds?.length) {
			lines.push('dbsp reconcile --db <database> <run-id>');
			for (const runId of safe.runIds)
				lines.push(`run id: ${diagnostic(runId)}`);
		}
		if (safe.busyRunIds?.length) {
			for (const busyRunId of safe.busyRunIds)
				lines.push(`busy run id: ${diagnostic(busyRunId)}`);
			lines.push('these runs are still executing; retry later');
		}
		if (safe.executionIds?.length) {
			for (const executionId of safe.executionIds)
				lines.push(`execution id: ${diagnostic(executionId)}`);
			lines.push(
				'no dbsp command resolves a claim by execution id; the owner named in the detail above must resolve these claims',
			);
		}
	}
	if (safe.outcome === 'ledger-absent')
		lines.push(
			'dbsp preflight --reinitialize --db <database> --schema-file <schema-file> --scope <schema> --out <adoption-file>',
			`schema file: ${diagnostic(safe.schemaFile)}`,
			`schema: ${diagnostic(safe.schema)}`,
		);
	if (safe.outcome === 'cleanup-failed' && safe.result !== undefined) {
		lines.push(`convergence: ${diagnostic(safe.result.kind)}`);
		if ('applied' in safe.result && safe.result.applied.length)
			for (const applied of safe.result.applied)
				lines.push(diagnostic(applied));
	}
	if (safe.error !== undefined) lines.push(diagnostic(safe.error));
	if (safe.cleanupError !== undefined)
		lines.push(`Connection cleanup failed: ${diagnostic(safe.cleanupError)}`);
	return lines.join('\n');
}

export const migrateCommand = new Command('migrate')
	.description(
		'Converge without confirmation: applies only additions and declared adoptions admitted by convergePg; refused changes send no DDL, but execution can still be refused or partially applied. Use dbsp plan plus dbsp apply for reviewed changes.',
	)
	.argument('<schema-file>', 'Schema DSL file')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('--schema <name>', 'Database schema name', 'public')
	.option(
		'--external-index <model-table:index>',
		'Physical index to leave alone; the table is the model name (before dbCasing maps it), then the index by its exact PostgreSQL name; the table part cannot contain :; repeatable.',
		(value: string, previous: string[] = []) => {
			previous.push(value);
			return previous;
		},
	)
	.option('--format <format>', 'Output format: text or json', 'text')
	.addHelpText(
		'after',
		`\nOutcome contract:\n${MIGRATE_OUTCOME_CONTRACT.map(([outcome, exitCode, description]) => `  ${outcome} (${exitCode}): ${description}`).join('\n')}\nCommand-line syntax errors (an unknown option, a missing --db or schema file) exit 1 with { status, error } under --format json, as for every dbsp command.`,
	)
	.exitOverride()
	.configureOutput({ writeErr: () => {} })
	.action(
		async (schemaFile: string, options: Omit<MigrateOptions, 'schemaFile'>) => {
			const result = await runMigrate(schemaFile, options);
			if (options.format === 'json')
				printCliJson(formatMigrateJson(result, options.db));
			else if (result.exitCode === 0)
				console.log(formatMigrateHuman(result, options.db));
			else console.error(formatMigrateHuman(result, options.db));
			process.exitCode = result.exitCode;
		},
	);
