import type { SchemaDiff } from '@dbsp/adapter-pgsql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCompareSchemata = vi.hoisted(() => vi.fn());
const mockIntrospect = vi.hoisted(() => vi.fn());
const mockCreateDbConnection = vi.hoisted(() => vi.fn());
const mockLoadSchema = vi.hoisted(() => vi.fn());

vi.mock('@dbsp/adapter-pgsql', () => ({
	compareSchemata: (...args: unknown[]) => mockCompareSchemata(...args),
	introspect: (...args: unknown[]) => mockIntrospect(...args),
}));

vi.mock('../utils/db-utils.js', () => ({
	createDbConnection: (...args: unknown[]) => mockCreateDbConnection(...args),
	redactDbUrl: (url: string) => url,
}));

vi.mock('../utils/schema-loader.js', () => ({
	loadSchema: (...args: unknown[]) => mockLoadSchema(...args),
}));

import { verifyCommand } from './verify.js';

function makeDiff(): SchemaDiff {
	return {
		changes: [],
		hasDestructive: false,
		summary: {
			tables: { added: 0, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: { added: 0, dropped: 0, altered: 0 },
		},
	};
}

function makeLoadedSchema(dbCasing?: 'snake_case' | 'camelCase' | 'preserve') {
	return {
		model: { tables: new Map([['userProfiles', {}]]) },
		definition: {},
		tableNames: ['userProfiles'],
		...(dbCasing !== undefined ? { dbCasing } : {}),
	};
}

describe('verify command casing wiring', () => {
	let pool: { end: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		vi.clearAllMocks();
		pool = { end: vi.fn().mockResolvedValue(undefined) };
		mockCreateDbConnection.mockResolvedValue({ pool });
		mockLoadSchema.mockResolvedValue(makeLoadedSchema('snake_case'));
		mockIntrospect.mockResolvedValue({
			tables: new Map([['user_profiles', {}]]),
		});
		mockCompareSchemata.mockReturnValue(makeDiff());
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		process.exitCode = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	it('passes schema dbCasing to compareSchemata', async () => {
		const loaded = makeLoadedSchema('snake_case');
		mockLoadSchema.mockResolvedValue(loaded);

		await verifyCommand.parseAsync(
			['--schema', 'dbsp.schema.ts', '--db', 'postgres://localhost/db'],
			{ from: 'user' },
		);

		expect(mockCompareSchemata).toHaveBeenCalledWith(
			loaded.model,
			expect.any(Object),
			{ dbCasing: 'snake_case' },
		);
		expect(pool.end).toHaveBeenCalledOnce();
	});

	it('keeps the old compareSchemata call shape when schema has no dbCasing export', async () => {
		const loaded = makeLoadedSchema();
		mockLoadSchema.mockResolvedValue(loaded);

		await verifyCommand.parseAsync(
			['--schema', 'dbsp.schema.ts', '--db', 'postgres://localhost/db'],
			{ from: 'user' },
		);

		expect(mockCompareSchemata).toHaveBeenCalledWith(
			loaded.model,
			expect.any(Object),
		);
		expect(mockCompareSchemata.mock.calls[0]).toHaveLength(2);
		expect(pool.end).toHaveBeenCalledOnce();
	});
});
