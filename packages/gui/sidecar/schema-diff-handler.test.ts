import type { IntrospectedModelIR } from '@dbsp/adapter-pgsql';
import { ModelIRImpl } from '@dbsp/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('@dbsp/adapter-pgsql', () => ({
	compareSchemata: vi.fn(),
}));

vi.mock('./connection-manager.js', () => ({
	introspectConnection: vi.fn(),
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

// Import after mocks are set up
const { compareSchemata } = await import('@dbsp/adapter-pgsql');
const { introspectConnection } = await import('./connection-manager.js');
const { findSchemaFile, loadSchema, SchemaLoadError } = await import(
	'./schema-loader.js'
);
const { handleSchemaDiff } = await import('./schema-diff-handler.js');

// ── Test fixtures ───────────────────────────────────────────────

const minimalModel = new ModelIRImpl(
	new Map([
		[
			'users',
			{
				name: 'users',
				columns: [
					{ name: 'id', type: 'integer', nullable: false, primaryKey: true },
					{ name: 'name', type: 'text', nullable: false, primaryKey: false },
				],
				foreignKeys: [],
				indexes: [],
			},
		],
	]),
	new Map(),
);

const introspectedModel: IntrospectedModelIR = {
	...minimalModel,
	hierarchies: [],
	introspectedAt: new Date('2026-01-01'),
	warnings: [],
};

const emptyDiff = {
	changes: [],
	hasDestructive: false,
	summary: {
		tables: { added: 0, dropped: 0 },
		columns: { added: 0, dropped: 0, altered: 0 },
		indexes: { added: 0, dropped: 0 },
		constraints: { added: 0, dropped: 0, altered: 0 },
	},
};

const diffWithChanges = {
	changes: [
		{
			kind: 'add_column' as const,
			table: 'users',
			column: 'email',
			destructive: false,
			details: 'Add column "email" (text, nullable)',
			meta: { someInternalData: true },
		},
		{
			kind: 'drop_column' as const,
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
};

// ── Tests ───────────────────────────────────────────────────────

describe('handleSchemaDiff', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('nominal', () => {
		it('returns empty diff when schemas match', async () => {
			vi.mocked(findSchemaFile).mockReturnValue('/project/dbsp.schema.ts');
			vi.mocked(loadSchema).mockResolvedValue({
				definition: {},
				model: minimalModel,
				tableNames: ['users'],
			});
			vi.mocked(introspectConnection).mockResolvedValue(introspectedModel);
			vi.mocked(compareSchemata).mockReturnValue(emptyDiff);

			const result = await handleSchemaDiff({
				connectionId: 'test-conn',
				schemaPath: '/project',
			});

			expect(result.changes).toEqual([]);
			expect(result.hasDestructive).toBe(false);
			expect(result.summary.tables.added).toBe(0);
			expect(compareSchemata).toHaveBeenCalledWith(
				minimalModel,
				introspectedModel,
			);
		});

		it('returns changes with destructive flag', async () => {
			vi.mocked(findSchemaFile).mockReturnValue('/project/dbsp.schema.ts');
			vi.mocked(loadSchema).mockResolvedValue({
				definition: {},
				model: minimalModel,
				tableNames: ['users'],
			});
			vi.mocked(introspectConnection).mockResolvedValue(introspectedModel);
			vi.mocked(compareSchemata).mockReturnValue(diffWithChanges);

			const result = await handleSchemaDiff({
				connectionId: 'test-conn',
				schemaPath: '/project',
			});

			expect(result.changes).toHaveLength(2);
			expect(result.hasDestructive).toBe(true);
			expect(result.changes[0]).toEqual({
				kind: 'add_column',
				table: 'users',
				column: 'email',
				destructive: false,
				details: 'Add column "email" (text, nullable)',
			});
			expect(result.changes[1]).toEqual({
				kind: 'drop_column',
				table: 'users',
				column: 'legacy',
				destructive: true,
				details: 'Drop column "legacy"',
			});
		});

		it('strips meta from changes for JSON transport', async () => {
			vi.mocked(findSchemaFile).mockReturnValue('/project/dbsp.schema.ts');
			vi.mocked(loadSchema).mockResolvedValue({
				definition: {},
				model: minimalModel,
				tableNames: ['users'],
			});
			vi.mocked(introspectConnection).mockResolvedValue(introspectedModel);
			vi.mocked(compareSchemata).mockReturnValue(diffWithChanges);

			const result = await handleSchemaDiff({
				connectionId: 'test-conn',
				schemaPath: '/project',
			});

			// meta should NOT appear in serialized output
			for (const change of result.changes) {
				expect(change).not.toHaveProperty('meta');
			}
		});
	});

	describe('schema path resolution', () => {
		it('throws when no schemaPath is provided', async () => {
			await expect(
				handleSchemaDiff({ connectionId: 'test-conn' }),
			).rejects.toThrow('No schema path provided');
		});

		it('throws when no schema file is found in directory', async () => {
			vi.mocked(findSchemaFile).mockReturnValue(null);

			await expect(
				handleSchemaDiff({
					connectionId: 'test-conn',
					schemaPath: '/empty-project',
				}),
			).rejects.toThrow('No schema file found');
		});
	});

	describe('schema load errors', () => {
		it('propagates SchemaLoadError from loadSchema', async () => {
			vi.mocked(findSchemaFile).mockReturnValue('/project/dbsp.schema.ts');
			vi.mocked(loadSchema).mockRejectedValue(
				new SchemaLoadError('Invalid schema format'),
			);

			await expect(
				handleSchemaDiff({
					connectionId: 'test-conn',
					schemaPath: '/project',
				}),
			).rejects.toThrow('Invalid schema format');
		});
	});

	describe('connection errors', () => {
		it('propagates introspection errors', async () => {
			vi.mocked(findSchemaFile).mockReturnValue('/project/dbsp.schema.ts');
			vi.mocked(loadSchema).mockResolvedValue({
				definition: {},
				model: minimalModel,
				tableNames: ['users'],
			});
			vi.mocked(introspectConnection).mockRejectedValue(
				new Error('Not connected'),
			);

			await expect(
				handleSchemaDiff({
					connectionId: 'bad-conn',
					schemaPath: '/project',
				}),
			).rejects.toThrow('Not connected');
		});
	});

	describe('dependency injection', () => {
		it('accepts custom getModel for testing', async () => {
			const customGetModel = vi.fn().mockResolvedValue(introspectedModel);
			vi.mocked(findSchemaFile).mockReturnValue('/project/dbsp.schema.ts');
			vi.mocked(loadSchema).mockResolvedValue({
				definition: {},
				model: minimalModel,
				tableNames: ['users'],
			});
			vi.mocked(compareSchemata).mockReturnValue(emptyDiff);

			await handleSchemaDiff(
				{ connectionId: 'test-conn', schemaPath: '/project' },
				customGetModel,
			);

			expect(customGetModel).toHaveBeenCalledWith('test-conn');
			expect(introspectConnection).not.toHaveBeenCalled();
		});
	});
});
