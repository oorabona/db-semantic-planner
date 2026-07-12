/**
 * `dbsp generate` — the command's options must reach the DDL generator, and the
 * casing the schema declares must be honoured.
 *
 * Everything here drives `generateCommand` and asserts on what the adapter was
 * asked to do. Only the adapter and the schema loader are mocked; the command's
 * own wiring is the thing under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the adapter module
const mockAdapterGenerateDDL = vi.hoisted(() =>
	vi.fn((_schema, options) => {
		// Return different content based on options to verify they're passed
		const statements = ['CREATE TABLE test (id INTEGER)'];
		if (options?.includeDropStatements) {
			statements.unshift('DROP TABLE IF EXISTS test');
		}
		return statements;
	}),
);
const mockCreatePgsqlCompileOnlyAdapter = vi.hoisted(() =>
	vi.fn(() => ({
		generateDDL: mockAdapterGenerateDDL,
	})),
);

vi.mock('@dbsp/adapter-pgsql', () => ({
	createPgsqlCompileOnlyAdapter: (...args: unknown[]) =>
		mockCreatePgsqlCompileOnlyAdapter(...args),
}));

const loadSchema = vi.hoisted(() => vi.fn());
const loadSchemaFromCwd = vi.hoisted(() => vi.fn());
vi.mock('../utils/schema-loader.js', () => ({
	loadSchema,
	loadSchemaFromCwd,
}));

function makeLoadedSchema(dbCasing?: 'snake_case' | 'camelCase' | 'preserve') {
	return {
		model: { tables: new Map() },
		definition: {},
		tableNames: ['userProfiles'],
		...(dbCasing !== undefined ? { dbCasing } : {}),
	};
}

describe('generate command casing wiring', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		loadSchema.mockResolvedValue(makeLoadedSchema('snake_case'));
		loadSchemaFromCwd.mockResolvedValue({
			schema: makeLoadedSchema('snake_case'),
			path: 'dbsp.schema.ts',
		});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('uses the schema dbCasing export as the generate ddl default', async () => {
		// The declared casing must differ from the dialect default (snake_case),
		// or the assertion cannot tell "read the export" from "fell back".
		loadSchema.mockResolvedValue(makeLoadedSchema('camelCase'));
		loadSchemaFromCwd.mockResolvedValue({
			schema: makeLoadedSchema('camelCase'),
			path: 'dbsp.schema.ts',
		});
		const { generateCommand } = await import('./generate.js');

		await generateCommand.parseAsync(['ddl', '--schema', 'dbsp.schema.ts'], {
			from: 'user',
		});

		expect(mockCreatePgsqlCompileOnlyAdapter).toHaveBeenCalledWith(
			expect.objectContaining({ dbCasing: 'camelCase' }),
		);
	});

	it('lets explicit --casing win over the schema declaration', async () => {
		const { generateCommand } = await import('./generate.js');

		await generateCommand.parseAsync(
			['ddl', '--schema', 'dbsp.schema.ts', '--casing', 'none'],
			{ from: 'user' },
		);

		expect(mockCreatePgsqlCompileOnlyAdapter).toHaveBeenCalledWith(
			expect.objectContaining({ dbCasing: 'preserve' }),
		);
	});

	it('maps explicit --casing camel to camelCase dbCasing', async () => {
		const { generateCommand } = await import('./generate.js');

		await generateCommand.parseAsync(
			['ddl', '--schema', 'dbsp.schema.ts', '--casing', 'camel'],
			{ from: 'user' },
		);

		expect(mockCreatePgsqlCompileOnlyAdapter).toHaveBeenCalledWith(
			expect.objectContaining({ dbCasing: 'camelCase' }),
		);
	});

	it('keeps the historical snake_case default when the schema has no dbCasing export', async () => {
		loadSchema.mockResolvedValue(makeLoadedSchema());
		const { generateCommand } = await import('./generate.js');

		await generateCommand.parseAsync(['ddl', '--schema', 'dbsp.schema.ts'], {
			from: 'user',
		});

		expect(mockCreatePgsqlCompileOnlyAdapter).toHaveBeenCalledWith(
			expect.objectContaining({ dbCasing: 'snake_case' }),
		);
	});
});

describe('generate: a refused target never runs the user schema', () => {
	// Loading a schema executes the user's module. A target we are going to
	// refuse must be refused first.
	it.each([
		'manifest',
		'kysely',
		'typo',
	])('rejects %s without loading the schema', async (target) => {
		loadSchema.mockClear();
		const { generateCommand } = await import('./generate.js');
		const exit = vi
			.spyOn(process, 'exit')
			.mockImplementation((() => undefined) as never);
		const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

		await generateCommand.parseAsync(['node', 'dbsp', target]);

		expect(loadSchema).not.toHaveBeenCalled();
		expect(stderr).toHaveBeenCalledWith(
			expect.stringContaining(
				target === 'typo' ? 'Unknown target' : 'has been removed',
			),
		);
		exit.mockRestore();
		stderr.mockRestore();
	});
});

describe('generate: the command options reach the generator', () => {
	// These go through generateCommand. An earlier version of this block called the
	// mocked adapter directly and defined its own `isDialectSupported`, so it passed
	// no matter what the command did.

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('asks for DROP statements when --drop is set, and not otherwise', async () => {
		loadSchema.mockResolvedValue(makeLoadedSchema());
		const { generateCommand } = await import('./generate.js');

		await generateCommand.parseAsync(
			['ddl', '--schema', 'dbsp.schema.ts', '--drop'],
			{ from: 'user' },
		);
		expect(mockAdapterGenerateDDL).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({ includeDropStatements: true }),
		);

		await generateCommand.parseAsync(['ddl', '--schema', 'dbsp.schema.ts'], {
			from: 'user',
		});
		expect(mockAdapterGenerateDDL).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.not.objectContaining({ includeDropStatements: true }),
		);
	});

	it.each([
		'mysql',
		'sqlite',
		'mssql',
	])('warns that %s is unsupported and carries on with postgresql', async (dialect) => {
		loadSchema.mockResolvedValue(makeLoadedSchema());
		const { generateCommand } = await import('./generate.js');

		await generateCommand.parseAsync(
			['ddl', '--schema', 'dbsp.schema.ts', '--dialect', dialect],
			{ from: 'user' },
		);

		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("Only 'postgresql' dialect"),
		);
		// It warns, but it does not stop — the schema is still generated.
		expect(mockAdapterGenerateDDL).toHaveBeenCalled();
	});

	it('says nothing about the dialect when it is postgresql', async () => {
		loadSchema.mockResolvedValue(makeLoadedSchema());
		const { generateCommand } = await import('./generate.js');

		await generateCommand.parseAsync(
			['ddl', '--schema', 'dbsp.schema.ts', '--dialect', 'postgresql'],
			{ from: 'user' },
		);

		expect(console.error).not.toHaveBeenCalledWith(
			expect.stringContaining('dialect'),
		);
		expect(mockAdapterGenerateDDL).toHaveBeenCalled();
	});
});
