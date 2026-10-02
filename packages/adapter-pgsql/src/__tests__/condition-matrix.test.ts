/** Rewriting records the current checkout's output; the resulting diff is what a reviewer judges. A normal run is read-only. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
	entries: ({
		position: string;
		kind: string;
		shape: string;
	} & MatrixOutcome)[];
};
// Explicit opt-in only.
if (process.env.CONDITION_MATRIX_REWRITE === '1') {
	mkdirSync(baselineDirectory, { recursive: true });
	positions.forEach((position, index) => {
		writeFileSync(
			baselinePaths[index]!,
			`${JSON.stringify({ entries: conditionMatrix.filter((entry) => entry.position === position).map(({ position, kind, shape, run }) => ({ position, kind, shape, ...run() })) }, null, 2)}\n`,
		);
	});
	execFileSync(
		fileURLToPath(
			new URL('../../../../node_modules/.bin/biome', import.meta.url),
		),
		['format', '--write', ...baselinePaths.map((path) => fileURLToPath(path))],
	);
}
const baselines = baselinePaths.map(
	(path) => JSON.parse(readFileSync(path, 'utf8')) as Baseline,
);
const baselineEntries = baselines.flatMap(({ entries }) => entries);
describe('condition compilation differential matrix (#891)', () => {
	let before: string[];
	beforeAll(() => {
		before = baselinePaths.map((path) => readFileSync(path, 'utf8'));
	});
	afterAll(() => {
		expect(baselinePaths.map((path) => readFileSync(path, 'utf8'))).toEqual(
			before,
		);
	});
	it('pins the complete ordered inventory', () => {
		expect(readdirSync(baselineDirectory).sort()).toEqual(
			positions.map((position) => `${position}.json`).sort(),
		);
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
});
