import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { conditionMatrix } from './condition-matrix.cases.js';

describe('typed join ON authority', () => {
	it('all 317 manual ON outcomes agree under poisoned relation authority', () => {
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
