import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LedgerChainMember, LedgerReservationRow } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import {
	acquirePgLedgerLocks,
	appendPgLedgerClaim,
	appendPgLedgerClaimGroup,
	appendPgLedgerResolution,
	appendPgLedgerResolutionGroup,
	assertPgLedgerPhysicalShapeVerified,
	classifyPgLedgerShapeError,
	createPgLedgerShapeAllowance,
	ensurePgLedger,
	hasPgLedgerCandidateFingerprint,
	PG_LEDGER_MIN_SERVER_VERSION_NUM,
	PgLedgerPhysicalShapeValidationError,
	PgLedgerStorageUnsupportedError,
	readPgLedgerReservationsForPair,
	renderCreateLedgerEventTableSql,
	validatePgLedgerPhysicalShape,
} from './ledger.js';
import {
	generatePgLedgerExpectedManifest,
	PG_LEDGER_CONSTRAINT_PROPERTIES,
	PG_LEDGER_IMMUTABILITY_TRIGGER_SPEC,
	PG_LEDGER_SPEC,
	renderCreateLedgerImmutabilityFunctionFromSpec,
	renderCreateLedgerImmutabilityTriggerFromSpec,
	renderCreateLedgerIndexFromSpec,
	renderCreateLedgerTableFromSpec,
} from './ledger-spec.js';

const target = { scope: 'schema', schema: 'tenant_a' } as const;

const ledgerDeparseFixtureDirectory = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'ledger-deparse-fixtures',
);

function assertNonEmptyStringRecord(value: unknown, field: string): void {
	expect(value, `${field} must be an object`).toBeTypeOf('object');
	expect(value, `${field} must not be null`).not.toBeNull();
	expect(Array.isArray(value), `${field} must not be an array`).toBe(false);
	const entries = Object.entries(value as Record<string, unknown>);
	expect(entries, `${field} must not be empty`).not.toHaveLength(0);
	for (const [key, entry] of entries) {
		expect(key, `${field} record key must not be empty`).not.toBe('');
		expect(entry, `${field}.${key} must be a string`).toBeTypeOf('string');
	}
}

function sorted<T>(values: Iterable<T>): T[] {
	return [...values].sort();
}

function tableBody(sql: string): string {
	const opening = sql.indexOf('(');
	if (opening < 0 || !sql.endsWith(')'))
		throw new Error(`not a CREATE TABLE statement: ${sql}`);
	return sql.slice(opening + 1, -1);
}

/** Split a CREATE TABLE body without confusing CHECK expression commas. */
function splitTopLevelSqlList(sql: string): string[] {
	const values: string[] = [];
	let start = 0;
	let depth = 0;
	let quoted = false;
	for (let index = 0; index < sql.length; index += 1) {
		const character = sql[index]!;
		if (character === "'") {
			if (quoted && sql[index + 1] === "'") {
				index += 1;
				continue;
			}
			quoted = !quoted;
			continue;
		}
		if (quoted) continue;
		if (character === '(') depth += 1;
		else if (character === ')') depth -= 1;
		else if (character === ',' && depth === 0) {
			values.push(sql.slice(start, index).trim());
			start = index + 1;
		}
	}
	values.push(sql.slice(start).trim());
	return values;
}

function renderedTableDeclarations() {
	return PG_LEDGER_SPEC.map((definition) => ({
		definition,
		sql: renderCreateLedgerTableFromSpec(target, definition),
	}));
}

const claim: Omit<LedgerChainMember, 'controller' | 'recordedAt'> = {
	eventId: 'claim-1',
	address: {
		scope: 'schema',
		engine: 'postgresql',
		database: 'app',
		schema: 'tenant_a',
		kind: 'table',
		name: 'accounts',
	},
	eventKind: 'intent',
};

const reservation: LedgerReservationRow = {
	address: claim.address,
	claimKind: 'intent',
	executionId: 'execution-1',
	rootClaimId: 'claim-1',
	homeLedger: target,
};

/** Catalog facts that are normalization-independent and protect chain closure. */
function createdLedgerTableRows() {
	return PG_LEDGER_SPEC.map(({ name }) => ({
		table_name: name,
		relation_kind: 'r',
	}));
}

function createdLedgerColumnRows() {
	return PG_LEDGER_SPEC.flatMap((definition) =>
		definition.columns.map((column) => ({
			table_name: definition.name,
			column_name: column.name,
			column_type: column.type,
			is_not_null: !column.nullable,
		})),
	);
}

function createdLedgerDefaultRows() {
	return PG_LEDGER_SPEC.flatMap((definition) =>
		definition.columns
			.filter((column) => column.defaultSql !== undefined)
			.map((column) => ({
				table_name: definition.name,
				column_name: column.name,
				default_definition: column.defaultSql,
			})),
	);
}

function createdLedgerInvariantConstraintRows() {
	const checkKeyColumns: Readonly<Record<string, readonly string[]>> = {
		dbsp_ledger_event_kind_closed: ['event_kind'],
		dbsp_ledger_declared_digest_pair: ['declared', 'declared_digest'],
		dbsp_ledger_observed_digest_pair: ['observed', 'observed_digest'],
		dbsp_ledger_refusal_payload: [
			'event_kind',
			'refusal_code',
			'refusal_cause',
			'refusal_state',
			'refusal_withheld_authority',
			'refusal_resolving_command',
		],
		dbsp_ledger_reservation_claim_kind_check: ['claim_kind'],
		dbsp_ledger_reservation_home_ledger_scope_check: ['home_ledger_scope'],
		dbsp_ledger_reservation_check: ['home_ledger_scope', 'home_ledger_schema'],
		dbsp_ledger_identity_id_check: ['id'],
		dbsp_ledger_marker_id_check: ['id'],
		dbsp_ledger_marker_version_check: ['version'],
	};
	return PG_LEDGER_SPEC.flatMap((definition) =>
		definition.constraints.map((constraint) => ({
			table_name: definition.name,
			constraint_name: constraint.name,
			check_expression: undefined,
			contype: constraint.type,
			// PG 18 exposes NULL for an index property when conindid is zero.
			connullsnotdistinct:
				constraint.type === 'p' || constraint.type === 'u'
					? (constraint.nullsNotDistinct ?? false)
					: null,
			key_columns:
				constraint.type === 'c'
					? (checkKeyColumns[constraint.name] ?? [])
					: (constraint.columns ?? []),
			referenced_table_name: constraint.referencedTable ?? null,
			referenced_table_schema: constraint.referencedTable ? 'tenant_a' : null,
			referenced_columns: constraint.referencedColumns ?? [],
			confupdtype: constraint.type === 'f' ? 'a' : ' ',
			confdeltype: constraint.type === 'f' ? 'a' : ' ',
			condeferrable: PG_LEDGER_CONSTRAINT_PROPERTIES.deferrable,
			condeferred: PG_LEDGER_CONSTRAINT_PROPERTIES.initiallyDeferred,
			convalidated: PG_LEDGER_CONSTRAINT_PROPERTIES.validated,
		})),
	);
}

function createdLedgerTerminalIndexRows() {
	return PG_LEDGER_SPEC.flatMap((definition) =>
		(definition.indexes ?? []).map((index) => ({
			table_name: definition.name,
			index_name: index.name,
			indisprimary: false,
			indisunique: index.unique,
			indisvalid: index.valid,
			indisready: index.ready,
			index_columns: index.columns,
		})),
	);
}

function createdLedgerImmutabilityTriggerRows() {
	const spec = PG_LEDGER_IMMUTABILITY_TRIGGER_SPEC;
	return [
		{
			table_schema: 'tenant_a',
			table_name: 'dbsp_ledger_event',
			trigger_name: spec.name,
			trigger_enabled: spec.enabled,
			// PG 18's tgtype includes the row-trigger bit for FOR EACH ROW.
			trigger_type: '31',
			trigger_arguments: spec.arguments,
			trigger_deferrable: spec.deferrable,
			trigger_initially_deferred: spec.initiallyDeferred,
			function_name: spec.functionName,
			function_schema: 'tenant_a',
			function_identity_arguments: spec.functionIdentityArguments,
			function_result: spec.functionResult,
			function_language: spec.functionLanguage,
			function_kind: spec.functionKind,
			function_volatility: spec.functionVolatility,
			function_is_strict: spec.functionIsStrict,
			function_is_security_definer: spec.functionIsSecurityDefiner,
			function_is_leakproof: spec.functionIsLeakproof,
			function_config_is_null: spec.functionConfigIsNull,
			function_source: spec.functionBody,
			trigger_definition: 'CREATE TRIGGER dbsp_ledger_event_immutable',
		},
	];
}

/**
 * A PG 18 catalogue projection of the DDL rendered by this module.  Keep this
 * independent from the comparator's expected-set construction: it includes
 * every constraint family and every pg_index row that CREATE TABLE produces.
 */
function createdLedgerDdlLiveProjection() {
	const checks: Readonly<Record<string, string>> = {
		'dbsp_ledger_event.dbsp_ledger_declared_digest_pair':
			'((declared IS NULL) = (declared_digest IS NULL))',
		'dbsp_ledger_event.dbsp_ledger_event_kind_closed':
			"(event_kind = ANY (ARRAY['adopt-intent'::text, 'adopt'::text, 'intent'::text, 'retire-intent'::text, 'readdress-intent'::text, 'refused'::text, 'executing'::text, 'observed'::text, 'absent'::text, 'indeterminate'::text, 'resolved'::text, 'readdressed-to'::text, 'readdressed-from'::text, 'released'::text]))",
		'dbsp_ledger_event.dbsp_ledger_observed_digest_pair':
			'((observed IS NULL) = (observed_digest IS NULL))',
		'dbsp_ledger_event.dbsp_ledger_refusal_payload':
			"((event_kind = 'refused'::text) = ((refusal_code IS NOT NULL) AND (refusal_cause IS NOT NULL) AND (refusal_state IS NOT NULL) AND (refusal_withheld_authority IS NOT NULL) AND (refusal_resolving_command IS NOT NULL)))",
		'dbsp_ledger_identity.dbsp_ledger_identity_id_check': 'id',
		'dbsp_ledger_marker.dbsp_ledger_marker_id_check': 'id',
		'dbsp_ledger_marker.dbsp_ledger_marker_version_check': '(version >= 1)',
		'dbsp_ledger_reservation.dbsp_ledger_reservation_check':
			"(((home_ledger_scope = 'database'::text) AND (home_ledger_schema IS NULL)) OR ((home_ledger_scope = 'schema'::text) AND (home_ledger_schema IS NOT NULL)))",
		'dbsp_ledger_reservation.dbsp_ledger_reservation_claim_kind_check':
			"(claim_kind = ANY (ARRAY['adopt-intent'::text, 'intent'::text, 'retire-intent'::text, 'readdress-intent'::text]))",
		'dbsp_ledger_reservation.dbsp_ledger_reservation_home_ledger_scope_check':
			"(home_ledger_scope = ANY (ARRAY['schema'::text, 'database'::text]))",
	};
	const defaults: Readonly<Record<string, string>> = {
		'dbsp_ledger_event.controller': 'CURRENT_USER',
		'dbsp_ledger_event.controller_oid': '((CURRENT_USER)::regrole)::oid',
		'dbsp_ledger_event.recorded_at': 'now()',
		'dbsp_ledger_identity.id': 'true',
		'dbsp_ledger_marker.id': 'true',
	};
	const constraints = createdLedgerInvariantConstraintRows().map((row) => ({
		...row,
		check_expression:
			row.contype === 'c'
				? checks[`${row.table_name}.${row.constraint_name}`]
				: undefined,
	}));
	return {
		tables: createdLedgerTableRows(),
		columns: createdLedgerColumnRows(),
		defaults: createdLedgerDefaultRows().map((row) => ({
			...row,
			default_definition: defaults[`${row.table_name}.${row.column_name}`],
		})),
		constraints,
		indexes: createdLedgerTerminalIndexRows(),
		triggers: createdLedgerImmutabilityTriggerRows(),
	};
}

describe('managed ledger storage', () => {
	it('validates a live projection identical to the generated DDL product', async () => {
		const live = createdLedgerDdlLiveProjection();
		const query = vi.fn(async (sql: string) => {
			if (
				sql ===
				"SELECT current_setting('server_version_num') AS server_version_num"
			)
				return { rows: [{ server_version_num: '180000' }] };
			if (sql.includes('FROM pg_catalog.pg_constraint'))
				return { rows: live.constraints };
			if (sql.includes('FROM pg_catalog.pg_attrdef default_item'))
				return { rows: live.defaults };
			if (sql.includes('FROM pg_catalog.pg_trigger trigger_item'))
				return { rows: live.triggers };
			if (sql.includes('FROM pg_catalog.pg_index index_definition'))
				return { rows: live.indexes };
			if (sql.includes('FROM pg_catalog.pg_attribute attribute'))
				return { rows: live.columns };
			if (
				sql.includes(
					'FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace',
				)
			)
				return { rows: live.tables };
			return { rows: [] };
		});

		await expect(
			validatePgLedgerPhysicalShape({ query }, target),
		).resolves.toBeUndefined();
	});

	it('admits only the factory-registered full trigger identity', async () => {
		const live = createdLedgerDdlLiveProjection();
		let triggers = [
			...live.triggers,
			{
				...live.triggers[0],
				trigger_name: 'harness_probe_trigger',
				function_name: 'harness_probe_function',
				function_source: 'BEGIN RETURN NEW; END',
				trigger_definition:
					'CREATE TRIGGER harness_probe_trigger BEFORE INSERT ON tenant_a.dbsp_ledger_event FOR EACH ROW WHEN ((new.event_id IS NOT NULL)) EXECUTE FUNCTION tenant_a.harness_probe_function()',
			},
		];
		const query = vi.fn(async (sql: string) => {
			if (
				sql ===
				"SELECT current_setting('server_version_num') AS server_version_num"
			)
				return { rows: [{ server_version_num: '180000' }] };
			if (sql.includes('FROM pg_catalog.pg_constraint'))
				return { rows: live.constraints };
			if (sql.includes('FROM pg_catalog.pg_attrdef default_item'))
				return { rows: live.defaults };
			if (sql.includes('FROM pg_catalog.pg_trigger trigger_item'))
				return { rows: triggers };
			if (sql.includes('FROM pg_catalog.pg_index index_definition'))
				return { rows: live.indexes };
			if (sql.includes('FROM pg_catalog.pg_attribute attribute'))
				return { rows: live.columns };
			if (
				sql.includes(
					'FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace',
				)
			)
				return { rows: live.tables };
			return { rows: [] };
		});
		const allowance = await createPgLedgerShapeAllowance(
			{ query },
			target,
			'harness_probe_trigger',
		);
		await expect(
			validatePgLedgerPhysicalShape({ query }, target, allowance),
		).resolves.toBeUndefined();
		triggers = triggers.map((trigger) =>
			trigger.trigger_name === 'harness_probe_trigger'
				? {
						...trigger,
						trigger_definition: `${trigger.trigger_definition} /* altered WHEN */`,
					}
				: trigger,
		);
		await expect(
			validatePgLedgerPhysicalShape({ query }, target, allowance),
		).rejects.toMatchObject({
			outcome: { kind: 'shape-wrong' },
		});
	});

	it.each([
		['permission denial', '42501', { kind: 'unverifiable', cause: '42501' }],
		['serialization', '40001', { kind: 'unverifiable', cause: '40001' }],
		[
			'catalogue ABI',
			'42703',
			{ kind: 'validator-abi-failure', sqlstate: '42703' },
		],
	])('classifies validator SQLSTATE %s into the closed outcome', (_name, code, expected) => {
		expect(classifyPgLedgerShapeError({ code })).toEqual(expected);
	});

	it('surfaces an erroring discovery candidate rather than silently skipping it', async () => {
		const discoveryRows = ['counterfeit', 'unreadable'].flatMap((schema) =>
			PG_LEDGER_SPEC.map((table) => ({
				nspname: schema,
				table_name: table.name,
				relation_kind: 'r',
				column_names: table.columns.map((column) => column.name),
			})),
		);
		let versionReads = 0;
		const query = vi.fn(async (sql: string) => {
			if (sql.startsWith('BEGIN') || sql === 'COMMIT') return { rows: [] };
			if (sql.includes('ARRAY(SELECT attribute.attname'))
				return { rows: discoveryRows };
			if (
				sql ===
				"SELECT current_setting('server_version_num') AS server_version_num"
			) {
				versionReads += 1;
				if (versionReads === 2)
					throw Object.assign(new Error('denied'), { code: '42501' });
				return { rows: [{ server_version_num: '180000' }] };
			}
			return { rows: [] };
		});
		const result = await readPgLedgerReservationsForPair({ query }, 'pair-1');
		expect(result).toEqual([]);
		expect(result.candidates).toEqual([
			{
				target: { scope: 'schema', schema: 'counterfeit' },
				kind: 'not-ledger-shape',
			},
			{
				target: { scope: 'schema', schema: 'unreadable' },
				kind: 'unverifiable',
				cause: '42501',
			},
		]);
		expect(query).toHaveBeenCalledWith(
			'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
		);
	});

	it('evicts a pooled pair-read session after a lost COMMIT acknowledgement', async () => {
		const commitError = Object.assign(new Error('connection reset'), {
			code: 'ECONNRESET',
		});
		const session = {
			query: vi.fn(async (sql: string) => {
				if (sql === 'COMMIT') throw commitError;
				return { rows: [] };
			}),
			release: vi.fn(),
		};
		const pool = {
			query: vi.fn(),
			connect: vi.fn(async () => session),
		};

		await expect(readPgLedgerReservationsForPair(pool, 'pair-1')).rejects.toBe(
			commitError,
		);
		expect(session.release).toHaveBeenCalledWith(commitError);
	});

	it('returns a rolled-back deterministic pair-read session to the pool normally', async () => {
		const discoveryError = Object.assign(new Error('permission denied'), {
			code: '42501',
		});
		const session = {
			query: vi.fn(async (sql: string) => {
				if (sql.includes('FROM pg_catalog.pg_class relation'))
					throw discoveryError;
				return { rows: [] };
			}),
			release: vi.fn(),
		};
		const pool = {
			query: vi.fn(),
			connect: vi.fn(async () => session),
		};

		await expect(readPgLedgerReservationsForPair(pool, 'pair-1')).rejects.toBe(
			discoveryError,
		);
		expect(session.release).toHaveBeenCalledWith(undefined);
	});

	it('never maps an unknown SQLSTATE to verified', () => {
		expect(classifyPgLedgerShapeError({ code: 'XX000' }).kind).not.toBe(
			'verified',
		);
	});

	it('generates a deterministic specification manifest', () => {
		expect(JSON.stringify(generatePgLedgerExpectedManifest())).toBe(
			JSON.stringify(generatePgLedgerExpectedManifest()),
		);
	});

	it('uses the specification module as the sole manifest source', () => {
		const manifest = generatePgLedgerExpectedManifest();
		expect(manifest.tables).toBe(PG_LEDGER_SPEC);
		expect(JSON.stringify(manifest)).not.toContain(
			'PG_LEDGER_TABLE_DEFINITIONS',
		);
	});

	it('derives manifest table expectations from rendered table DDL', () => {
		const manifest = generatePgLedgerExpectedManifest();
		const actual = renderedTableDeclarations().map(({ sql }) => {
			const match = sql.match(
				/^CREATE TABLE IF NOT EXISTS "[^"]+"\."([^"]+)" \(/,
			);
			if (!match) throw new Error(`missing table declaration: ${sql}`);
			return match[1]!;
		});
		const expected = manifest.tables.map((definition) => definition.name);
		expect(sorted(actual)).toEqual(sorted(expected));
	});

	it('derives manifest column expectations from rendered table DDL', () => {
		const manifest = generatePgLedgerExpectedManifest();
		const actual = renderedTableDeclarations().flatMap(({ sql }) => {
			const table = sql.match(
				/^CREATE TABLE IF NOT EXISTS "[^"]+"\."([^"]+)" \(/,
			)?.[1];
			if (!table) throw new Error(`missing table declaration: ${sql}`);
			return splitTopLevelSqlList(tableBody(sql))
				.filter((declaration) => !declaration.startsWith('CONSTRAINT '))
				.map((declaration) => `${table}.${declaration.split(' ', 1)[0]}`);
		});
		const expected = manifest.tables.flatMap((definition) =>
			definition.columns.map((column) => `${definition.name}.${column.name}`),
		);
		expect(sorted(actual)).toEqual(sorted(expected));
	});

	it('derives manifest defaulted-column expectations from rendered table DDL', () => {
		const manifest = generatePgLedgerExpectedManifest();
		const actual = renderedTableDeclarations().flatMap(({ sql }) => {
			const table = sql.match(
				/^CREATE TABLE IF NOT EXISTS "[^"]+"\."([^"]+)" \(/,
			)?.[1];
			if (!table) throw new Error(`missing table declaration: ${sql}`);
			return splitTopLevelSqlList(tableBody(sql))
				.filter((declaration) => declaration.includes(' DEFAULT '))
				.map((declaration) => `${table}.${declaration.split(' ', 1)[0]}`);
		});
		const expected = manifest.tables.flatMap((definition) =>
			definition.columns
				.filter((column) => column.defaultSql !== undefined)
				.map((column) => `${definition.name}.${column.name}`),
		);
		expect(sorted(actual)).toEqual(sorted(expected));
	});

	it('derives manifest constraint expectations from rendered table DDL', () => {
		const manifest = generatePgLedgerExpectedManifest();
		const actual = renderedTableDeclarations().flatMap(({ sql }) => {
			const table = sql.match(
				/^CREATE TABLE IF NOT EXISTS "[^"]+"\."([^"]+)" \(/,
			)?.[1];
			if (!table) throw new Error(`missing table declaration: ${sql}`);
			return [...sql.matchAll(/CONSTRAINT "([^"]+)"/g)].map(
				(match) => `${table}.${match[1]}`,
			);
		});
		const expected = manifest.tables.flatMap((definition) =>
			definition.constraints.map(
				(constraint) => `${definition.name}.${constraint.name}`,
			),
		);
		expect(sorted(actual)).toEqual(sorted(expected));
	});

	it('derives manifest index expectations from rendered index DDL', () => {
		const manifest = generatePgLedgerExpectedManifest();
		const actual = PG_LEDGER_SPEC.flatMap((definition) =>
			(definition.indexes ?? []).map((index) => {
				const sql = renderCreateLedgerIndexFromSpec(target, definition, index);
				const match = sql.match(
					/^CREATE INDEX IF NOT EXISTS "([^"]+)" ON "[^"]+"\."([^"]+)" /,
				);
				if (!match) throw new Error(`missing index declaration: ${sql}`);
				return `${match[2]}.${match[1]}`;
			}),
		);
		const expected = manifest.tables.flatMap((definition) =>
			(definition.indexes ?? []).map(
				(index) => `${definition.name}.${index.name}`,
			),
		);
		expect(sorted(actual)).toEqual(sorted(expected));
	});

	it('derives manifest immutability-trigger expectations from rendered trigger DDL', () => {
		const manifest = generatePgLedgerExpectedManifest();
		const sql = renderCreateLedgerImmutabilityTriggerFromSpec(target);
		const match = sql.match(
			/CREATE TRIGGER ([a-z_]+) BEFORE INSERT OR UPDATE OR DELETE ON "[^"]+"\."([^"]+)" /,
		);
		if (!match) throw new Error(`missing trigger declaration: ${sql}`);
		expect([`${match[2]}.${match[1]}`]).toEqual([
			`${manifest.immutabilityTrigger.tableName}.${manifest.immutabilityTrigger.name}`,
		]);
	});

	it('derives manifest immutability-function expectations from rendered function DDL', () => {
		const manifest = generatePgLedgerExpectedManifest();
		const sql = renderCreateLedgerImmutabilityFunctionFromSpec(target);
		const match = sql.match(
			/^CREATE OR REPLACE FUNCTION "[^"]+"\."([^"]+)"\(\)/,
		);
		if (!match) throw new Error(`missing function declaration: ${sql}`);
		expect([match[1]]).toEqual([manifest.immutabilityTrigger.functionName]);
	});

	it.each([
		{ kind: 'shape-wrong', artefact: 'table' },
		{ kind: 'unverifiable', cause: '42501' },
		{ kind: 'unsupported-major', major: 99 },
		{ kind: 'validator-abi-failure', sqlstate: '42703' },
	] as const)('throws for façade outcome $kind', (outcome) => {
		expect(() => assertPgLedgerPhysicalShapeVerified(outcome)).toThrow(
			PgLedgerPhysicalShapeValidationError,
		);
	});

	it('rejects a fixture-absent synthetic major at classifier entry and the façade cannot validate it', async () => {
		const query = vi.fn(async () => ({
			rows: [{ server_version_num: '99990000' }],
		}));
		await expect(
			validatePgLedgerPhysicalShape({ query }, target),
		).rejects.toMatchObject({
			outcome: { kind: 'unsupported-major', major: 9999 },
		});
	});

	it('keeps every supported PostgreSQL major covered by a valid deparse fixture', async () => {
		const fixtureFiles = await readdir(ledgerDeparseFixtureDirectory);
		const fixtureMajors = fixtureFiles
			.map((filename) => /^pg-(\d+)\.json$/.exec(filename)?.[1])
			.filter((major): major is string => major !== undefined)
			.map(Number)
			.sort((left, right) => left - right);
		expect(
			fixtureMajors,
			'at least one deparse fixture is required',
		).not.toHaveLength(0);

		const minimumMajor = PG_LEDGER_MIN_SERVER_VERSION_NUM / 10000;
		expect(
			Number.isSafeInteger(minimumMajor),
			'ledger storage floor must identify a PostgreSQL major',
		).toBe(true);
		const maximumMajor = fixtureMajors.at(-1)!;
		const supportedMajors = Array.from(
			{ length: maximumMajor - minimumMajor + 1 },
			(_, index) => minimumMajor + index,
		);
		expect(fixtureMajors).toEqual(supportedMajors);

		for (const major of supportedMajors) {
			const filename = resolve(
				ledgerDeparseFixtureDirectory,
				`pg-${major}.json`,
			);
			const fixture: unknown = JSON.parse(await readFile(filename, 'utf8'));
			expect(fixture, `pg-${major}.json must be an object`).toBeTypeOf(
				'object',
			);
			expect(fixture, `pg-${major}.json must not be null`).not.toBeNull();
			assertNonEmptyStringRecord(
				(fixture as { checks?: unknown }).checks,
				`pg-${major}.json checks`,
			);
			assertNonEmptyStringRecord(
				(fixture as { defaults?: unknown }).defaults,
				`pg-${major}.json defaults`,
			);
		}
	});

	it('uses a reject-only four-relation fingerprint', () => {
		const rows = PG_LEDGER_SPEC.map((table) => ({
			table_name: table.name,
			relation_kind: 'r',
			column_names: table.columns.map((column) => column.name),
		}));
		expect(hasPgLedgerCandidateFingerprint(rows)).toBe(true);
		for (let index = 0; index < rows.length; index += 1) {
			const malformed = rows.map((row, current) =>
				current === index ? { ...row, relation_kind: 'v' } : row,
			);
			expect(hasPgLedgerCandidateFingerprint(malformed)).toBe(false);
		}
		expect(
			hasPgLedgerCandidateFingerprint([
				...rows.slice(0, -1),
				{ ...rows.at(-1)!, column_names: ['wrong-order'] },
			]),
		).toBe(false);
	});
	it('renders the closed, same-address append-only chain shape', () => {
		const sql = renderCreateLedgerEventTableSql(target);
		expect(sql).toContain('UNIQUE NULLS NOT DISTINCT');
		expect(sql).toContain('FOREIGN KEY (address_engine, address_database');
		expect(sql).toContain('REFERENCES "tenant_a"."dbsp_ledger_event"');
		expect(sql).toContain("'readdressed-from'");
		expect(sql).toContain('refusal_code');
		expect(sql).toContain('dbsp_ledger_refusal_payload');
		expect(sql).not.toContain('sequence');
	});

	it('declares and proves PG 15 before ledger DDL', async () => {
		const query = vi.fn(async (sql: string) =>
			sql === 'SHOW server_version_num'
				? { rows: [{ server_version_num: '140000' }] }
				: { rows: [] },
		);
		await expect(ensurePgLedger({ query }, target)).rejects.toBeInstanceOf(
			PgLedgerStorageUnsupportedError,
		);
		expect(query).toHaveBeenCalledOnce();
	});

	it('writes the shape marker only after the immutability function and trigger', async () => {
		const query = vi.fn(async (sql: string) =>
			sql === 'SHOW server_version_num'
				? { rows: [{ server_version_num: '150000' }] }
				: { rows: [] },
		);
		await ensurePgLedger({ query }, target);
		const sql = query.mock.calls.map(([value]) => String(value)).join('\n');
		expect(sql).toContain('dbsp_ledger_reservation');
		expect(sql).toContain('dbsp_ledger_identity');
		expect(sql).toContain('dbsp_ledger_marker');
		const functionIndex = sql.indexOf('dbsp_ledger_event_immutable');
		const triggerIndex = sql.lastIndexOf('CREATE TRIGGER');
		const markerIndex = sql.indexOf(
			'INSERT INTO "tenant_a"."dbsp_ledger_marker"',
		);
		expect(functionIndex).toBeGreaterThan(-1);
		expect(triggerIndex).toBeGreaterThan(functionIndex);
		expect(markerIndex).toBeGreaterThan(triggerIndex);
	});

	it('can defer the marker for the reinitialize-preflight final step', async () => {
		const query = vi.fn(async (sql: string) =>
			sql === 'SHOW server_version_num'
				? { rows: [{ server_version_num: '150000' }] }
				: { rows: [] },
		);
		await ensurePgLedger({ query }, target, { writeMarker: false });
		expect(
			query.mock.calls.some(([sql]) =>
				String(sql).includes('INSERT INTO "tenant_a"."dbsp_ledger_marker"'),
			),
		).toBe(false);
	});

	it.each([
		{ scope: 'schema' as const, schema: 'tenant_shape' },
		{ scope: 'database' as const },
	])('does not validate a ledger when the current major has no captured fixture for $scope scope', async (ledger) => {
		const query = vi.fn(async (sql: string) => {
			if (sql === 'SHOW server_version_num')
				return { rows: [{ server_version_num: '180000' }] };
			if (sql.includes('FROM pg_catalog.pg_trigger trigger_item'))
				return {
					rows: createdLedgerImmutabilityTriggerRows(),
				};
			if (sql.includes('FROM pg_catalog.pg_attrdef default_item'))
				return { rows: createdLedgerDefaultRows() };
			if (
				sql.includes(
					'FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace',
				)
			)
				return { rows: createdLedgerTableRows() };
			if (sql.includes('FROM pg_catalog.pg_attribute attribute'))
				return { rows: createdLedgerColumnRows() };
			if (sql.includes('FROM pg_catalog.pg_constraint'))
				return {
					rows: [
						...createdLedgerInvariantConstraintRows(),
						...createdLedgerColumnRows()
							.filter((row) => row.is_not_null)
							.map(({ table_name, column_name }) => ({
								table_name,
								contype: 'n',
								key_columns: [column_name],
							})),
					],
				};
			if (sql.includes('FROM pg_catalog.pg_index'))
				return { rows: createdLedgerTerminalIndexRows() };
			return { rows: [] };
		});
		await ensurePgLedger({ query }, ledger, { writeMarker: false });
		await expect(
			validatePgLedgerPhysicalShape({ query }, ledger),
		).rejects.toMatchObject({
			outcome: { kind: 'unsupported-major', major: undefined },
		});
		expect(query).toHaveBeenCalledWith(
			expect.stringContaining('CREATE TABLE IF NOT EXISTS'),
		);
	});

	it.each([
		{
			name: 'self-referential predecessor foreign key',
			without: (
				rows: ReturnType<typeof createdLedgerInvariantConstraintRows>,
			) => rows.filter((row) => row.contype !== 'f'),
		},
		{
			name: 'UNIQUE NULLS NOT DISTINCT child constraint',
			without: (
				rows: ReturnType<typeof createdLedgerInvariantConstraintRows>,
			) => rows.filter((row) => row.contype !== 'u'),
		},
	])('refuses a pre-existing ledger missing its $name', async ({ without }) => {
		const query = vi.fn(async (sql: string) => {
			if (
				sql.includes(
					'FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace',
				)
			)
				return { rows: createdLedgerTableRows() };
			if (sql.includes('FROM pg_catalog.pg_attribute attribute'))
				return { rows: createdLedgerColumnRows() };
			if (
				sql ===
				"SELECT current_setting('server_version_num') AS server_version_num"
			)
				return { rows: [{ server_version_num: '180000' }] };
			if (sql.includes('FROM pg_catalog.pg_constraint'))
				return { rows: without(createdLedgerInvariantConstraintRows()) };
			if (sql.includes('FROM pg_catalog.pg_index'))
				return { rows: createdLedgerTerminalIndexRows() };
			return { rows: [] };
		});
		await expect(
			validatePgLedgerPhysicalShape({ query }, target),
		).rejects.toMatchObject({
			outcome: {
				kind: 'shape-wrong',
				artefact:
					'ledger physical shape: tenant_a.dbsp_ledger_event has an unexpected named constraint set; run dbsp preflight --reinitialize',
			},
		});
	});

	it('makes a claim append and its closure reservations one statement', async () => {
		const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
			rows: [],
		}));
		await appendPgLedgerClaim({ query }, target, claim, [reservation]);
		expect(query).toHaveBeenCalledOnce();
		expect(query.mock.calls[0]?.[0]).toContain('WITH appended AS');
		expect(query.mock.calls[0]?.[0]).toContain(
			'INSERT INTO "tenant_a"."dbsp_ledger_reservation"',
		);
	});

	it('appends and resolves a root plus contained member as one group transaction unit', async () => {
		const child = {
			...claim,
			eventId: 'claim-child',
			address: {
				...claim.address,
				kind: 'column',
				name: 'accounts.id',
				parent: claim.address,
			},
			eventKind: 'retire-intent' as const,
			claimGroupId: 'claim-1',
			rootClaimId: 'claim-1',
		};
		const childReservation: LedgerReservationRow = {
			...reservation,
			address: child.address,
			claimKind: 'retire-intent',
			rootClaimId: 'claim-1',
		};
		const query = vi.fn(async (_sql: string) => ({ rows: [] }));
		await appendPgLedgerClaimGroup(
			{ query },
			{
				...claim,
				eventKind: 'retire-intent',
				claimGroupId: 'claim-1',
				rootClaimId: 'claim-1',
			},
			[child],
			[{ ...reservation, claimKind: 'retire-intent' }, childReservation],
		);
		expect(query).toHaveBeenCalledTimes(2);
		await appendPgLedgerResolutionGroup(
			{ query },
			'claim-1',
			[
				{
					...claim,
					eventId: 'absent-root',
					eventKind: 'absent',
					predecessor: 'claim-1',
				},
				{
					...child,
					eventId: 'absent-child',
					eventKind: 'absent',
					predecessor: 'claim-child',
				},
			],
			[{ address: claim.address }, { address: child.address }],
		);
		expect(query).toHaveBeenCalledTimes(4);
		const [groupRootResolution, containedResolution] =
			query.mock.calls.slice(2);
		expect(groupRootResolution?.[0]).toContain('DELETE FROM');
		expect(containedResolution?.[0]).not.toContain('DELETE FROM');
	});

	it('matches group reservations by canonical ledger address identity', async () => {
		const parent = {
			scope: 'schema',
			engine: 'postgresql',
			database: 'app',
			schema: 'tenant_a',
			kind: 'table',
			name: 'parent_accounts',
		} as const;
		const sameParentDifferentOrder = {
			name: 'parent_accounts',
			kind: 'table',
			schema: 'tenant_a',
			database: 'app',
			engine: 'postgresql',
			scope: 'schema',
		} as const;
		const root = {
			...claim,
			eventId: 'claim-ordered-parent',
			eventKind: 'retire-intent' as const,
			claimGroupId: 'claim-ordered-parent',
			rootClaimId: 'claim-ordered-parent',
			address: { ...claim.address, parent },
		};
		const child = {
			...claim,
			eventId: 'claim-ordered-parent-child',
			eventKind: 'retire-intent' as const,
			claimGroupId: 'claim-ordered-parent',
			rootClaimId: 'claim-ordered-parent',
			address: {
				...claim.address,
				kind: 'column',
				name: 'accounts.id',
			},
		};
		const query = vi.fn(async () => ({ rows: [] }));
		await expect(
			appendPgLedgerClaimGroup(
				{ query },
				root,
				[child],
				[
					{
						...reservation,
						address: { ...root.address, parent: sameParentDifferentOrder },
						claimKind: 'retire-intent',
						rootClaimId: 'claim-ordered-parent',
					},
					{
						...reservation,
						address: child.address,
						claimKind: 'retire-intent',
						rootClaimId: 'claim-ordered-parent',
					},
				],
			),
		).resolves.toBeUndefined();
		expect(query).toHaveBeenCalledTimes(2);
		await expect(
			appendPgLedgerResolutionGroup(
				{ query },
				'claim-ordered-parent',
				[
					{
						...root,
						eventId: 'absent-ordered-parent',
						eventKind: 'absent',
						predecessor: root.eventId,
					},
					{
						...child,
						eventId: 'absent-ordered-parent-child',
						eventKind: 'absent',
						predecessor: child.eventId,
					},
				],
				[
					{
						address: { ...root.address, parent: sameParentDifferentOrder },
					},
					{ address: child.address },
				],
			),
		).resolves.toBeUndefined();
		expect(query).toHaveBeenCalledTimes(4);
	});

	it('makes a resolution append and its reservation release one statement', async () => {
		const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
			rows: [],
		}));
		await appendPgLedgerResolution(
			{ query },
			target,
			{
				...claim,
				eventId: 'observed-1',
				eventKind: 'observed',
				predecessor: 'claim-1',
			},
			'claim-1',
			[reservation],
		);
		expect(query).toHaveBeenCalledOnce();
		expect(query.mock.calls[0]?.[0]).toContain('WITH appended AS');
		expect(query.mock.calls[0]?.[0]).toContain('DELETE FROM');
	});

	it('binds the reservation root after every expanded event value', async () => {
		const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
			rows: [],
		}));
		await appendPgLedgerResolution(
			{ query },
			target,
			{
				...claim,
				eventId: 'observed-with-provenance',
				eventKind: 'observed',
				predecessor: 'claim-1',
				executionId: 'execution-1',
				plannedClaimKey: 'step:1/root',
				claimGroupId: 'claim-1',
				rootClaimId: 'claim-1',
			},
			'claim-1',
			[reservation],
		);
		const [sql, params] = query.mock.calls[0] ?? [];
		expect(String(sql)).toContain('r.root_claim_id = $25');
		expect(params?.[24]).toBe('claim-1');
	});

	it('locks dbsp_meta before schema names and turns a lock error into a refusal', async () => {
		const query = vi.fn(async () => ({ rows: [{ locked: true }] }));
		await expect(
			acquirePgLedgerLocks({ query }, [
				{ scope: 'schema', schema: 'zeta' },
				{ scope: 'database' },
				{ scope: 'schema', schema: 'alpha' },
			]),
		).resolves.toEqual({ kind: 'acquired' });
		expect(query).toHaveBeenCalledTimes(3);

		const failing = new Error('lock permission denied');
		await expect(
			acquirePgLedgerLocks({ query: async () => Promise.reject(failing) }, [
				{ scope: 'database' },
			]),
		).resolves.toEqual({
			kind: 'refused',
			ledger: { scope: 'database' },
			error: failing,
		});
	});

	it('turns a held façade ledger lock into an immediate busy result', async () => {
		const query = vi.fn(async () => ({ rows: [{ locked: false }] }));
		await expect(
			acquirePgLedgerLocks({ query }, [
				{ scope: 'schema', schema: 'tenant_a' },
			]),
		).resolves.toEqual({
			kind: 'busy',
			ledger: { scope: 'schema', schema: 'tenant_a' },
		});
		expect(query).toHaveBeenCalledWith(
			'SELECT pg_catalog.pg_try_advisory_xact_lock($1::bigint) AS locked',
			expect.any(Array),
		);
	});
});
