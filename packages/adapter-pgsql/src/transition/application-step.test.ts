import type {
	LedgerAddress,
	LedgerChainMember,
	LedgerHome,
	LedgerPayload,
} from '@dbsp/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	chain: vi.fn<
		(
			ledger: LedgerHome,
			address: LedgerAddress,
		) => Promise<{
			readonly ledger: LedgerHome;
			readonly address: LedgerAddress;
			readonly events: readonly LedgerChainMember[];
			readonly terminalMember?: LedgerChainMember;
		}>
	>(async (ledger, address) => ({ ledger, address, events: [] })),
	lock: vi.fn(async () => ({ kind: 'acquired' as const })),
	appendClaim: vi.fn(async () => undefined),
	appendResolution: vi.fn(async () => undefined),
}));

vi.mock('./chain-reader.js', () => ({
	readPgLedgerAddressChain: (
		_client: unknown,
		ledger: LedgerHome,
		address: LedgerAddress,
	) => mocks.chain(ledger, address),
}));
vi.mock('./ledger.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./ledger.js')>()),
	acquirePgLedgerLocks: () => mocks.lock(),
	appendPgLedgerClaim: () => mocks.appendClaim(),
	appendPgLedgerResolution: () => mocks.appendResolution(),
}));

import {
	createPgApplicationStepTx,
	PgApplicationStepError,
	type PgApplicationStepTx,
	planPgApplicationSteps,
	runPgApplicationSteps,
	validatePgConvergeApplicationSteps,
} from './application-step.js';
import {
	PgCommitAcknowledgementAmbiguousError,
	readPgOutcomeSessionCompromise,
} from './outcome-protocol.js';

const apply = async () => undefined;

function completedOnceChain(
	ledger: LedgerHome,
	address: LedgerAddress,
	digest: string,
	recorded: LedgerPayload = {
		value: { id: 'items-backfill', digest, step: 'once' },
		digest,
	},
) {
	const claim: LedgerChainMember = {
		eventId: 'application-step-claim',
		address,
		eventKind: 'intent',
		declared: recorded,
		controller: 'owner',
		controllerOid: '10',
	};
	const observed: LedgerChainMember = {
		eventId: 'application-step-observed',
		address,
		eventKind: 'observed',
		predecessor: claim.eventId,
		observed: recorded,
		controller: 'owner',
		controllerOid: '10',
	};
	return {
		ledger,
		address,
		events: [claim, observed],
		terminalMember: observed,
	};
}

function queryWithCurrentController(text: string) {
	return text.startsWith('SELECT current_user')
		? { rows: [{ current_user: 'owner', current_user_oid: '10' }] }
		: { rows: [] };
}

afterEach(() => {
	mocks.chain.mockReset();
	mocks.chain.mockImplementation(async (ledger, address) => ({
		ledger,
		address,
		events: [],
	}));
	mocks.lock.mockReset();
	mocks.lock.mockResolvedValue({ kind: 'acquired' });
	mocks.appendClaim.mockReset();
	mocks.appendClaim.mockResolvedValue(undefined);
	mocks.appendResolution.mockReset();
	mocks.appendResolution.mockResolvedValue(undefined);
});

describe('converge application steps', () => {
	it.each([
		undefined,
		[
			{
				kind: 'once',
				id: '',
				digest: 'v1',
				phase: 'after-generated-ddl',
				apply,
			},
		],
		[
			{
				kind: 'once',
				id: 'one',
				digest: 'v1',
				phase: 'after-generated-ddl',
				apply,
			},
			{
				kind: 'once',
				id: 'one',
				digest: 'v2',
				phase: 'after-generated-ddl',
				apply,
			},
		],
		[
			{
				kind: 'once',
				id: 'one',
				digest: '',
				phase: 'after-generated-ddl',
				apply,
			},
		],
		[
			{
				kind: 'once',
				id: 'one',
				digest: 'v1',
				scope: 'database',
				phase: 'after-generated-ddl',
				apply,
			},
		],
		[{ kind: 'once', id: 'one', digest: 'v1', phase: 'later', apply }],
		[
			{
				kind: 'once',
				id: 'one',
				digest: 'v1',
				phase: 'after-generated-ddl',
				lockTimeoutMs: 0,
				apply,
			},
		],
		[
			{
				kind: 'once',
				id: 'one',
				digest: 'v1',
				phase: 'after-generated-ddl',
				apply: 'no',
			},
		],
		[
			{
				kind: 'assert',
				id: 'one',
				digest: 'v1',
				phase: 'after-generated-ddl',
				apply,
			},
		],
	])('rejects invalid declarations before connection work', (steps) => {
		if (steps === undefined) {
			expect(validatePgConvergeApplicationSteps(steps)).toEqual([]);
			return;
		}
		expect(() => validatePgConvergeApplicationSteps(steps)).toThrow();
	});

	it.each([
		'PREPARE transaction_cache AS SELECT 1',
		'PREPARE transaction1 AS SELECT 1',
		'PREPARE transactioné AS SELECT 1',
		'SET transaction_timeout = 1000',
		'SET LOCAL transaction_timeout = 1000',
	])(
		'allows guarded-keyword prefixes that are complete identifiers: %s',
		async (statement) => {
			const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
			const tx = createPgApplicationStepTx({ query } as never);
			await expect(tx.query(statement)).resolves.toEqual({ rows: [] });
			expect(query).toHaveBeenCalledWith({
				text: statement,
				values: [],
				queryMode: 'extended',
			});
		},
	);

	it.each([
		'PREPARE transaction AS SELECT 1',
		'PREPARE q AS SELECT 1',
		'SELECT 1 -- c\r',
		'DISCARD PLANS',
	])('permits ordinary callback SQL: %s', async (statement) => {
		const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
		const tx = createPgApplicationStepTx({ query } as never);
		await expect(tx.query(statement)).resolves.toEqual({ rows: [] });
	});

	it.each([
		'BEGIN',
		'  rollback',
		'/* x */ COMMIT',
		'-- x\nROLLBACK',
		'START TRANSACTION',
		'END',
		'ABORT',
		'SAVEPOINT application_step',
		'RELEASE SAVEPOINT application_step',
		'SET TRANSACTION READ ONLY',
		'SET -- c\nTRANSACTION ISOLATION LEVEL SERIALIZABLE',
		'SET -- c\rTRANSACTION ISOLATION LEVEL SERIALIZABLE',
		'SET -- c\r\nTRANSACTION ISOLATION LEVEL SERIALIZABLE',
		'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY',
	])(
		'refuses transaction control through the callback facade: %s',
		async (statement) => {
			const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
			const tx = createPgApplicationStepTx({ query } as never);
			await expect(tx.query(statement)).rejects.toThrow('transaction control');
			expect(query).not.toHaveBeenCalled();
		},
	);

	it('reads each declaration property once before normalizing it', () => {
		let idReads = 0;
		const step = {
			kind: 'once',
			get id() {
				idReads += 1;
				return idReads === 1 ? 'read-once' : '';
			},
			digest: 'v1',
			phase: 'after-generated-ddl',
			apply,
		};
		expect(validatePgConvergeApplicationSteps([step])).toEqual([
			expect.objectContaining({ id: 'read-once' }),
		]);
		expect(idReads).toBe(1);
	});

	it.each([Number.MAX_SAFE_INTEGER, 2_147_483_648, 1.5])(
		'refuses an out-of-range application-step timeout: %s',
		(timeout) => {
			expect(() =>
				validatePgConvergeApplicationSteps([
					{
						kind: 'once',
						id: 'one',
						digest: 'v1',
						phase: 'after-generated-ddl',
						statementTimeoutMs: timeout,
						apply,
					},
				]),
			).toThrow();
		},
	);

	it('accepts PostgreSQL’s maximum application-step timeout', () => {
		expect(
			validatePgConvergeApplicationSteps([
				{
					kind: 'once',
					id: 'one',
					digest: 'v1',
					phase: 'after-generated-ddl',
					lockTimeoutMs: 2_147_483_647,
					statementTimeoutMs: 2_147_483_647,
					apply,
				},
			]),
		).toHaveLength(1);
	});

	it('normalizes assertion ownership and refuses malformed ownership before connection work', () => {
		const assertion = {
			kind: 'assert' as const,
			id: 'owned-check',
			digest: 'v1',
			phase: 'after-generated-ddl' as const,
			owns: { checks: [{ table: 'projects', name: 'project_state' }] },
			inspect: async () => 'healthy' as const,
			apply,
		};
		const validated = validatePgConvergeApplicationSteps([assertion]);
		expect(validated).toEqual([
			expect.objectContaining({ owns: assertion.owns }),
		]);
		const first = validated[0];
		if (first?.kind !== 'assert' || first.owns === undefined)
			throw new Error('expected validated assertion ownership');
		const owned = first.owns;
		const checks = owned.checks;
		if (checks === undefined)
			throw new Error('expected validated owned checks');
		expect(owned).not.toBe(assertion.owns);
		expect(checks).not.toBe(assertion.owns.checks);
		expect(checks[0]).not.toBe(assertion.owns.checks[0]);
		assertion.owns.checks.push({ table: 'projects', name: 'later' });
		expect(checks).toEqual([{ table: 'projects', name: 'project_state' }]);
		expect(() =>
			validatePgConvergeApplicationSteps([
				{
					...assertion,
					owns: { checks: [{ table: 'projects', name: 'x', extra: true }] },
				},
			]),
		).toThrow('owns.checks entries');
		expect(() =>
			validatePgConvergeApplicationSteps([
				{
					kind: 'once',
					id: 'once-owned',
					digest: 'v1',
					phase: 'after-generated-ddl',
					owns: { checks: [{ table: 'projects', name: 'project_state' }] },
					apply,
				},
			]),
		).toThrow('once steps cannot declare owns');
	});

	it('reads each ownership value once into a snapshot', () => {
		let nameReads = 0;
		const entry = {
			table: 'projects',
			get name() {
				nameReads += 1;
				return nameReads === 1 ? 'first_name' : 'second_name';
			},
		};
		const owns = { indexes: [entry] };
		const [validated] = validatePgConvergeApplicationSteps([
			{
				kind: 'assert',
				id: 'read-owned-name-once',
				digest: 'v1',
				phase: 'after-generated-ddl',
				owns,
				inspect: async () => 'healthy' as const,
				apply,
			},
		]);
		expect(validated).toMatchObject({
			owns: { indexes: [{ table: 'projects', name: 'first_name' }] },
		});
		expect(nameReads).toBe(1);
	});

	it.each([
		['an owns symbol key', () => ({ [Symbol('extra')]: [], checks: [] })],
		[
			'an owns non-enumerable key',
			() => {
				const owns = { checks: [] };
				Object.defineProperty(owns, 'extra', { value: [], enumerable: false });
				return owns;
			},
		],
		[
			'an entry symbol key',
			() => ({
				checks: [{ table: 'projects', name: 'state', [Symbol('extra')]: true }],
			}),
		],
	] as const)('refuses %s', (_case, makeOwns) => {
		expect(() =>
			validatePgConvergeApplicationSteps([
				{
					kind: 'assert',
					id: 'invalid-owned-keys',
					digest: 'v1',
					phase: 'after-generated-ddl',
					owns: makeOwns(),
					inspect: async () => 'healthy' as const,
					apply,
				},
			]),
		).toThrow('owns');
	});

	it('treats an own undefined ownership list as absent', () => {
		expect(
			validatePgConvergeApplicationSteps([
				{
					kind: 'assert',
					id: 'undefined-owned-checks',
					digest: 'v1',
					phase: 'after-generated-ddl',
					owns: {
						checks: undefined,
						indexes: [{ table: 'projects', name: 'project_state_index' }],
					},
					inspect: async () => 'healthy' as const,
					apply,
				},
			]),
		).toMatchObject([
			{
				owns: { indexes: [{ table: 'projects', name: 'project_state_index' }] },
			},
		]);
	});

	it('rolls back and identifies a planning inspection failure', async () => {
		const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
		await expect(
			Reflect.apply(planPgApplicationSteps, undefined, [
				{
					client: { query } as never,
					database: 'app',
					schema: 'public',
					steps: [
						{
							kind: 'assert',
							id: 'state-check',
							digest: 'v1',
							phase: 'after-generated-ddl',
							inspect: async () => {
								throw new Error('syntax error at or near "constraint"');
							},
							apply,
						},
					],
				},
			]),
		).rejects.toMatchObject({
			refusal: 'application-step-failed',
			stepId: 'state-check',
			message: 'syntax error at or near "constraint"',
		});
		expect(query.mock.calls.map(([text]) => text)).toEqual([
			'BEGIN READ ONLY',
			'ROLLBACK',
			'BEGIN READ ONLY',
			"SELECT pg_catalog.set_config('search_path', pg_catalog.format('%I, pg_temp, %s', $1::pg_catalog.text, pg_catalog.current_setting('search_path')), true)",
			"SET LOCAL lock_timeout = '5000ms'",
			'ROLLBACK',
		]);
	});

	it('keeps a planning inspection failure when its rollback fails', async () => {
		const inspectionError = new Error('inspection failed');
		const rollbackError = new Error('ROLLBACK acknowledgement lost');
		let rollbackCalls = 0;
		const query = vi.fn(async (statement: string) => {
			if (statement === 'ROLLBACK') {
				rollbackCalls += 1;
				if (rollbackCalls === 2) throw rollbackError;
			}
			return queryWithCurrentController(statement);
		});
		const client = { query };
		await expect(
			planPgApplicationSteps({
				client: client as never,
				database: 'app',
				schema: 'public',
				steps: [
					{
						kind: 'assert',
						id: 'state-check',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect: async () => {
							throw inspectionError;
						},
						apply,
					},
				],
			}),
		).rejects.toMatchObject({
			refusal: 'application-step-failed',
			stepId: 'state-check',
			message: 'inspection failed',
		});
		expect(readPgOutcomeSessionCompromise(client as never)).toBe(rollbackError);
	});

	it('stops after a healthy assert rollback compromises the session', async () => {
		const query = vi.fn(async (statement: string) => {
			if (statement === 'ROLLBACK') throw new Error('rollback lost');
			return { rows: [] };
		});
		await expect(
			runPgApplicationSteps({
				client: { query } as never,
				database: 'app',
				schema: 'public',
				phase: 'after-generated-ddl',
				steps: [
					{
						kind: 'assert',
						id: 'healthy-check',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect: async () => 'healthy' as const,
						apply,
					},
				],
			}),
		).rejects.toMatchObject({
			refusal: 'application-step-failed',
			stepId: 'healthy-check',
		});
		expect(
			query.mock.calls.filter(([statement]) => statement === 'ROLLBACK'),
		).toHaveLength(1);
	});

	it('refuses an inspection status outside the public contract', async () => {
		const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
		await expect(
			Reflect.apply(planPgApplicationSteps, undefined, [
				{
					client: { query } as never,
					database: 'app',
					schema: 'public',
					steps: [
						{
							kind: 'assert',
							id: 'state-check',
							digest: 'v1',
							phase: 'after-generated-ddl',
							inspect: async () => 'unknown',
							apply,
						},
					],
				},
			]),
		).rejects.toMatchObject({
			refusal: 'application-step-failed',
			stepId: 'state-check',
		});
		expect(query.mock.calls.map(([text]) => text)).toEqual([
			'BEGIN READ ONLY',
			'ROLLBACK',
			'BEGIN READ ONLY',
			"SELECT pg_catalog.set_config('search_path', pg_catalog.format('%I, pg_temp, %s', $1::pg_catalog.text, pg_catalog.current_setting('search_path')), true)",
			"SET LOCAL lock_timeout = '5000ms'",
			'ROLLBACK',
		]);
	});

	it('uses the connection settings throughout batched planning admission', async () => {
		const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
		await expect(
			planPgApplicationSteps({
				client: { query } as never,
				database: 'app',
				schema: 'public',
				steps: [
					{
						kind: 'once',
						id: 'bounded-admission',
						digest: 'v1',
						phase: 'after-generated-ddl',
						lockTimeoutMs: 25,
						statementTimeoutMs: 1,
						apply,
					},
					{
						kind: 'once',
						id: 'default-admission',
						digest: 'v1',
						phase: 'after-generated-ddl',
						apply,
					},
				],
			}),
		).resolves.toEqual([
			{
				kind: 'application-step',
				step: 'once',
				id: 'bounded-admission',
			},
			{
				kind: 'application-step',
				step: 'once',
				id: 'default-admission',
			},
		]);
		expect(query.mock.calls).toEqual([['BEGIN READ ONLY'], ['ROLLBACK']]);
	});

	it('marks the session compromised when planning admission loses its BEGIN acknowledgement', async () => {
		const beginError = new Error('BEGIN acknowledgement lost');
		const query = vi.fn(async (statement: string) => {
			if (statement === 'BEGIN READ ONLY') throw beginError;
			return { rows: [] };
		});
		const client = { query };
		await expect(
			planPgApplicationSteps({
				client: client as never,
				database: 'app',
				schema: 'public',
				steps: [
					{
						kind: 'once',
						id: 'admission-begin',
						digest: 'v1',
						phase: 'after-generated-ddl',
						apply,
					},
				],
			}),
		).rejects.toBe(beginError);
		expect(readPgOutcomeSessionCompromise(client as never)).toBe(beginError);
		expect(query).toHaveBeenCalledExactlyOnceWith('BEGIN READ ONLY');
	});

	it('bounds planning inspections with the step timeouts', async () => {
		const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
		await expect(
			planPgApplicationSteps({
				client: { query } as never,
				database: 'app',
				schema: 'public',
				steps: [
					{
						kind: 'assert',
						id: 'state-check',
						digest: 'v1',
						phase: 'after-generated-ddl',
						lockTimeoutMs: 25,
						statementTimeoutMs: 50,
						inspect: async (tx) => {
							await tx.query('SELECT pg_catalog.pg_sleep(1)');
							return 'healthy' as const;
						},
						apply,
					},
				],
			}),
		).resolves.toEqual([]);
		expect(query.mock.calls).toEqual([
			['BEGIN READ ONLY'],
			['ROLLBACK'],
			['BEGIN READ ONLY'],
			[
				"SELECT pg_catalog.set_config('search_path', pg_catalog.format('%I, pg_temp, %s', $1::pg_catalog.text, pg_catalog.current_setting('search_path')), true)",
				['public'],
			],
			["SET LOCAL lock_timeout = '25ms'"],
			["SET LOCAL statement_timeout = '50ms'"],
			[
				{
					text: 'SELECT pg_catalog.pg_sleep(1)',
					values: [],
					queryMode: 'extended',
				},
			],
			['ROLLBACK'],
		]);
	});

	it.each([
		[undefined, "SET LOCAL lock_timeout = '5000ms'"],
		[250, "SET LOCAL lock_timeout = '250ms'"],
	] as const)(
		'uses %s as the owned-CHECK scratch rendering lock timeout',
		async (lockTimeoutMs, expectedLockTimeout) => {
			const noTransaction = Object.assign(new Error('no transaction'), {
				code: '25P01',
			});
			const client = {
				query: undefined as unknown,
				release: vi.fn(),
				_txStatus: 'I',
			};
			const query = vi.fn(async (statement: unknown) => {
				const text =
					typeof statement === 'string'
						? statement
						: (statement as { text: string }).text;
				if (text.startsWith('SAVEPOINT') && client._txStatus === 'I')
					throw noTransaction;
				if (text === 'BEGIN') client._txStatus = 'T';
				if (text === 'ROLLBACK') client._txStatus = 'I';
				if (text.includes("current_setting('search_path')"))
					return { rows: [{ search_path: 'public' }] };
				return { rows: [] };
			});
			await expect(
				planPgApplicationSteps({
					client: Object.assign(client, { query }) as never,
					database: 'app',
					schema: 'public',
					steps: [
						{
							kind: 'assert',
							id: 'owned-check',
							digest: 'v1',
							phase: 'after-generated-ddl',
							...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
							inspect: async () => 'healthy' as const,
							apply,
						},
					],
					ownedChecks: new Map([
						[
							'owned-check',
							[
								{
									table: 'Projects',
									name: 'projectState',
									physicalTable: 'projects',
									physicalName: 'project_state',
									expression: 'true',
								},
							],
						],
					]),
				}),
			).resolves.toEqual([]);
			const statements = query.mock.calls.map(([statement]) =>
				typeof statement === 'string'
					? statement
					: (statement as { text: string }).text,
			);
			const lockTimeoutIndex = statements.indexOf(expectedLockTimeout);
			expect(lockTimeoutIndex).toBeGreaterThan(0);
			expect(
				statements.slice(lockTimeoutIndex - 1, lockTimeoutIndex + 1),
			).toEqual([
				"SELECT pg_catalog.set_config('search_path', pg_catalog.format('%I, pg_temp, %s', $1::pg_catalog.text, pg_catalog.current_setting('search_path')), true)",
				expectedLockTimeout,
			]);
		},
	);

	it('sets the target schema before every callback transaction', async () => {
		const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
		let inspectCount = 0;
		const step = {
			kind: 'assert' as const,
			id: 'state-check',
			digest: 'v1',
			phase: 'after-generated-ddl' as const,
			lockTimeoutMs: 25,
			statementTimeoutMs: 50,
			inspect: async (tx: PgApplicationStepTx) => {
				await tx.query('SELECT inspection callback');
				return inspectCount++ < 2 ? 'unhealthy' : 'healthy';
			},
			apply: async (tx: PgApplicationStepTx) => {
				await tx.query('SELECT apply callback');
			},
		};
		const input = {
			client: { query } as never,
			database: 'app',
			schema: 'Mixed Case',
			steps: [step],
		};

		await expect(planPgApplicationSteps(input)).resolves.toEqual([
			{
				kind: 'application-step',
				id: 'state-check',
				step: 'assert',
				inspected: true,
			},
		]);
		await expect(
			runPgApplicationSteps({ ...input, phase: 'after-generated-ddl' }),
		).resolves.toEqual(['application-step:state-check']);
		expect(
			query.mock.calls.filter(
				([text]) =>
					text ===
					"SELECT pg_catalog.set_config('search_path', pg_catalog.format('%I, pg_temp, %s', $1::pg_catalog.text, pg_catalog.current_setting('search_path')), true)",
			),
		).toEqual([
			[
				"SELECT pg_catalog.set_config('search_path', pg_catalog.format('%I, pg_temp, %s', $1::pg_catalog.text, pg_catalog.current_setting('search_path')), true)",
				['Mixed Case'],
			],
			[
				"SELECT pg_catalog.set_config('search_path', pg_catalog.format('%I, pg_temp, %s', $1::pg_catalog.text, pg_catalog.current_setting('search_path')), true)",
				['Mixed Case'],
			],
		]);
		expect(
			query.mock.calls.filter(
				([text]) => text === "SET LOCAL statement_timeout = '50ms'",
			),
		).toEqual([
			["SET LOCAL statement_timeout = '50ms'"],
			["SET LOCAL statement_timeout = '50ms'"],
		]);
	});

	it('passes canonical owned CHECK state to inspect without changing unowned inspection', async () => {
		const noTransaction = Object.assign(new Error('no transaction'), {
			code: '25P01',
		});
		const client = {
			query: undefined as unknown,
			release: vi.fn(),
			_txStatus: 'I',
		};
		const query = vi.fn(async (statement: unknown) => {
			const text =
				typeof statement === 'string'
					? statement
					: (statement as { text: string }).text;
			if (text.startsWith('SAVEPOINT') && client._txStatus === 'I')
				throw noTransaction;
			if (text === 'BEGIN') client._txStatus = 'T';
			if (text === 'ROLLBACK') client._txStatus = 'I';
			if (text.includes("current_setting('search_path')"))
				return { rows: [{ search_path: 'public' }] };
			if (text.includes('FROM pg_catalog.pg_constraint c')) return { rows: [] };
			return { rows: [] };
		});
		const inspect = vi.fn(async (_tx: PgApplicationStepTx, owned) => {
			expect(owned).toEqual({
				checks: [
					{
						table: 'Projects',
						name: 'projectState',
						physicalTable: 'projects',
						physicalName: 'project_state',
						state: 'absent',
					},
				],
			});
			return 'healthy' as const;
		});
		await expect(
			planPgApplicationSteps({
				client: Object.assign(client, { query }) as never,
				database: 'app',
				schema: 'public',
				steps: [
					{
						kind: 'assert',
						id: 'owned-check',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect,
						apply,
					},
				],
				ownedChecks: new Map([
					[
						'owned-check',
						[
							{
								table: 'Projects',
								name: 'projectState',
								physicalTable: 'projects',
								physicalName: 'project_state',
								expression: 'true',
							},
						],
					],
				]),
			}),
		).resolves.toEqual([]);
		expect(inspect).toHaveBeenCalledOnce();
		expect(query.mock.calls.map(([call]) => call)).toContain('BEGIN READ ONLY');
	});

	it('keeps same-named owned CHECK states associated with their physical tables', async () => {
		const noTransaction = Object.assign(new Error('no transaction'), {
			code: '25P01',
		});
		const client = {
			query: undefined as unknown,
			release: vi.fn(),
			_txStatus: 'I',
		};
		const query = vi.fn(
			async (statement: unknown, values?: readonly unknown[]) => {
				const text =
					typeof statement === 'string'
						? statement
						: (statement as { text: string }).text;
				if (text.startsWith('SAVEPOINT') && client._txStatus === 'I')
					throw noTransaction;
				if (text.startsWith('BEGIN')) client._txStatus = 'T';
				if (text === 'ROLLBACK') client._txStatus = 'I';
				if (text.includes("current_setting('search_path')"))
					return { rows: [{ search_path: 'public' }] };
				if (text.includes('SELECT pg_catalog.to_regclass'))
					return { rows: [{ exists: true }] };
				if (text.includes('FROM pg_catalog.pg_constraint c'))
					return values?.[0] === '"public"."projects"'
						? { rows: [] }
						: {
								rows: [
									{
										name: 'positive',
										expression: 'CHECK ((score > 0))',
										validated: true,
									},
								],
							};
				if (text.includes('FROM pg_catalog.pg_constraint'))
					return {
						rows: [
							{
								name:
									(values?.[1] as readonly string[] | undefined)?.[0] ??
									'owned_0',
								expression: 'CHECK ((score > 0))',
							},
						],
					};
				return { rows: [] };
			},
		);
		const inspect = vi.fn(async (_tx: PgApplicationStepTx, owned) => {
			expect(owned.checks).toEqual([
				{
					table: 'Projects',
					name: 'positive',
					physicalTable: 'projects',
					physicalName: 'positive',
					state: 'absent',
				},
				{
					table: 'Accounts',
					name: 'positive',
					physicalTable: 'accounts',
					physicalName: 'positive',
					state: 'healthy',
				},
			]);
			return 'healthy' as const;
		});

		await expect(
			planPgApplicationSteps({
				client: Object.assign(client, { query }) as never,
				database: 'app',
				schema: 'public',
				steps: [
					{
						kind: 'assert',
						id: 'same-named-checks',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect,
						apply,
					},
				],
				ownedChecks: new Map([
					[
						'same-named-checks',
						[
							{
								table: 'Projects',
								name: 'positive',
								physicalTable: 'projects',
								physicalName: 'positive',
								expression: 'score > 0',
							},
							{
								table: 'Accounts',
								name: 'positive',
								physicalTable: 'accounts',
								physicalName: 'positive',
								expression: 'score > 0',
							},
						],
					],
				]),
			}),
		).resolves.toEqual([]);
		expect(inspect).toHaveBeenCalledOnce();
	});

	it.each(['planning', 'execution'] as const)(
		'wraps an owned-CHECK rendering failure during %s with its original cause',
		async (phase) => {
			const renderingError = new Error('scratch table unavailable');
			const noTransaction = Object.assign(new Error('no transaction'), {
				code: '25P01',
			});
			const client = {
				query: undefined as unknown,
				release: vi.fn(),
				_txStatus: 'I',
			};
			const query = vi.fn(async (statement: unknown) => {
				const text =
					typeof statement === 'string'
						? statement
						: (statement as { text: string }).text;
				if (text.startsWith('SAVEPOINT') && client._txStatus === 'I')
					throw noTransaction;
				if (text.startsWith('BEGIN')) client._txStatus = 'T';
				if (text === 'ROLLBACK') client._txStatus = 'I';
				if (text.includes("current_setting('search_path')"))
					return { rows: [{ search_path: 'public' }] };
				if (text.includes('SELECT pg_catalog.to_regclass'))
					return { rows: [{ exists: true }] };
				if (text.includes('FROM pg_catalog.pg_constraint c'))
					return {
						rows: [
							{
								name: 'positive',
								expression: 'CHECK ((score > 0))',
								validated: true,
							},
						],
					};
				if (text.startsWith('CREATE TEMP TABLE ')) throw renderingError;
				return { rows: [] };
			});
			const steps = [
				{
					kind: 'assert' as const,
					id: 'owned-check-rendering',
					digest: 'v1',
					phase: 'after-generated-ddl' as const,
					inspect: async () => 'healthy' as const,
					apply,
				},
			];
			const ownedChecks = new Map([
				[
					'owned-check-rendering',
					[
						{
							table: 'Projects',
							name: 'positive',
							physicalTable: 'projects',
							physicalName: 'positive',
							expression: 'score > 0',
						},
					],
				],
			]);
			let caught: unknown;
			try {
				if (phase === 'planning')
					await planPgApplicationSteps({
						client: Object.assign(client, { query }) as never,
						database: 'app',
						schema: 'public',
						steps,
						ownedChecks,
					});
				else
					await runPgApplicationSteps({
						client: Object.assign(client, { query }) as never,
						database: 'app',
						schema: 'public',
						phase: 'after-generated-ddl',
						steps,
						ownedChecks,
					});
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(PgApplicationStepError);
			expect(caught).toMatchObject({
				refusal: 'application-step-failed',
				stepId: 'owned-check-rendering',
				message: 'scratch table unavailable',
			});
			expect((caught as Error).cause).toBe(renderingError);
		},
	);

	it('marks a session compromised before wrapping an owned-CHECK cleanup failure', async () => {
		const cleanupError = new Error('scratch rollback acknowledgement lost');
		const client = {
			query: undefined as unknown,
			release: vi.fn(),
			_txStatus: 'I',
		};
		const query = vi.fn(
			async (statement: unknown, values?: readonly unknown[]) => {
				const text =
					typeof statement === 'string'
						? statement
						: (statement as { text: string }).text;
				if (text.startsWith('BEGIN')) client._txStatus = 'T';
				if (text.startsWith('ROLLBACK TO SAVEPOINT')) throw cleanupError;
				if (text === 'ROLLBACK') client._txStatus = 'I';
				if (text.includes('SELECT pg_catalog.to_regclass'))
					return { rows: [{ exists: true }] };
				if (text.includes('FROM pg_catalog.pg_constraint c'))
					return {
						rows: [
							{
								name: 'positive',
								expression: 'CHECK ((score > 0))',
								validated: true,
							},
						],
					};
				if (text.includes('FROM pg_catalog.pg_constraint'))
					return {
						rows: [
							{
								name:
									(values?.[1] as readonly string[] | undefined)?.[0] ??
									'owned_0',
								expression: 'CHECK ((score > 0))',
							},
						],
					};
				return { rows: [] };
			},
		);
		let caught: unknown;
		try {
			await runPgApplicationSteps({
				client: Object.assign(client, { query }) as never,
				database: 'app',
				schema: 'public',
				phase: 'after-generated-ddl',
				steps: [
					{
						kind: 'assert',
						id: 'owned-check-cleanup',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect: async () => 'healthy' as const,
						apply,
					},
				],
				ownedChecks: new Map([
					[
						'owned-check-cleanup',
						[
							{
								table: 'Projects',
								name: 'positive',
								physicalTable: 'projects',
								physicalName: 'positive',
								expression: 'score > 0',
							},
						],
					],
				]),
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PgApplicationStepError);
		const cause = (caught as Error).cause;
		expect(cause).toMatchObject({ cleanupError });
		expect(readPgOutcomeSessionCompromise(client as never)).toBe(cause);
	});

	it('uses one admission transaction and one transaction per inspected assert', async () => {
		const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
		await expect(
			planPgApplicationSteps({
				client: { query } as never,
				database: 'app',
				schema: 'public',
				steps: [
					{
						kind: 'assert',
						id: 'first-check',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect: async () => 'healthy' as const,
						apply,
					},
					{
						kind: 'assert',
						id: 'second-check',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect: async () => 'healthy' as const,
						apply,
					},
				],
			}),
		).resolves.toEqual([]);
		expect(
			query.mock.calls.filter(([statement]) => statement === 'BEGIN READ ONLY'),
		).toHaveLength(3);
	});

	it('finishes all admissions before invoking an inspect callback', async () => {
		const inspect = vi.fn(async () => 'healthy' as const);
		mocks.chain.mockImplementation(async (ledger, stepAddress) =>
			stepAddress.name === 'last-check'
				? {
						ledger,
						address: stepAddress,
						events: [
							{
								eventId: 'open-claim',
								address: stepAddress,
								eventKind: 'intent',
								declared: {
									value: { id: 'last-check' },
									digest: 'v1',
								},
								controller: 'owner',
								controllerOid: '10',
							},
						],
					}
				: { ledger, address: stepAddress, events: [] },
		);
		await expect(
			planPgApplicationSteps({
				client: { query: vi.fn(async () => ({ rows: [] })) } as never,
				database: 'app',
				schema: 'public',
				steps: [
					{
						kind: 'assert',
						id: 'first-check',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect,
						apply,
					},
					{
						kind: 'assert',
						id: 'last-check',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect: async () => 'healthy' as const,
						apply,
					},
				],
			}),
		).rejects.toMatchObject({
			refusal: 'recovery-required',
			stepId: 'last-check',
		});
		expect(inspect).not.toHaveBeenCalled();
	});

	it('defers assert inspection while generated work is pending in check mode', async () => {
		const inspect = vi.fn(async () => 'unhealthy' as const);
		await expect(
			planPgApplicationSteps({
				client: { query: vi.fn(async () => ({ rows: [] })) } as never,
				database: 'app',
				schema: 'public',
				hasPendingGeneratedWork: true,
				check: true,
				steps: [
					{
						kind: 'assert',
						id: 'after-ddl-check',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect,
						apply,
					},
				],
			}),
		).resolves.toEqual([
			{
				kind: 'application-step',
				id: 'after-ddl-check',
				step: 'assert',
				inspected: false,
			},
		]);
		expect(inspect).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		'admits a deferred assert before generated work in %s mode',
		async (check) => {
			const inspect = vi.fn(async () => 'unhealthy' as const);
			const apply = vi.fn(async () => undefined);
			mocks.chain.mockImplementation(async (ledger, address) => ({
				ledger,
				address,
				events: [
					{
						eventId: 'open-claim',
						address,
						eventKind: 'intent',
						declared: { value: { id: 'deferred-check' }, digest: 'v1' },
						controller: 'owner',
						controllerOid: '10',
					},
				],
			}));
			await expect(
				planPgApplicationSteps({
					client: { query: vi.fn(async () => ({ rows: [] })) } as never,
					database: 'app',
					schema: 'public',
					hasPendingGeneratedWork: true,
					check,
					steps: [
						{
							kind: 'assert',
							id: 'deferred-check',
							digest: 'v1',
							phase: 'after-generated-ddl',
							inspect,
							apply,
						},
					],
				}),
			).rejects.toMatchObject({
				refusal: 'recovery-required',
				stepId: 'deferred-check',
			});
			expect(inspect).not.toHaveBeenCalled();
			expect(apply).not.toHaveBeenCalled();
		},
	);

	it('does not inspect asserts after the first unhealthy planning result', async () => {
		const secondInspect = vi.fn(async () => {
			throw new Error('second inspect must not run');
		});
		await expect(
			planPgApplicationSteps({
				client: { query: vi.fn(async () => ({ rows: [] })) } as never,
				database: 'app',
				schema: 'public',
				check: true,
				steps: [
					{
						kind: 'assert',
						id: 'first-check',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect: async () => 'unhealthy' as const,
						apply,
					},
					{
						kind: 'assert',
						id: 'second-check',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect: secondInspect,
						apply,
					},
				],
			}),
		).resolves.toEqual([
			{
				kind: 'application-step',
				id: 'first-check',
				step: 'assert',
				inspected: true,
			},
			{
				kind: 'application-step',
				id: 'second-check',
				step: 'assert',
				inspected: false,
			},
		]);
		expect(secondInspect).not.toHaveBeenCalled();
	});

	it('keeps mixed application steps in declaration order in check plans', async () => {
		await expect(
			planPgApplicationSteps({
				client: { query: vi.fn(async () => ({ rows: [] })) } as never,
				database: 'app',
				schema: 'public',
				check: true,
				steps: [
					{
						kind: 'assert',
						id: 'assert-first',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect: async () => 'unhealthy' as const,
						apply,
					},
					{
						kind: 'once',
						id: 'once-second',
						digest: 'v1',
						phase: 'after-generated-ddl',
						apply,
					},
				],
			}),
		).resolves.toEqual([
			{
				kind: 'application-step',
				id: 'assert-first',
				step: 'assert',
				inspected: false,
			},
			{ kind: 'application-step', id: 'once-second', step: 'once' },
		]);
	});

	it('verifies an assert after applying it before recording the ledger row', async () => {
		const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
		const inspect = vi.fn(async () => 'unhealthy' as const);
		const repair = vi.fn(async () => undefined);
		await expect(
			runPgApplicationSteps({
				client: { query } as never,
				database: 'app',
				schema: 'public',
				phase: 'after-generated-ddl',
				steps: [
					{
						kind: 'assert',
						id: 'state-check',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect,
						apply: repair,
					},
				],
			}),
		).rejects.toMatchObject({
			refusal: 'application-step-failed',
			stepId: 'state-check',
		});
		expect(repair).toHaveBeenCalledOnce();
		expect(inspect).toHaveBeenCalledTimes(2);
		expect(mocks.appendResolution).not.toHaveBeenCalled();
		expect(query.mock.calls.map(([text]) => text)).toContain('ROLLBACK');
	});

	it('classifies a server-rejected application-step COMMIT as failed', async () => {
		const commitError = Object.assign(new Error('deferred constraint'), {
			code: '23505',
		});
		const query = vi.fn(async (statement: string) => {
			if (statement === 'COMMIT') throw commitError;
			return queryWithCurrentController(statement);
		});
		await expect(
			runPgApplicationSteps({
				client: { query } as never,
				database: 'app',
				schema: 'public',
				phase: 'after-generated-ddl',
				steps: [
					{
						kind: 'once',
						id: 'commit-failure',
						digest: 'v1',
						phase: 'after-generated-ddl',
						apply,
					},
				],
			}),
		).rejects.toMatchObject({
			refusal: 'application-step-failed',
			stepId: 'commit-failure',
		});
		expect(query.mock.calls.map(([statement]) => statement)).not.toContain(
			'ROLLBACK',
		);
	});

	it('keeps an unacknowledged application-step COMMIT transport-ambiguous', async () => {
		const commitError = new Error('COMMIT acknowledgement lost');
		const query = vi.fn(async (statement: string) => {
			if (statement === 'COMMIT') throw commitError;
			return queryWithCurrentController(statement);
		});
		const client = { query };
		await expect(
			runPgApplicationSteps({
				client: client as never,
				database: 'app',
				schema: 'public',
				phase: 'after-generated-ddl',
				steps: [
					{
						kind: 'once',
						id: 'commit-ambiguous',
						digest: 'v1',
						phase: 'after-generated-ddl',
						apply,
					},
				],
			}),
		).rejects.toBeInstanceOf(PgCommitAcknowledgementAmbiguousError);
		expect(readPgOutcomeSessionCompromise(client as never)).toBe(commitError);
		expect(query.mock.calls.map(([statement]) => statement)).not.toContain(
			'ROLLBACK',
		);
	});

	it('keeps the callback failure when an application-step rollback fails', async () => {
		const callbackError = new Error('callback failed');
		const rollbackError = new Error('ROLLBACK acknowledgement lost');
		const query = vi.fn(async (statement: string) => {
			if (statement === 'ROLLBACK') throw rollbackError;
			return queryWithCurrentController(statement);
		});
		const client = { query };
		await expect(
			runPgApplicationSteps({
				client: client as never,
				database: 'app',
				schema: 'public',
				phase: 'after-generated-ddl',
				steps: [
					{
						kind: 'once',
						id: 'rollback-failure',
						digest: 'v1',
						phase: 'after-generated-ddl',
						apply: async () => {
							throw callbackError;
						},
					},
				],
			}),
		).rejects.toMatchObject({
			refusal: 'application-step-failed',
			stepId: 'rollback-failure',
			message: 'callback failed',
		});
		expect(readPgOutcomeSessionCompromise(client as never)).toBe(rollbackError);
	});

	it('treats a completed once with its recorded digest as complete in apply and check mode', async () => {
		mocks.chain.mockImplementation(async (ledger, address) =>
			completedOnceChain(ledger, address, 'v1'),
		);
		const query = vi.fn(async (text: string) =>
			queryWithCurrentController(text),
		);
		const completed = {
			kind: 'once' as const,
			id: 'items-backfill',
			digest: 'v1',
			phase: 'after-generated-ddl' as const,
			apply: vi.fn(async () => undefined),
		};
		const input = {
			client: { query } as never,
			database: 'app',
			schema: 'public',
			steps: [completed],
		};

		await expect(planPgApplicationSteps(input)).resolves.toEqual([]);
		await expect(
			runPgApplicationSteps({ ...input, phase: 'after-generated-ddl' }),
		).resolves.toEqual([]);
		expect(completed.apply).not.toHaveBeenCalled();
		expect(mocks.appendClaim).not.toHaveBeenCalled();
		expect(mocks.appendResolution).not.toHaveBeenCalled();
	});

	it.each([
		{
			value: { id: 'items-backfill', digest: 'v1', step: 'assert' },
			digest: 'v1',
		},
		{ value: { id: 'items-backfill', digest: 'v1' }, digest: 'v1' },
	] satisfies readonly LedgerPayload[])(
		'refuses a completed once with an incompatible recorded payload in apply and check mode',
		async (recorded) => {
			mocks.chain.mockImplementation(async (ledger, address) =>
				completedOnceChain(ledger, address, 'v1', recorded),
			);
			const query = vi.fn(async (text: string) =>
				queryWithCurrentController(text),
			);
			const completed = {
				kind: 'once' as const,
				id: 'items-backfill',
				digest: 'v1',
				phase: 'after-generated-ddl' as const,
				apply: vi.fn(async () => undefined),
			};
			const input = {
				client: { query } as never,
				database: 'app',
				schema: 'public',
				steps: [completed],
			};

			await expect(planPgApplicationSteps(input)).rejects.toMatchObject({
				refusal: 'application-step-changed',
				stepId: 'items-backfill',
			});
			await expect(
				runPgApplicationSteps({ ...input, phase: 'after-generated-ddl' }),
			).rejects.toMatchObject({
				refusal: 'application-step-changed',
				stepId: 'items-backfill',
			});
			expect(completed.apply).not.toHaveBeenCalled();
		},
	);

	it('revokes a callback transaction facade after the callback settles', async () => {
		const query = vi.fn(async (text: string) =>
			queryWithCurrentController(text),
		);
		let retained: PgApplicationStepTx | undefined;
		await expect(
			runPgApplicationSteps({
				client: { query } as never,
				database: 'app',
				schema: 'public',
				phase: 'after-generated-ddl',
				steps: [
					{
						kind: 'once',
						id: 'retained-facade',
						digest: 'v1',
						phase: 'after-generated-ddl',
						apply: async (tx) => {
							retained = tx;
						},
					},
				],
			}),
		).resolves.toEqual(['application-step:retained-facade']);
		const callsBeforeRetainedQuery = query.mock.calls.length;
		await expect(retained?.query('SELECT 1')).rejects.toThrow(
			'application step transaction facade is no longer active',
		);
		expect(query).toHaveBeenCalledTimes(callsBeforeRetainedQuery);
	});

	it('refuses a completed once whose recorded digest changes in apply and check mode', async () => {
		mocks.chain.mockImplementation(async (ledger, address) =>
			completedOnceChain(ledger, address, 'v1'),
		);
		const query = vi.fn(async (text: string) =>
			queryWithCurrentController(text),
		);
		const changed = {
			kind: 'once' as const,
			id: 'items-backfill',
			digest: 'v2',
			phase: 'after-generated-ddl' as const,
			apply: vi.fn(async () => undefined),
		};
		const input = {
			client: { query } as never,
			database: 'app',
			schema: 'public',
			steps: [changed],
		};

		await expect(planPgApplicationSteps(input)).rejects.toMatchObject({
			refusal: 'application-step-changed',
			stepId: 'items-backfill',
		});
		await expect(
			runPgApplicationSteps({ ...input, phase: 'after-generated-ddl' }),
		).rejects.toMatchObject({
			refusal: 'application-step-changed',
			stepId: 'items-backfill',
		});
		expect(changed.apply).not.toHaveBeenCalled();
		expect(mocks.appendClaim).not.toHaveBeenCalled();
		expect(mocks.appendResolution).not.toHaveBeenCalled();
	});
});
