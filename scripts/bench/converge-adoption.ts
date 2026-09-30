/**
 * Manual benchmark for #852. Run:
 *   pnpm tsx scripts/bench/converge-adoption.ts [--tables 1,5,17,50] [--runs 5] [--out result.json]
 * PostgreSQL must be started with pg_stat_statements preloaded, for example:
 *   postgres -c shared_preload_libraries=pg_stat_statements
 *
 * This is deliberately not part of a test suite. Cleanup drops each generated
 * target schema CASCADE, which removes its schema-scoped ledger home and all
 * ledger rows. convergePg stores schema ledgers in their target schemas, so it
 * creates no benchmark-specific rows in the database-scoped dbsp_meta schema.
 */

import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
	convergePg,
	createPgPhysicalModel,
	generateDDL,
	type PgPhysicalModel,
} from '@dbsp/adapter-pgsql';
import type { ModelIR, TableIR } from '@dbsp/types';
import pg from 'pg';

type CaseName = 'fresh' | 'no-drift' | 'adopt';

type Statement = {
	readonly query: string;
	readonly calls: number;
	readonly totalExecTimeMs: number;
	readonly meanExecTimeMs: number;
};

type StatementProfile = {
	readonly calls: number;
	readonly totalExecTimeMs: number;
	readonly statements: readonly Statement[];
};

type TimedRun = {
	readonly wallMs: number;
	readonly profile: StatementProfile;
};

type CaseResult = {
	readonly runs: readonly { readonly wallMs: number }[];
	readonly medianMs: number;
	readonly minMs: number;
	readonly maxMs: number;
	readonly medianRunProfile: StatementProfile;
};

type BenchmarkResult = {
	readonly issue: 852;
	readonly generatedAt: string;
	readonly tables: readonly {
		readonly tableCount: number;
		readonly cases: Readonly<Record<CaseName, CaseResult>>;
	}[];
};

type Options = {
	readonly tables: readonly number[];
	readonly runs: number;
	readonly out?: string;
};

function usage(message: string): never {
	throw new Error(
		`${message}\nUsage: pnpm tsx scripts/bench/converge-adoption.ts [--tables 1,5,17,50] [--runs 5] [--out result.json]`,
	);
}

function parsePositiveIntegers(value: string, option: string): number[] {
	const values = value.split(',').map((part) => Number(part));
	if (
		values.length === 0 ||
		values.some((item) => !Number.isSafeInteger(item) || item < 1)
	)
		usage(`${option} must be a comma-separated list of positive integers`);
	return values;
}

function parseOptions(argv: readonly string[]): Options {
	let tables: readonly number[] = [1, 5, 17, 50];
	let runs = 5;
	let out: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const option = argv[index];
		const value = argv[index + 1];
		if (option === '--tables') {
			if (value === undefined) usage('--tables needs a value');
			tables = parsePositiveIntegers(value, '--tables');
			index += 1;
			continue;
		}
		if (option === '--runs') {
			if (value === undefined) usage('--runs needs a value');
			const parsed = parsePositiveIntegers(value, '--runs');
			const runCount = parsed[0];
			if (parsed.length !== 1 || runCount === undefined)
				usage('--runs must be one positive integer');
			runs = runCount;
			index += 1;
			continue;
		}
		if (option === '--out') {
			if (value === undefined || value.length === 0)
				usage('--out needs a file');
			out = value;
			index += 1;
			continue;
		}
		usage(`unknown option ${String(option)}`);
	}
	return { tables, runs, ...(out === undefined ? {} : { out }) };
}

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function benchmarkSchema(caseName: CaseName, tableCount: number): string {
	return `dbsp_bench_852_${caseName}_${tableCount}_${randomUUID().replaceAll('-', '')}`;
}

function model(tableCount: number): ModelIR {
	const tables: TableIR[] = [];
	for (let index = 0; index < tableCount; index += 1) {
		const name = `t${index}`;
		tables.push({
			name,
			columns: [
				{ name: 'id', type: 'integer', nullable: false },
				{ name: 'name', type: 'string', nullable: false },
				{ name: 'value', type: 'integer', nullable: true },
				{ name: 'parent_id', type: 'integer', nullable: true },
			],
			primaryKey: 'id',
			foreignKeys:
				index === 0
					? []
					: [
							{
								columns: ['parent_id'],
								references: { table: `t${index - 1}`, columns: ['id'] },
							},
						],
			indexes: [
				{ name: `${name}_parent_id_index`, columns: ['parent_id'] },
				{ name: `${name}_name_index`, columns: ['name'] },
			],
		});
	}
	const byName = new Map(tables.map((table) => [table.name, table]));
	return {
		tables: byName,
		sequences: new Map(),
		relations: new Map(),
		getTable: (name) => byName.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

function numberValue(value: unknown, name: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed))
		throw new Error(`pg_stat_statements returned invalid ${name}`);
	return parsed;
}

async function resetStatementStats(pool: pg.Pool): Promise<void> {
	await pool.query('SELECT pg_stat_statements_reset()');
}

async function readStatementProfile(pool: pg.Pool): Promise<StatementProfile> {
	const result = await pool.query<{
		readonly calls: unknown;
		readonly total_exec_time: unknown;
		readonly statements: unknown;
	}>(`
		WITH database_statements AS (
			SELECT query, calls, total_exec_time, mean_exec_time
			FROM pg_stat_statements
			WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
		), totals AS (
			SELECT COALESCE(sum(calls), 0) AS calls,
				COALESCE(sum(total_exec_time), 0) AS total_exec_time
			FROM database_statements
		), slowest AS (
			SELECT COALESCE(json_agg(row_to_json(statement)), '[]'::json) AS statements
			FROM (
				SELECT left(query, 200) AS query, calls, total_exec_time, mean_exec_time
				FROM database_statements
				ORDER BY total_exec_time DESC
				LIMIT 15
			) AS statement
		)
		SELECT totals.calls, totals.total_exec_time, slowest.statements
		FROM totals CROSS JOIN slowest
	`);
	const row = result.rows[0];
	if (!row || !Array.isArray(row.statements))
		throw new Error('pg_stat_statements returned no statement profile');
	const statements = row.statements.map((statement): Statement => {
		if (statement === null || typeof statement !== 'object')
			throw new Error('pg_stat_statements returned an invalid statement');
		const values = statement as Record<string, unknown>;
		if (typeof values.query !== 'string')
			throw new Error(
				'pg_stat_statements returned a statement without query text',
			);
		return {
			query: values.query,
			calls: numberValue(values.calls, 'statement calls'),
			totalExecTimeMs: numberValue(
				values.total_exec_time,
				'statement total_exec_time',
			),
			meanExecTimeMs: numberValue(
				values.mean_exec_time,
				'statement mean_exec_time',
			),
		};
	});
	return {
		calls: numberValue(row.calls, 'total calls'),
		totalExecTimeMs: numberValue(row.total_exec_time, 'total_exec_time'),
		statements,
	};
}

async function timedConverge(
	pool: pg.Pool,
	physical: PgPhysicalModel,
	caseName: CaseName,
): Promise<TimedRun> {
	await resetStatementStats(pool);
	const startedAt = performance.now();
	const result = await convergePg(pool, physical, {
		...(caseName === 'fresh'
			? { initialize: 'pristine' as const }
			: caseName === 'adopt'
				? { initialize: 'adopt-existing' as const }
				: {}),
	});
	const wallMs = performance.now() - startedAt;
	const profile = await readStatementProfile(pool);
	const expectedKind = caseName === 'no-drift' ? 'no-drift' : 'applied';
	if (result.kind !== expectedKind)
		throw new Error(
			`unexpected ${caseName} converge result: ${JSON.stringify(result)}`,
		);
	return { wallMs, profile };
}

async function createSchema(pool: pg.Pool, schema: string): Promise<void> {
	await pool.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
}

async function createAdoptedTables(
	pool: pg.Pool,
	physical: PgPhysicalModel,
): Promise<void> {
	for (const statement of generateDDL(physical))
		await pool.query(statement);
}

function summarize(runs: readonly TimedRun[]): CaseResult {
	if (runs.length === 0) throw new Error('cannot summarize zero runs');
	const sorted = [...runs].sort((left, right) => left.wallMs - right.wallMs);
	const middle = Math.floor(sorted.length / 2);
	const first = sorted[0];
	const lowerMiddle = sorted[Math.max(middle - 1, 0)];
	const upperMiddle = sorted[middle];
	const last = sorted.at(-1);
	if (
		first === undefined ||
		lowerMiddle === undefined ||
		upperMiddle === undefined ||
		last === undefined
	)
		throw new Error('sorted benchmark runs unexpectedly had no median');
	const medianMs =
		sorted.length % 2 === 1
			? upperMiddle.wallMs
			: (lowerMiddle.wallMs + upperMiddle.wallMs) / 2;
	const medianRun = sorted.reduce((closest, candidate) =>
		Math.abs(candidate.wallMs - medianMs) < Math.abs(closest.wallMs - medianMs)
			? candidate
			: closest,
	);
	return {
		runs: runs.map(({ wallMs }) => ({ wallMs })),
		medianMs,
		minMs: first.wallMs,
		maxMs: last.wallMs,
		medianRunProfile: medianRun.profile,
	};
}

async function ensurePgStatStatements(pool: pg.Pool): Promise<void> {
	const instruction =
		' Start PostgreSQL with -c shared_preload_libraries=pg_stat_statements.';
	try {
		await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
	} catch (error) {
		throw new Error(
			`pg_stat_statements is required: CREATE EXTENSION IF NOT EXISTS pg_stat_statements failed: ${error instanceof Error ? error.message : String(error)}.${instruction}`,
		);
	}
	const result = await pool.query<{
		readonly shared_preload_libraries: string;
	}>('SHOW shared_preload_libraries');
	const loaded = (result.rows[0]?.shared_preload_libraries ?? '')
		.split(',')
		.map((library) => library.trim())
		.includes('pg_stat_statements');
	if (!loaded)
		throw new Error(
			`pg_stat_statements is required but missing from shared_preload_libraries.${instruction}`,
		);
}

function formatMs(value: number): string {
	return value.toFixed(2);
}

function printSummary(result: BenchmarkResult): void {
	console.error(
		'N\tcase\tmedian ms\tmin ms\tmax ms\tstatement calls\tdatabase ms',
	);
	for (const entry of result.tables) {
		for (const caseName of ['fresh', 'no-drift', 'adopt'] as const) {
			const summary = entry.cases[caseName];
			console.error(
				[
					entry.tableCount,
					caseName,
					formatMs(summary.medianMs),
					formatMs(summary.minMs),
					formatMs(summary.maxMs),
					summary.medianRunProfile.calls,
					formatMs(summary.medianRunProfile.totalExecTimeMs),
				].join('\t'),
			);
		}
	}
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl)
		throw new Error(
			'DATABASE_URL is required to run the converge adoption benchmark.',
		);
	const pool = new pg.Pool({ connectionString: databaseUrl });
	const schemas = new Set<string>();
	let benchmarkFailed = false;
	try {
		await ensurePgStatStatements(pool);
		const tables: BenchmarkResult['tables'][number][] = [];
		for (const tableCount of options.tables) {
			const modelIr = model(tableCount);
			const freshRuns: TimedRun[] = [];
			const noDriftRuns: TimedRun[] = [];
			const adoptRuns: TimedRun[] = [];
			for (let run = 0; run < options.runs; run += 1) {
				const freshSchema = benchmarkSchema('fresh', tableCount);
				schemas.add(freshSchema);
				await createSchema(pool, freshSchema);
				const freshPhysical = createPgPhysicalModel({
					mode: 'logical',
					model: modelIr,
					schema: freshSchema,
				});
				freshRuns.push(
					await timedConverge(pool, freshPhysical, 'fresh'),
				);
				noDriftRuns.push(
					await timedConverge(pool, freshPhysical, 'no-drift'),
				);

				const adoptSchema = benchmarkSchema('adopt', tableCount);
				schemas.add(adoptSchema);
				await createSchema(pool, adoptSchema);
				const adoptPhysical = createPgPhysicalModel({
					mode: 'logical',
					model: modelIr,
					schema: adoptSchema,
				});
				await createAdoptedTables(pool, adoptPhysical);
				adoptRuns.push(
					await timedConverge(pool, adoptPhysical, 'adopt'),
				);
			}
			tables.push({
				tableCount,
				cases: {
					fresh: summarize(freshRuns),
					'no-drift': summarize(noDriftRuns),
					adopt: summarize(adoptRuns),
				},
			});
		}
		const result: BenchmarkResult = {
			issue: 852,
			generatedAt: new Date().toISOString(),
			tables,
		};
		const document = `${JSON.stringify(result, null, 2)}\n`;
		if (options.out === undefined) process.stdout.write(document);
		else await writeFile(options.out, document, 'utf8');
		printSummary(result);
	} catch (error) {
		benchmarkFailed = true;
		throw error;
	} finally {
		const cleanupFailures: unknown[] = [];
		for (const schema of schemas) {
			try {
				await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
			} catch (error) {
				cleanupFailures.push(error);
			}
		}
		try {
			await pool.end();
		} catch (error) {
			cleanupFailures.push(error);
		}
		if (cleanupFailures.length > 0) {
			console.error(
				`benchmark cleanup failed for ${cleanupFailures.length} operation(s):`,
			);
			for (const error of cleanupFailures) console.error(error);
			if (!benchmarkFailed) process.exitCode = 1;
		}
	}
}

await main();
