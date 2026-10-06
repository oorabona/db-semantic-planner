import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { conditionMatrix } from './condition-matrix.cases.js';

vi.mock('../compile-where.js', async (original) => {
	const actual = await original<typeof import('../compile-where.js')>();
	return {
		...actual,
		compileWhereIntent: () => {
			throw new Error('legacy ON route tripwire');
		},
	};
});

describe('typed join ON legacy-route tripwire', () => {
	it('all 317 manual ON outcomes agree under poisoned relation authority and a legacy tripwire', () => {
		const directory = new URL('./condition-matrix/', import.meta.url);
		const expected = readdirSync(directory)
			.filter((name) => name.startsWith('manual-join-on.'))
			.sort()
			.flatMap(
				(name) =>
					JSON.parse(readFileSync(new URL(name, directory), 'utf8')).entries,
			);
		const entries = conditionMatrix.filter(
			(entry) => entry.position === 'manual-join-on',
		);
		expect(entries).toHaveLength(317);
		entries.forEach((entry) => {
			const outcome = expected.find(
				(b: { kind: string; shape: string }) =>
					b.kind === entry.kind && b.shape === entry.shape,
			);
			expect(entry.run(), `${entry.kind}/${entry.shape}`).toEqual({
				sql: outcome.sql,
				params: outcome.params,
				error: outcome.error,
			});
		});
	}, 30_000);
});
