import type {
	ComparePgsqlDatabaseSchemaOptions,
	SchemaChange,
	SchemaDiff,
} from '@dbsp/adapter-pgsql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockComparePgsqlDatabaseSchema = vi.hoisted(() => vi.fn());
const mockIntrospect = vi.hoisted(() => vi.fn());
const mockCreateDbConnection = vi.hoisted(() => vi.fn());
const mockCreatePgsqlAdapter = vi.hoisted(() => vi.fn());
const mockLoadSchema = vi.hoisted(() => vi.fn());

vi.mock('@dbsp/adapter-pgsql', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@dbsp/adapter-pgsql')>();
	return {
		...actual,
		comparePgsqlDatabaseSchema: (...args: unknown[]) =>
			mockComparePgsqlDatabaseSchema(...args),
		createPgsqlAdapter: (...args: unknown[]) => mockCreatePgsqlAdapter(...args),
	};
});

vi.mock('../utils/db-utils.js', () => ({
	createDbConnection: (...args: unknown[]) => mockCreateDbConnection(...args),
	redactDbUrl: (url: string) => url,
}));

vi.mock('../utils/schema-loader.js', () => ({
	loadSchema: (...args: unknown[]) => mockLoadSchema(...args),
}));

import { verifyCommand } from './verify.js';

function makeDiff(changes: Partial<SchemaChange>[] = []): SchemaDiff {
	return {
		changes: changes.map((change) => ({
			kind: 'create_table',
			table: 'unknown',
			destructive: false,
			details: '',
			...change,
		})) as SchemaChange[],
		hasDestructive: changes.some((change) => change.destructive === true),
		summary: {
			tables: {
				added: changes.filter((change) => change.kind === 'create_table')
					.length,
				dropped: changes.filter((change) => change.kind === 'drop_table')
					.length,
			},
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: {
				added: changes.filter(
					(change) => change.kind === 'add_check_constraint',
				).length,
				dropped: changes.filter(
					(change) => change.kind === 'drop_check_constraint',
				).length,
				altered: 0,
			},
		},
	};
}

function makeLoadedSchema(dbCasing?: 'snake_case' | 'camelCase' | 'preserve') {
	return {
		model: {
			tables: new Map([
				['userProfiles', {}],
				['posts', {}],
			]),
		},
		definition: {},
		tableNames: ['userProfiles', 'posts'],
		...(dbCasing !== undefined ? { dbCasing } : {}),
	};
}

function readStdout(logSpy: ReturnType<typeof vi.spyOn>): string {
	return logSpy.mock.calls
		.map((call: unknown[]) =>
			call.map((value: unknown) => String(value)).join(' '),
		)
		.join('\n');
}

async function runVerify(args: string[] = []): Promise<void> {
	await verifyCommand.parseAsync(
		['--schema', 'dbsp.schema.ts', '--db', 'postgres://localhost/db', ...args],
		{ from: 'user' },
	);
}

describe('verify command live diff integration', () => {
	let adapter: { introspect: (...args: unknown[]) => unknown };
	let loadedSchema: ReturnType<typeof makeLoadedSchema>;
	let pool: { end: ReturnType<typeof vi.fn> };
	let logSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		adapter = { introspect: (...args: unknown[]) => mockIntrospect(...args) };
		loadedSchema = makeLoadedSchema('snake_case');
		pool = { end: vi.fn().mockResolvedValue(undefined) };
		mockCreateDbConnection.mockResolvedValue({ pool });
		mockCreatePgsqlAdapter.mockReturnValue(adapter);
		mockLoadSchema.mockResolvedValue(loadedSchema);
		mockComparePgsqlDatabaseSchema.mockResolvedValue(makeDiff());
		mockIntrospect.mockResolvedValue({
			tables: new Map([
				['userProfiles', {}],
				['posts', {}],
			]),
		});
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(((
			code?: string | number | null | undefined,
		) => {
			throw new Error(`process.exit:${code}`);
		}) as typeof process.exit);
		process.exitCode = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	it('uses live PostgreSQL comparison and honours schema dbCasing', async () => {
		mockComparePgsqlDatabaseSchema.mockImplementation(
			async (
				_pool: unknown,
				_desired: unknown,
				options?: ComparePgsqlDatabaseSchemaOptions,
			) => {
				if (
					options?.schema === 'tenant_1' &&
					options.dbCasing === 'snake_case'
				) {
					return makeDiff();
				}
				return makeDiff([
					{
						kind: 'create_table',
						table: 'userProfiles',
						details: 'CREATE TABLE "userProfiles"',
					},
				]);
			},
		);

		await runVerify(['--schema-name', 'tenant_1']);

		expect(readStdout(logSpy)).toContain('Schema matches database');
		expect(process.exitCode).toBe(0);
		expect(mockCreatePgsqlAdapter).toHaveBeenCalledWith(pool);
		expect(mockComparePgsqlDatabaseSchema).toHaveBeenCalledWith(
			adapter,
			loadedSchema.model,
			expect.objectContaining({
				dbCasing: 'snake_case',
				schema: 'tenant_1',
			}),
		);
		expect(mockIntrospect).toHaveBeenCalledWith({ schema: 'tenant_1' });
		expect(pool.end).toHaveBeenCalledOnce();
	});

	it('reports drift and preserves the JSON success shape and exit code', async () => {
		mockComparePgsqlDatabaseSchema.mockResolvedValue(
			makeDiff([
				{
					kind: 'create_table',
					table: 'posts',
					details: 'CREATE TABLE "posts"',
				},
			]),
		);
		mockIntrospect.mockResolvedValue({
			tables: new Map([['userProfiles', {}]]),
		});

		await runVerify(['--json']);

		const json = JSON.parse(readStdout(logSpy));
		expect(json).toEqual({
			valid: false,
			issues: [
				{
					severity: 'error',
					type: 'missing_table_in_db',
					table: 'posts',
					message: 'CREATE TABLE "posts"',
				},
			],
			schemaTables: ['userProfiles', 'posts'],
			dbTables: ['userProfiles'],
			summary: {
				tables: { added: 1, dropped: 0 },
				columns: { added: 0, dropped: 0, altered: 0 },
				indexes: { added: 0, dropped: 0 },
				constraints: { added: 0, dropped: 0, altered: 0 },
			},
			hasDestructive: false,
		});
		expect(json).not.toHaveProperty('diff');
		expect(process.exitCode).toBe(1);
		expect(pool.end).toHaveBeenCalledOnce();
	});

	it('keeps CHECK-only drift on the existing warning exit path', async () => {
		mockComparePgsqlDatabaseSchema.mockResolvedValue(
			makeDiff([
				{
					kind: 'drop_check_constraint',
					table: 'userProfiles',
					destructive: true,
					details:
						'DROP CHECK constraint "user_profiles_age_check" from "userProfiles"',
				},
				{
					kind: 'add_check_constraint',
					table: 'userProfiles',
					details:
						'ADD CHECK constraint "user_profiles_age_check" to "userProfiles"',
				},
			]),
		);

		await runVerify();

		const stdout = readStdout(logSpy);
		expect(stdout).toContain('Schema matches database');
		expect(stdout).toContain('1 warning(s)');
		expect(stdout).toContain('1 info:');
		expect(process.exitCode).toBe(0);
	});

	it('prints live canonicalization warnings without changing JSON stdout', async () => {
		mockComparePgsqlDatabaseSchema.mockImplementation(
			async (
				_pool: unknown,
				_desired: unknown,
				options?: ComparePgsqlDatabaseSchemaOptions,
			) => {
				options?.onExpressionCanonicalizationWarning?.({
					kind: 'check_constraint',
					table: 'user_profiles\n\u001b[2J',
					name: 'age_check',
					constraint: 'age_check',
					message:
						'Could not canonicalize CHECK constraint "user_profiles"."age_check"; falling back to best-effort raw string comparison.',
					cause: new Error('scratch DDL failed'),
				});
				return makeDiff();
			},
		);

		await runVerify(['--json']);

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('Could not canonicalize CHECK constraint'),
		);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('user_profiles\\n\\u001b[2J.age_check'),
		);
		const json = JSON.parse(readStdout(logSpy));
		expect(json).toMatchObject({
			valid: true,
			issues: [],
			schemaTables: ['userProfiles', 'posts'],
			dbTables: ['userProfiles', 'posts'],
			hasDestructive: false,
		});
		expect(json).not.toHaveProperty('warnings');
		expect(process.exitCode).toBe(0);
	});
});
