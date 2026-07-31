import type { SchemaDiff } from '@dbsp/adapter-pgsql';
import { ModelIRImpl } from '@dbsp/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchemaDiffComparisonOperation } from './schema-diff-handler.js';

vi.mock('@dbsp/adapter-pgsql', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@dbsp/adapter-pgsql')>();
	return {
		...actual,
		generateMigrationSQL: vi.fn(),
		generateDownSQL: vi.fn(),
	};
});

vi.mock('./connection-manager.js', () => ({
	getConnectionInfo: vi.fn(),
	getPool: vi.fn(),
}));

vi.mock('./schema-loader.js', () => ({
	findSchemaFile: vi.fn(),
	loadSchema: vi.fn(),
	SchemaLoadError: class SchemaLoadError extends Error {
		constructor(message: string) {
			super(message);
			this.name = 'SchemaLoadError';
		}
	},
}));

const { generateDownSQL, generateMigrationSQL } = await import(
	'@dbsp/adapter-pgsql'
);
const { getConnectionInfo } = await import('./connection-manager.js');
const { findSchemaFile, loadSchema, SchemaLoadError } = await import(
	'./schema-loader.js'
);
const { handleSchemaDiff } = await import('./schema-diff-handler.js');

const minimalModel = new ModelIRImpl(
	new Map([
		[
			'users',
			{
				name: 'users',
				columns: [
					{ name: 'id', type: 'integer', nullable: false, primaryKey: true },
				],
				foreignKeys: [],
				indexes: [],
			},
		],
	]),
	new Map(),
);

const emptyDiff = {
	changes: [],
	hasDestructive: false,
	summary: {
		tables: { added: 0, dropped: 0 },
		columns: { added: 0, dropped: 0, altered: 0 },
		indexes: { added: 0, dropped: 0 },
		constraints: { added: 0, dropped: 0, altered: 0 },
	},
} satisfies SchemaDiff;

const diffWithChanges = {
	changes: [
		{
			kind: 'add_column',
			table: 'users',
			column: 'email',
			destructive: false,
			details: 'Add column "email" (text, nullable)',
			meta: { someInternalData: true },
		},
		{
			kind: 'drop_column',
			table: 'users',
			column: 'legacy',
			destructive: true,
			details: 'Drop column "legacy"',
			meta: { anotherMeta: 42 },
		},
	],
	hasDestructive: true,
	summary: {
		tables: { added: 0, dropped: 0 },
		columns: { added: 1, dropped: 1, altered: 0 },
		indexes: { added: 0, dropped: 0 },
		constraints: { added: 0, dropped: 0, altered: 0 },
	},
} satisfies SchemaDiff;

function givenLoadedSchema(dbCasing?: 'snake_case' | 'camelCase' | 'preserve') {
	vi.mocked(findSchemaFile).mockReturnValue('/project/dbsp.schema.ts');
	vi.mocked(loadSchema).mockResolvedValue({
		definition: {},
		model: minimalModel,
		tableNames: ['users'],
		...(dbCasing !== undefined ? { dbCasing } : {}),
	});
}

function comparisonReturning(
	diff: SchemaDiff,
): ReturnType<typeof vi.fn<SchemaDiffComparisonOperation>> {
	return vi.fn<SchemaDiffComparisonOperation>().mockResolvedValue(diff);
}

describe('handleSchemaDiff', () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it('uses the completed live comparison seam with push-equivalent options', async () => {
		givenLoadedSchema('snake_case');
		vi.mocked(getConnectionInfo).mockReturnValue({
			database: 'app',
			host: 'localhost',
			port: 5432,
			user: 'app',
			schema: 'tenant_1',
		});
		const compare = comparisonReturning(emptyDiff);

		const result = await handleSchemaDiff(
			{ connectionId: 'test-conn', schemaPath: '/project' },
			compare,
		);

		expect(compare).toHaveBeenCalledWith(
			'test-conn',
			minimalModel,
			expect.objectContaining({
				schema: 'tenant_1',
				dbCasing: 'snake_case',
				onExpressionCanonicalizationWarning: expect.any(Function),
			}),
		);
		const options = compare.mock.calls[0]?.[2];
		expect(options).not.toHaveProperty('requireExpressionCanonicalization');
		expect(options).not.toHaveProperty('previouslyAppliedDiff');
		expect(options).not.toHaveProperty('canonicalizeExpressions');
		expect(result.warnings).toEqual([]);
	});

	it('serializes a raw fallback without its diagnostic', async () => {
		givenLoadedSchema();
		const compare: SchemaDiffComparisonOperation = async (
			_connectionId,
			_desired,
			options,
		) => {
			options.onExpressionCanonicalizationWarning?.({
				kind: 'column_default',
				table: 'jobs',
				name: 'state',
				outcome: 'unavailable',
				message:
					'Could not canonicalize one column default with PostgreSQL; falling back to verbatim raw comparison. Inspect the warning table and name fields for its identity. Reason: role app_writer rejected value classified-secret',
				cause: new Error('role app_writer rejected value classified-secret'),
				comparison: 'raw',
			});
			return emptyDiff;
		};

		const result = await handleSchemaDiff(
			{ connectionId: 'test-conn', schemaPath: '/project' },
			compare,
		);

		expect(result.warnings).toEqual([
			{
				kind: 'column_default',
				table: 'jobs',
				name: 'state',
				outcome: 'unavailable',
				comparison: 'raw',
				message:
					'PostgreSQL could not canonicalize column default jobs.state (unavailable); it was compared as raw text.',
			},
		]);
		const serialized = JSON.stringify(result.warnings);
		expect(serialized).not.toContain('app_writer');
		expect(serialized).not.toContain('classified-secret');
	});

	it('serializes an unpaired default without inferring its cause', async () => {
		givenLoadedSchema();
		const compare: SchemaDiffComparisonOperation = async (
			_connectionId,
			_desired,
			options,
		) => {
			options.onExpressionCanonicalizationWarning?.({
				kind: 'column_default',
				table: 'jobs',
				name: 'state',
				outcome: 'unavailable',
				comparison: 'unpaired',
				side: 'desired',
				message: 'The table is absent from the database',
				cause: new Error('The table is absent from the database'),
			});
			return emptyDiff;
		};

		const result = await handleSchemaDiff(
			{ connectionId: 'test-conn', schemaPath: '/project' },
			compare,
		);

		expect(result.warnings).toEqual([
			{
				kind: 'column_default',
				table: 'jobs',
				name: 'state',
				outcome: 'unavailable',
				comparison: 'unpaired',
				side: 'desired',
				message:
					'Column default jobs.state had no database default counterpart to compare against.',
			},
		]);
	});

	it('generates schema-qualified SQL after the completed comparison', async () => {
		givenLoadedSchema();
		vi.mocked(getConnectionInfo).mockReturnValue({
			database: 'app',
			host: 'localhost',
			port: 5432,
			user: 'app',
			schema: 'tenant_1',
		});
		vi.mocked(generateMigrationSQL).mockReturnValue([
			'ALTER TABLE "users" ADD COLUMN "email" text;',
		]);
		vi.mocked(generateDownSQL).mockReturnValue([
			'ALTER TABLE "users" DROP COLUMN "email";',
		]);

		const result = await handleSchemaDiff(
			{ connectionId: 'test-conn', schemaPath: '/project' },
			comparisonReturning(diffWithChanges),
		);

		expect(generateMigrationSQL).toHaveBeenCalledWith(diffWithChanges, {
			schemaName: 'tenant_1',
		});
		expect(generateDownSQL).toHaveBeenCalledWith(diffWithChanges, {
			schemaName: 'tenant_1',
		});
		expect(result.upSQL).toEqual([
			'ALTER TABLE "users" ADD COLUMN "email" text;',
		]);
	});

	it('leaves SQL unqualified for a public connection schema', async () => {
		givenLoadedSchema();
		vi.mocked(getConnectionInfo).mockReturnValue({
			database: 'app',
			host: 'localhost',
			port: 5432,
			user: 'app',
			schema: 'public',
		});
		vi.mocked(generateMigrationSQL).mockReturnValue([]);
		vi.mocked(generateDownSQL).mockReturnValue([]);

		await handleSchemaDiff(
			{ connectionId: 'test-conn', schemaPath: '/project' },
			comparisonReturning(diffWithChanges),
		);

		expect(generateMigrationSQL).toHaveBeenCalledWith(
			diffWithChanges,
			undefined,
		);
		expect(generateDownSQL).toHaveBeenCalledWith(diffWithChanges, undefined);
	});

	it('preserves change metadata for the side-by-side diff', async () => {
		givenLoadedSchema();
		vi.mocked(generateMigrationSQL).mockReturnValue([]);
		vi.mocked(generateDownSQL).mockReturnValue([]);

		const result = await handleSchemaDiff(
			{ connectionId: 'test-conn', schemaPath: '/project' },
			comparisonReturning(diffWithChanges),
		);

		expect(result.changes).toEqual([
			expect.objectContaining({ meta: { someInternalData: true } }),
			expect.objectContaining({ meta: { anotherMeta: 42 } }),
		]);
		expect(result.hasDestructive).toBe(true);
	});

	it('rejects a missing schema path before it starts a comparison', async () => {
		await expect(
			handleSchemaDiff({ connectionId: 'test-conn' }),
		).rejects.toThrow('No schema path provided');
	});

	it('rejects a directory with no schema file before it starts a comparison', async () => {
		vi.mocked(findSchemaFile).mockReturnValue(null);
		const compare = comparisonReturning(emptyDiff);

		await expect(
			handleSchemaDiff(
				{ connectionId: 'test-conn', schemaPath: '/empty-project' },
				compare,
			),
		).rejects.toThrow('No schema file found');
		expect(compare).not.toHaveBeenCalled();
	});

	it('propagates schema-load failures', async () => {
		vi.mocked(findSchemaFile).mockReturnValue('/project/dbsp.schema.ts');
		vi.mocked(loadSchema).mockRejectedValue(
			new SchemaLoadError('Invalid schema format'),
		);

		await expect(
			handleSchemaDiff(
				{ connectionId: 'test-conn', schemaPath: '/project' },
				comparisonReturning(emptyDiff),
			),
		).rejects.toThrow('Invalid schema format');
	});

	it('propagates comparison failures', async () => {
		givenLoadedSchema();
		const compare = vi
			.fn<SchemaDiffComparisonOperation>()
			.mockRejectedValue(new Error('Not connected'));

		await expect(
			handleSchemaDiff(
				{ connectionId: 'bad-conn', schemaPath: '/project' },
				compare,
			),
		).rejects.toThrow('Not connected');
	});

	it('does not generate SQL for an empty diff', async () => {
		givenLoadedSchema();

		const result = await handleSchemaDiff(
			{ connectionId: 'test-conn', schemaPath: '/project' },
			comparisonReturning(emptyDiff),
		);

		expect(result.upSQL).toEqual([]);
		expect(result.downSQL).toEqual([]);
		expect(generateMigrationSQL).not.toHaveBeenCalled();
		expect(generateDownSQL).not.toHaveBeenCalled();
	});
});
