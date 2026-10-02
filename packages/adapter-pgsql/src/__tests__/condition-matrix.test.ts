import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	conditionMatrix,
	type MatrixOutcome,
} from './condition-matrix.cases.js';

const baselineDirectory = new URL('./condition-matrix/', import.meta.url);
const positions = [...new Set(conditionMatrix.map(({ position }) => position))];
const baselinePaths = positions.map(
	(position) => new URL(`${position}.json`, baselineDirectory),
);
type Baseline = {
	sourceCommit: string;
	entries: ({
		position: string;
		kind: string;
		shape: string;
	} & MatrixOutcome)[];
};
// Explicit opt-in only. Captured on 94a17bda before changing compiler code.
if (process.env.CONDITION_MATRIX_REWRITE === '1') {
	mkdirSync(baselineDirectory, { recursive: true });
	positions.forEach((position, index) => {
		writeFileSync(
			baselinePaths[index]!,
			`${JSON.stringify({ sourceCommit: '94a17bda7ecef508cbcd4653d15940c9fd67544f', entries: conditionMatrix.filter((entry) => entry.position === position).map(({ position, kind, shape, run }) => ({ position, kind, shape, ...run() })) }, null, 2)}\n`,
		);
	});
}
const baselines = baselinePaths.map(
	(path) => JSON.parse(readFileSync(path, 'utf8')) as Baseline,
);
const baselineEntries = baselines.flatMap(({ entries }) => entries);
describe('condition compilation differential matrix (#891)', () => {
	it('pins provenance and the complete ordered inventory', () => {
		expect(readdirSync(baselineDirectory).sort()).toEqual(
			positions.map((position) => `${position}.json`).sort(),
		);
		for (const baseline of baselines) {
			expect(baseline.sourceCommit).toBe(
				'94a17bda7ecef508cbcd4653d15940c9fd67544f',
			);
		}
		expect(
			baselineEntries.map(({ position, kind, shape }) => ({
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
			const expected = baselineEntries[index]!;
			const actual = run();
			expect(actual.sql).toBe(expected.sql);
			expect(actual.params).toEqual(expected.params);
			expect(actual.error).toBe(expected.error);
		});
	});
	it('a normal run never rewrites the baseline', () => {
		const before = baselinePaths.map((path) => readFileSync(path, 'utf8'));
		for (const entry of conditionMatrix) entry.run();
		expect(baselinePaths.map((path) => readFileSync(path, 'utf8'))).toEqual(
			before,
		);
	});
});
