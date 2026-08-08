import { describe, expect, it } from 'vitest';
import {
	assertPgDatabaseWritable,
	classifyPgDatabaseWritability,
	isPgDatabaseReadOnlyError,
} from './database-writability.js';

function executor(row: Record<string, unknown>) {
	return { query: async () => ({ rows: [row] }) };
}

describe('PostgreSQL database writability classification', () => {
	it.each([
		[
			'standby',
			{
				in_recovery: true,
				default_transaction_read_only: 'off',
				transaction_read_only: 'on',
			},
		],
		[
			'default read-only session',
			{
				in_recovery: false,
				default_transaction_read_only: 'on',
				transaction_read_only: 'on',
			},
		],
	] as const)('%s has the single database-read-only outcome', async (_name, row) => {
		await expect(
			classifyPgDatabaseWritability(executor(row)),
		).resolves.toMatchObject({
			kind: 'database-read-only',
		});
		await expect(assertPgDatabaseWritable(executor(row))).rejects.toSatisfy(
			isPgDatabaseReadOnlyError,
		);
	});

	it('fails closed when PostgreSQL does not provide a readable writability fact', async () => {
		await expect(
			classifyPgDatabaseWritability(
				executor({
					in_recovery: false,
					default_transaction_read_only: 'unexpected',
					transaction_read_only: 'off',
				}),
			),
		).resolves.toMatchObject({ kind: 'unavailable' });
	});
});
