import type { SchemaChange, SchemaDiff } from '@dbsp/adapter-pgsql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockComparePgsqlDatabaseSchema = vi.hoisted(() => vi.fn());
const mockGenerateDDL = vi.hoisted(() => vi.fn());
const mockGenerateMigrationSQL = vi.hoisted(() => vi.fn());
const mockExecuteDdl = vi.hoisted(() => vi.fn());
const mockCreateDbConnection = vi.hoisted(() => vi.fn());
const mockLoadSchema = vi.hoisted(() => vi.fn());

vi.mock('@dbsp/adapter-pgsql', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@dbsp/adapter-pgsql')>();
	return {
		comparePgsqlDatabaseSchema: (...args: unknown[]) =>
			mockComparePgsqlDatabaseSchema(...args),
		generateDDL: (...args: unknown[]) => mockGenerateDDL(...args),
		generateMigrationSQL: (...args: unknown[]) =>
			mockGenerateMigrationSQL(...args),
		getNamingPluginForDbCasing: actual.getNamingPluginForDbCasing,
	};
});

vi.mock('../ddl-executor.js', () => ({
	executeDdl: (...args: unknown[]) => mockExecuteDdl(...args),
}));

vi.mock('../utils/db-utils.js', () => ({
	createDbConnection: (...args: unknown[]) => mockCreateDbConnection(...args),
	redactDbUrl: (url: string) => url,
}));

vi.mock('../utils/schema-loader.js', () => ({
	loadSchema: (...args: unknown[]) => mockLoadSchema(...args),
}));

import { pushCommand } from './push.js';

function makeDiff(changes: Partial<SchemaChange>[] = []): SchemaDiff {
	return {
		changes: changes.map((change) => ({
			kind: 'create_table',
			table: 'users',
			destructive: false,
			details: 'create users',
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

describe('push — #315 casing and convergence wiring', () => {
	let pool: { end: ReturnType<typeof vi.fn> };
	let schemaModel: { tables: Map<string, unknown> };

	beforeEach(() => {
		vi.clearAllMocks();
		mockGenerateDDL.mockReset();
		schemaModel = { tables: new Map() };
		pool = { end: vi.fn().mockResolvedValue(undefined) };
		mockCreateDbConnection.mockResolvedValue({ pool });
		mockLoadSchema.mockResolvedValue({
			model: schemaModel,
			definition: {},
			tableNames: [],
			dbCasing: 'snake_case',
		});
		mockGenerateMigrationSQL.mockReturnValue(['CREATE TABLE "users" ()']);
		mockExecuteDdl.mockResolvedValue({ statementsExecuted: 1 });
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

	it('passes loaded dbCasing to the live diff and re-diffs after applying', async () => {
		const firstDiff = makeDiff([
			{
				kind: 'add_column',
				table: 'users',
				column: 'fullName',
				details: 'add fullName',
			},
		]);
		mockComparePgsqlDatabaseSchema
			.mockResolvedValueOnce(firstDiff)
			.mockResolvedValueOnce(makeDiff([]));

		await pushCommand.parseAsync(
			[
				'--schema',
				'dbsp.schema.ts',
				'--db',
				'postgres://localhost/db',
				'--json',
			],
			{ from: 'user' },
		);

		expect(mockComparePgsqlDatabaseSchema).toHaveBeenCalledTimes(2);
		expect(mockComparePgsqlDatabaseSchema).toHaveBeenNthCalledWith(
			1,
			pool,
			schemaModel,
			expect.objectContaining({ dbCasing: 'snake_case' }),
		);
		expect(mockComparePgsqlDatabaseSchema).toHaveBeenNthCalledWith(
			2,
			pool,
			schemaModel,
			expect.objectContaining({
				dbCasing: 'snake_case',
				previouslyAppliedDiff: firstDiff,
			}),
		);
		expect(mockExecuteDdl.mock.invocationCallOrder[0]!).toBeLessThan(
			mockComparePgsqlDatabaseSchema.mock.invocationCallOrder[1]!,
		);
		expect(pool.end).toHaveBeenCalledOnce();
	});

	it('passes loaded dbCasing to drop-mode generateDDL as a naming plugin', async () => {
		mockGenerateDDL.mockImplementation((_model, options) => {
			const naming = options.naming as {
				toDatabase(identifier: string): string;
			};
			const tableName = naming.toDatabase('userProfiles');
			return [
				`DROP TABLE IF EXISTS "${tableName}" CASCADE;`,
				`CREATE TABLE "${tableName}" ("id" integer);`,
			];
		});

		await pushCommand.parseAsync(
			[
				'--schema',
				'dbsp.schema.ts',
				'--db',
				'postgres://localhost/db',
				'--drop',
				'--json',
			],
			{ from: 'user' },
		);

		const generateOptions = mockGenerateDDL.mock.calls[0]![1] as {
			naming?: { toDatabase(identifier: string): string };
		};
		expect(generateOptions.naming?.toDatabase('userProfiles')).toBe(
			'user_profiles',
		);
		expect(mockExecuteDdl).toHaveBeenCalledWith(
			pool,
			expect.arrayContaining(['DROP TABLE IF EXISTS "user_profiles" CASCADE;']),
			expect.any(Object),
		);
		expect(pool.end).toHaveBeenCalledOnce();
	});

	it('keeps drop-mode generateDDL options unchanged when schema has no dbCasing export', async () => {
		mockLoadSchema.mockResolvedValue({
			model: schemaModel,
			definition: {},
			tableNames: [],
		});
		mockGenerateDDL.mockReturnValue(['DROP TABLE IF EXISTS "userProfiles";']);

		await pushCommand.parseAsync(
			[
				'--schema',
				'dbsp.schema.ts',
				'--db',
				'postgres://localhost/db',
				'--drop',
				'--json',
			],
			{ from: 'user' },
		);

		expect(mockGenerateDDL).toHaveBeenCalledWith(
			schemaModel,
			expect.not.objectContaining({ naming: expect.anything() }),
		);
		expect(pool.end).toHaveBeenCalledOnce();
	});

	it('surfaces non-convergent CHECK drift from the post-apply re-diff', async () => {
		const firstDiff = makeDiff([
			{
				kind: 'drop_check_constraint',
				table: 'users',
				destructive: true,
				details: 'drop stale check',
				meta: {
					check: {
						name: 'users_name_check',
						expression: 'fullName <> $$bad$$',
					},
				},
			},
			{
				kind: 'add_check_constraint',
				table: 'users',
				destructive: true,
				details: 'add desired check',
				meta: {
					check: {
						name: 'users_name_check',
						expression: 'fullName <> $$bad$$',
					},
				},
			},
		]);
		mockComparePgsqlDatabaseSchema
			.mockResolvedValueOnce(firstDiff)
			.mockRejectedValueOnce(
				new Error('Non-convergent CHECK constraint diff for "users"'),
			);

		await expect(
			pushCommand.parseAsync(
				['--schema', 'dbsp.schema.ts', '--db', 'postgres://localhost/db'],
				{ from: 'user' },
			),
		).rejects.toThrow('process.exit:1');

		expect(mockComparePgsqlDatabaseSchema).toHaveBeenCalledTimes(2);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('Non-convergent CHECK constraint diff'),
		);
		expect(console.log).not.toHaveBeenCalledWith(
			expect.stringContaining('Push complete'),
		);
		expect(pool.end).toHaveBeenCalledOnce();
	});

	it('fails when post-apply re-diff still has non-declined drift', async () => {
		const firstDiff = makeDiff([
			{
				kind: 'add_column',
				table: 'users',
				column: 'display_name',
				details: 'Add column "display_name"',
			},
		]);
		mockComparePgsqlDatabaseSchema
			.mockResolvedValueOnce(firstDiff)
			.mockResolvedValueOnce(
				makeDiff([
					{
						kind: 'add_column',
						table: 'users',
						column: 'display_name',
						details: 'Add column "display_name"',
					},
				]),
			);

		await expect(
			pushCommand.parseAsync(
				['--schema', 'dbsp.schema.ts', '--db', 'postgres://localhost/db'],
				{ from: 'user' },
			),
		).rejects.toThrow('process.exit:1');

		expect(mockComparePgsqlDatabaseSchema).toHaveBeenCalledTimes(2);
		expect(mockExecuteDdl).toHaveBeenCalledOnce();
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('outstanding change(s) remain'),
		);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining('Add column "display_name"'),
		);
		expect(console.log).not.toHaveBeenCalledWith(
			expect.stringContaining('Push complete'),
		);
		expect(pool.end).toHaveBeenCalledOnce();
	});

	it('allows residual destructive changes that additive push deliberately skipped', async () => {
		const skippedDrop = {
			kind: 'drop_column',
			table: 'users',
			column: 'legacy_name',
			destructive: true,
			details: 'Drop column "legacy_name"',
		} satisfies Partial<SchemaChange>;
		const firstDiff = makeDiff([
			{
				kind: 'add_column',
				table: 'users',
				column: 'display_name',
				details: 'Add column "display_name"',
			},
			skippedDrop,
		]);
		mockComparePgsqlDatabaseSchema
			.mockResolvedValueOnce(firstDiff)
			.mockResolvedValueOnce(makeDiff([skippedDrop]));

		await pushCommand.parseAsync(
			['--schema', 'dbsp.schema.ts', '--db', 'postgres://localhost/db'],
			{ from: 'user' },
		);

		expect(mockComparePgsqlDatabaseSchema).toHaveBeenCalledTimes(2);
		expect(mockExecuteDdl).toHaveBeenCalledOnce();
		expect(console.log).toHaveBeenCalledWith(
			'⚠️  1 non-additive change(s) skipped:',
		);
		expect(console.log).toHaveBeenCalledWith('   - Drop column "legacy_name"');
		expect(console.log).toHaveBeenCalledWith(
			expect.stringContaining('Push complete'),
		);
		expect(console.error).not.toHaveBeenCalled();
		expect(pool.end).toHaveBeenCalledOnce();
	});
});
