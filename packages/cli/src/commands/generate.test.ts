/**
 * `dbsp generate` — the command's options must reach the real DDL generator,
 * and the casing the schema declares must be honoured.
 *
 * The schema loader is mocked so no user module executes. The PostgreSQL
 * compile-only adapter is real, so these tests assert on generated SQL rather
 * than on a mocked adapter's own bookkeeping.
 */

import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';
import { schema } from '@dbsp/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	generateCommand,
	isDialectSupported,
	mapCasingToDbCasing,
} from './generate.js';

const loadSchema = vi.hoisted(() => vi.fn());
const loadSchemaFromCwd = vi.hoisted(() => vi.fn());
vi.mock('../utils/schema-loader.js', () => ({
	loadSchema,
	loadSchemaFromCwd,
}));

const ddlSchema = schema({
	userProfiles: {
		id: { type: 'integer', primaryKey: true },
		displayName: 'text',
	},
});

const nullsNotDistinctDdlSchema = schema(
	{
		users: {
			id: { type: 'integer', primaryKey: true },
			email: 'text',
		},
	},
	{
		users: {
			indexes: [
				{
					columns: ['email'],
					unique: true,
					name: 'uk_users_email_nulls',
					nullsNotDistinct: true,
				},
			],
		},
	},
);

function makeLoadedSchema(dbCasing?: 'snake_case' | 'camelCase' | 'preserve') {
	return {
		...ddlSchema,
		...(dbCasing !== undefined ? { dbCasing } : {}),
	};
}

function capturedLog(): string {
	return vi
		.mocked(console.log)
		.mock.calls.map((call) => call.map(String).join(' '))
		.join('\n');
}

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

describe('generate helper exports', () => {
	it('maps CLI casing names to DbCasing values', () => {
		expect(mapCasingToDbCasing('snake')).toBe('snake_case');
		expect(mapCasingToDbCasing('camel')).toBe('camelCase');
		expect(mapCasingToDbCasing('none')).toBe('preserve');
		expect(mapCasingToDbCasing(undefined)).toBeUndefined();
	});

	it('recognizes the currently supported dialect', () => {
		expect(isDialectSupported('postgresql')).toBe(true);
		expect(isDialectSupported('mysql')).toBe(false);
		expect(isDialectSupported('sqlite')).toBe(false);
		expect(isDialectSupported('mssql')).toBe(false);
	});
});

describe('generate command casing wiring', () => {
	it('uses the schema dbCasing export as the generate ddl default', async () => {
		loadSchema.mockResolvedValue(makeLoadedSchema('camelCase'));
		loadSchemaFromCwd.mockResolvedValue({
			schema: makeLoadedSchema('camelCase'),
			path: 'dbsp.schema.ts',
		});

		await generateCommand.parseAsync(['ddl', '--schema', 'dbsp.schema.ts'], {
			from: 'user',
		});

		const output = capturedLog();
		expect(output).toContain('CREATE TABLE "userProfiles"');
		expect(output).toContain('"displayName"');
		expect(output).not.toContain('user_profiles');
		expect(output).not.toContain('display_name');
	});

	it('lets explicit --casing win over the schema declaration', async () => {
		loadSchema.mockResolvedValue(makeLoadedSchema('snake_case'));

		await generateCommand.parseAsync(
			['ddl', '--schema', 'dbsp.schema.ts', '--casing', 'none'],
			{ from: 'user' },
		);

		const output = capturedLog();
		expect(output).toContain('CREATE TABLE "userProfiles"');
		expect(output).toContain('"displayName"');
		expect(output).not.toContain('user_profiles');
	});

	it('maps explicit --casing camel to camelCase DDL identifiers', async () => {
		loadSchema.mockResolvedValue(makeLoadedSchema('snake_case'));

		await generateCommand.parseAsync(
			['ddl', '--schema', 'dbsp.schema.ts', '--casing', 'camel'],
			{ from: 'user' },
		);

		const output = capturedLog();
		expect(output).toContain('CREATE TABLE "userProfiles"');
		expect(output).toContain('"displayName"');
		expect(output).not.toContain('user_profiles');
	});

	it('keeps the historical snake_case default when the schema has no dbCasing export', async () => {
		loadSchema.mockResolvedValue(makeLoadedSchema());

		await generateCommand.parseAsync(['ddl', '--schema', 'dbsp.schema.ts'], {
			from: 'user',
		});

		const output = capturedLog();
		expect(output).toContain('CREATE TABLE "user_profiles"');
		expect(output).toContain('"display_name"');
		expect(output).not.toContain('CREATE TABLE "userProfiles"');
		expect(output).not.toContain('"displayName"');
	});
});

describe('generate: a refused target never runs the user schema', () => {
	it.each([
		'manifest',
		'kysely',
		'typo',
	])('rejects %s without loading the schema', async (target) => {
		loadSchema.mockClear();
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
	it('emits DROP statements when --drop is set, and not otherwise', async () => {
		loadSchema.mockResolvedValue(makeLoadedSchema());

		await generateCommand.parseAsync(
			['ddl', '--schema', 'dbsp.schema.ts', '--drop'],
			{ from: 'user' },
		);
		expect(capturedLog()).toContain('DROP TABLE IF EXISTS "user_profiles"');

		vi.mocked(console.log).mockClear();

		await generateCommand.parseAsync(['ddl', '--schema', 'dbsp.schema.ts'], {
			from: 'user',
		});
		expect(capturedLog()).not.toContain('DROP TABLE IF EXISTS');
	});

	it.each([
		'mysql',
		'sqlite',
		'mssql',
	])('warns that %s is unsupported and carries on with postgresql', async (dialect) => {
		loadSchema.mockResolvedValue(makeLoadedSchema());

		await generateCommand.parseAsync(
			['ddl', '--schema', 'dbsp.schema.ts', '--dialect', dialect],
			{ from: 'user' },
		);

		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("Only 'postgresql' dialect"),
		);
		expect(capturedLog()).toContain('CREATE TABLE "user_profiles"');
	});

	it('says nothing about the dialect when it is postgresql', async () => {
		loadSchema.mockResolvedValue(makeLoadedSchema());

		await generateCommand.parseAsync(
			['ddl', '--schema', 'dbsp.schema.ts', '--dialect', 'postgresql'],
			{ from: 'user' },
		);

		expect(console.error).not.toHaveBeenCalledWith(
			expect.stringContaining('dialect'),
		);
		expect(capturedLog()).toContain('CREATE TABLE "user_profiles"');
	});

	it('refuses NULLS NOT DISTINCT for a PostgreSQL 14 target at generation time', async () => {
		loadSchema.mockResolvedValue({
			...nullsNotDistinctDdlSchema,
			dbCasing: 'snake_case',
		});
		const exit = vi
			.spyOn(process, 'exit')
			.mockImplementation((() => undefined) as never);

		await generateCommand.parseAsync(
			['ddl', '--schema', 'dbsp.schema.ts', '--postgresql-version', '14'],
			{ from: 'user' },
		);

		expect(console.error).toHaveBeenCalledWith(
			'❌ index `uk_users_email_nulls`: NULLS NOT DISTINCT requires PostgreSQL >= 15 (target 14)',
		);
		expect(exit).toHaveBeenCalledWith(1);
	});

	it('emits NULLS NOT DISTINCT for a PostgreSQL 15 target', async () => {
		loadSchema.mockResolvedValue({
			...nullsNotDistinctDdlSchema,
			dbCasing: 'snake_case',
		});

		await generateCommand.parseAsync(
			['ddl', '--schema', 'dbsp.schema.ts', '--postgresql-version', '15'],
			{ from: 'user' },
		);

		expect(capturedLog()).toContain('NULLS NOT DISTINCT');
	});

	it('keeps output without --postgresql-version byte-identical to the current adapter default', async () => {
		loadSchema.mockResolvedValue({
			...nullsNotDistinctDdlSchema,
			dbCasing: 'snake_case',
		});
		const expected = createPgsqlCompileOnlyAdapter()
			.generateDDL(nullsNotDistinctDdlSchema.model)
			.join('\n\n');

		await generateCommand.parseAsync(['ddl', '--schema', 'dbsp.schema.ts'], {
			from: 'user',
		});

		expect(capturedLog()).toBe(expected);
	});

	it.each([
		'garbage',
		'140005',
		'14.100',
		'9',
	])('rejects PostgreSQL version spelling %s as a usage error before loading the schema', async (postgresqlVersion) => {
		const exit = vi
			.spyOn(process, 'exit')
			.mockImplementation((() => undefined) as never);

		await generateCommand.parseAsync(
			[
				'ddl',
				'--schema',
				'dbsp.schema.ts',
				'--postgresql-version',
				postgresqlVersion,
			],
			{ from: 'user' },
		);

		expect(loadSchema).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining(
				`Invalid --postgresql-version "${postgresqlVersion}": expected a PostgreSQL major version or dotted release version`,
			),
		);
		expect(exit).toHaveBeenCalledWith(1);
	});
});
