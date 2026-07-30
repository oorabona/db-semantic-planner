import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelIR, TableIR } from '@dbsp/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	createDbConnection: vi.fn(),
	introspect: vi.fn(),
	poolEnd: vi.fn(),
}));

vi.mock('../utils/db-utils.js', () => ({
	createDbConnection: (...args: unknown[]) => mocks.createDbConnection(...args),
	redactDbUrl: (url: string) => url.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@'),
}));

vi.mock('@dbsp/adapter-pgsql', async () => {
	const actual = await vi.importActual<typeof import('@dbsp/adapter-pgsql')>(
		'@dbsp/adapter-pgsql',
	);
	return {
		...actual,
		introspect: (...args: unknown[]) => mocks.introspect(...args),
	};
});

import { introspectCommand } from './introspect.js';

const expressionIndexWarning =
	'Expression index "idx_users_lower_email" on table "users" cannot be represented in the schema and is not managed by dbsp. dbsp will neither drop nor recreate it; maintain it by hand.';

function makeIntrospectedModel(): ModelIR & {
	readonly warnings: readonly string[];
	readonly introspectedAt: Date;
} {
	const table: TableIR = {
		name: 'users',
		columns: [{ name: 'email', type: 'string', nullable: false }],
		foreignKeys: [],
		indexes: [
			{
				name: 'idx_users_lower_email',
				columns: [],
				expressions: ['lower(email)'],
			},
		],
	};
	const tables = new Map([[table.name, table]]);
	return {
		tables,
		relations: new Map(),
		warnings: [expressionIndexWarning],
		introspectedAt: new Date('2026-01-31T10:00:00Z'),
		getTable: (name: string) => tables.get(name),
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

describe('introspect command warnings', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('prints merged generator warnings once through the CLI', async () => {
		const tmpDir = mkdtempSync(join(process.cwd(), '.tmp-introspect-command-'));
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.poolEnd.mockResolvedValue(undefined);
		mocks.createDbConnection.mockResolvedValue({
			pool: { end: mocks.poolEnd },
		});
		mocks.introspect.mockResolvedValue(makeIntrospectedModel());

		try {
			await introspectCommand.parseAsync(
				[
					'node',
					'introspect',
					'--db',
					'postgres://user:pass@localhost/db',
					'--out',
					join(tmpDir, 'dbsp.schema.ts'),
				],
				{ from: 'node' },
			);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}

		const output = [...log.mock.calls, ...error.mock.calls]
			.map((call) => call.join(' '))
			.join('\n');
		const occurrences = output.split(expressionIndexWarning).length - 1;

		expect(occurrences).toBe(1);
		expect(error).not.toHaveBeenCalled();
		expect(mocks.poolEnd).toHaveBeenCalledOnce();
	});
});
