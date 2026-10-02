import { schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

describe('mutation logical metadata with physical identifiers', () => {
	const model = schema({
		eventLogs: {
			eventId: { type: 'uuid', primaryKey: true },
			displayName: 'text',
			eventRange: 'daterange',
		},
	}).model;
	const adapter = createPgsqlCompileOnlyAdapter({
		model,
		dbCasing: 'snake_case',
	});
	const eventId = '00000000-0000-0000-0000-000000000001';

	it('uses declared UUID types for every mutation configuration carrying columns', () => {
		const cases = [
			[
				'insert values',
				adapter.compileInsert({
					type: 'insert',
					table: 'eventLogs',
					values: [{ eventRange: '[2026-01-01,2026-02-01)' }],
				}),
			],
			[
				'insert unnest',
				adapter.compileInsert(
					{ type: 'insert', table: 'eventLogs', values: [{ eventId }] },
					{ batchThreshold: 0 },
				).sql,
			],
			[
				'scalar update',
				adapter.compileUpdate({
					type: 'update',
					table: 'eventLogs',
					set: { eventRange: '[2026-01-01,2026-02-01)' },
					allowAll: true,
				}),
			],
			[
				'unnest update',
				adapter.compileBatchUpdate({
					type: 'batchUpdate',
					table: 'eventLogs',
					matchColumns: ['eventId'],
					updates: [{ eventId, displayName: 'event' }],
				}),
			],
			[
				'batch scalar set',
				adapter.compileBatchUpdate({
					type: 'batchUpdate',
					table: 'eventLogs',
					matchColumns: ['eventId'],
					updates: [{ eventId }],
					scalarSet: { eventRange: '[2026-01-01,2026-02-01)' },
				}),
			],
			[
				'upsert unnest',
				adapter.compileUpsert(
					{
						type: 'upsert',
						table: 'eventLogs',
						values: [{ eventId }],
						onConflict: { columns: ['eventId'] },
						action: { type: 'doNothing' },
					},
					{ batchThreshold: 0 },
				).sql,
			],
		] as const;

		for (const [name, result] of cases) {
			const sql = typeof result === 'string' ? result : result.sql;
			const cast =
				name === 'insert values' || name === 'scalar update'
					? 'CAST($1 AS daterange)'
					: name === 'batch scalar set'
						? 'CAST($2 AS daterange)'
						: name === 'unnest update'
							? 'CAST($1 AS uuid[])'
							: 'CAST($1 AS uuid[])';
			expect(sql, name).toContain(cast);
		}
	});
});
