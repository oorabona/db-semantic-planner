import type { SchemaChange, SchemaDiff } from '@dbsp/adapter-pgsql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockComparePgsqlDatabaseSchema = vi.hoisted(() => vi.fn());
const mockGenerateMigrationSQL = vi.hoisted(() => vi.fn());
const mockGenerateMigrationFile = vi.hoisted(() => vi.fn());
const mockCreateDbConnection = vi.hoisted(() => vi.fn());
const mockCreatePgsqlAdapter = vi.hoisted(() => vi.fn());
const mockLoadSchema = vi.hoisted(() => vi.fn());
const mockGenerateMigrationFilename = vi.hoisted(() => vi.fn());
const mockScanMigrationFiles = vi.hoisted(() => vi.fn());
const mockWriteMigrationFile = vi.hoisted(() => vi.fn());

vi.mock('@dbsp/adapter-pgsql', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@dbsp/adapter-pgsql')>();
	return {
		...actual,
		comparePgsqlDatabaseSchema: (...args: unknown[]) =>
			mockComparePgsqlDatabaseSchema(...args),
		createPgsqlAdapter: (...args: unknown[]) => mockCreatePgsqlAdapter(...args),
		generateMigrationFile: (...args: unknown[]) =>
			mockGenerateMigrationFile(...args),
		generateMigrationSQL: (...args: unknown[]) =>
			mockGenerateMigrationSQL(...args),
		compileMigration: (...args: unknown[]) => ({
			normalizedChanges: [],
			plan: { autocommit: [], main: mockGenerateMigrationSQL(...args) },
			down: { statements: [], destructive: false },
		}),
		renderPhasedMigrationFiles: (compiled: { plan: { main: string[] } }) => ({
			content: compiled.plan.main.join('\n'),
		}),
	};
});

vi.mock('../utils/db-utils.js', () => ({
	createDbConnection: (...args: unknown[]) => mockCreateDbConnection(...args),
	redactDbUrl: (url: string) => url,
}));

vi.mock('../utils/schema-loader.js', () => ({
	loadSchema: (...args: unknown[]) => mockLoadSchema(...args),
}));

vi.mock('../migration-file.js', () => ({
	DEFAULT_MIGRATIONS_DIR: './migrations',
	generateMigrationFilename: (...args: unknown[]) =>
		mockGenerateMigrationFilename(...args),
	scanMigrationFiles: (...args: unknown[]) => mockScanMigrationFiles(...args),
	writeMigrationFile: (...args: unknown[]) => mockWriteMigrationFile(...args),
}));

import { migrateCommand } from './migrate.js';

function makeDiff(changes: Partial<SchemaChange>[] = []): SchemaDiff {
	return {
		changes: changes.map((change) => ({
			kind: 'add_column',
			table: 'users',
			column: 'fullName',
			destructive: false,
			details: 'add fullName',
			...change,
		})) as SchemaChange[],
		hasDestructive: changes.some((change) => change.destructive === true),
		summary: {
			tables: { added: 0, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: { added: 0, dropped: 0, altered: 0 },
		},
	};
}

describe('migrate dev — #315 casing wiring', () => {
	let adapter: { readonly kind: 'mock-pgsql-adapter' };
	let pool: { end: ReturnType<typeof vi.fn> };
	let schemaModel: { tables: Map<string, unknown> };

	beforeEach(() => {
		vi.clearAllMocks();
		adapter = { kind: 'mock-pgsql-adapter' };
		schemaModel = { tables: new Map() };
		pool = { end: vi.fn().mockResolvedValue(undefined) };
		mockCreateDbConnection.mockResolvedValue({ pool });
		mockCreatePgsqlAdapter.mockReturnValue(adapter);
		mockLoadSchema.mockResolvedValue({
			model: schemaModel,
			definition: {},
			tableNames: [],
			dbCasing: 'snake_case',
		});
		mockComparePgsqlDatabaseSchema.mockResolvedValue(
			makeDiff([{ details: 'add fullName' }]),
		);
		mockGenerateMigrationSQL.mockReturnValue([
			'ALTER TABLE "users" ADD COLUMN "full_name" text',
		]);
		mockGenerateMigrationFile.mockReturnValue('-- migration');
		mockGenerateMigrationFilename.mockReturnValue('0001_add_full_name.sql');
		mockScanMigrationFiles.mockReturnValue([]);
		mockWriteMigrationFile.mockReturnValue({
			path: 'migrations/0001_add_full_name.sql',
			checksum: 'abcdef1234567890',
		});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(((
			code?: string | number | null | undefined,
		) => {
			throw new Error(`process.exit:${code}`);
		}) as typeof process.exit);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('passes loaded dbCasing to comparePgsqlDatabaseSchema', async () => {
		await migrateCommand.parseAsync(
			['dev', '--schema', 'dbsp.schema.ts', '--db', 'postgres://localhost/db'],
			{ from: 'user' },
		);

		expect(mockCreatePgsqlAdapter).toHaveBeenCalledWith(pool);
		expect(mockComparePgsqlDatabaseSchema).toHaveBeenCalledWith(
			adapter,
			schemaModel,
			expect.objectContaining({ dbCasing: 'snake_case' }),
		);
		expect(mockWriteMigrationFile).toHaveBeenCalledOnce();
		expect(pool.end).toHaveBeenCalledOnce();
	});
});
