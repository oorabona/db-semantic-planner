import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfigLoad = vi.hoisted(() => vi.fn());
const mockConfigSetConfigPath = vi.hoisted(() => vi.fn());
const mockLoadSchema = vi.hoisted(() => vi.fn());
const mockLoadSchemaFromCwd = vi.hoisted(() => vi.fn());
const mockRunBatchMode = vi.hoisted(() => vi.fn());
const mockStartRepl = vi.hoisted(() => vi.fn());

vi.mock('../config.js', () => ({
	config: {
		load: mockConfigLoad,
		setConfigPath: mockConfigSetConfigPath,
	},
}));

vi.mock('../utils/schema-loader.js', () => ({
	loadSchema: (...args: unknown[]) => mockLoadSchema(...args),
	loadSchemaFromCwd: (...args: unknown[]) => mockLoadSchemaFromCwd(...args),
}));

vi.mock('../repl/batch.js', () => ({
	runBatchMode: (...args: unknown[]) => mockRunBatchMode(...args),
}));

vi.mock('../repl/index.js', () => ({
	startRepl: (...args: unknown[]) => mockStartRepl(...args),
}));

import { replCommand } from './repl.js';

function makeLoadedSchema(dbCasing?: 'snake_case' | 'camelCase' | 'preserve') {
	return {
		model: { tables: new Map() },
		definition: {},
		tableNames: ['userProfiles'],
		...(dbCasing !== undefined ? { dbCasing } : {}),
	};
}

describe('repl command casing wiring', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockLoadSchema.mockResolvedValue(makeLoadedSchema('snake_case'));
		mockLoadSchemaFromCwd.mockResolvedValue({
			schema: makeLoadedSchema('snake_case'),
			path: 'dbsp.schema.ts',
		});
		mockRunBatchMode.mockResolvedValue(undefined);
		mockStartRepl.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('passes schema dbCasing to batch mode when --casing is omitted', async () => {
		await replCommand.parseAsync(
			['--schema', 'dbsp.schema.ts', '--eval', 'from userProfiles'],
			{ from: 'user' },
		);

		expect(mockRunBatchMode).toHaveBeenCalledWith(
			expect.objectContaining({ dbCasing: 'snake_case' }),
		);
	});

	it('lets explicit --casing win over the schema declaration in batch mode', async () => {
		await replCommand.parseAsync(
			[
				'--schema',
				'dbsp.schema.ts',
				'--eval',
				'from userProfiles',
				'--casing',
				'none',
			],
			{ from: 'user' },
		);

		expect(mockRunBatchMode).toHaveBeenCalledWith(
			expect.objectContaining({ dbCasing: 'preserve' }),
		);
	});

	it('keeps the old batch options shape when the schema has no dbCasing export', async () => {
		mockLoadSchema.mockResolvedValue(makeLoadedSchema());

		await replCommand.parseAsync(
			['--schema', 'dbsp.schema.ts', '--eval', 'from userProfiles'],
			{ from: 'user' },
		);

		expect(mockRunBatchMode).toHaveBeenCalledWith(
			expect.not.objectContaining({ dbCasing: expect.anything() }),
		);
	});

	it('passes schema dbCasing to the interactive REPL path', async () => {
		await replCommand.parseAsync(['--schema', 'dbsp.schema.ts'], {
			from: 'user',
		});

		expect(mockStartRepl).toHaveBeenCalledWith(
			expect.objectContaining({ dbCasing: 'snake_case' }),
		);
	});
});
