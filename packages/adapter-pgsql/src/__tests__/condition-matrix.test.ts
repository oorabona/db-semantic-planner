import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	conditionMatrix,
	type MatrixOutcome,
} from './condition-matrix.cases.js';

const baselinePath = new URL(
	'./condition-matrix.baseline.json',
	import.meta.url,
);
// Explicit opt-in only. Captured on 94a17bda before changing compiler code.
if (process.env.CONDITION_MATRIX_REWRITE === '1') {
	writeFileSync(
		baselinePath,
		`${JSON.stringify({ sourceCommit: '94a17bda7ecef508cbcd4653d15940c9fd67544f', entries: conditionMatrix.map(({ position, kind, shape, run }) => ({ position, kind, shape, ...run() })) }, null, 2)}\n`,
	);
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
	sourceCommit: string;
	entries: ({
		position: string;
		kind: string;
		shape: string;
	} & MatrixOutcome)[];
};
describe('condition compilation differential matrix (#891)', () => {
	it('pins provenance and the complete ordered inventory', () => {
		expect(baseline.sourceCommit).toBe(
			'94a17bda7ecef508cbcd4653d15940c9fd67544f',
		);
		expect(
			baseline.entries.map(({ position, kind, shape }) => ({
				position,
				kind,
				shape,
			})),
		).toEqual(
			conditionMatrix.map(({ position, kind, shape }) => ({
				position,
				kind,
				shape,
			})),
		);
	});
	conditionMatrix.forEach(({ position, kind, shape, run }, index) => {
		it(`${position} / ${kind} / ${shape}`, () => {
			const expected = baseline.entries[index]!;
			const actual = run();
			expect(actual.sql).toBe(expected.sql);
			expect(actual.params).toEqual(expected.params);
			expect(actual.error).toBe(expected.error);
		});
	});
	it('a normal run never rewrites the baseline', () => {
		const before = readFileSync(baselinePath, 'utf8');
		for (const entry of conditionMatrix) entry.run();
		expect(readFileSync(baselinePath, 'utf8')).toBe(before);
	});
});
