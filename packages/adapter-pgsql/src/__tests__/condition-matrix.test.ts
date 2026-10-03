/** Rewriting records the current checkout's output; the resulting diff is what a reviewer judges. A normal run is read-only. */
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	conditionMatrix,
	type MatrixOutcome,
	prepareConditionMatrix,
} from './condition-matrix.cases.js';

const baselineDirectory = new URL('./condition-matrix/', import.meta.url);
const shards = prepareConditionMatrix(baselineDirectory, conditionMatrix);
const baselinePaths = shards.map(({ path }) => path);
type Baseline = {
	entries: ({
		position: string;
		kind: string;
		shape: string;
	} & MatrixOutcome)[];
};
const baselines = baselinePaths.map((path) => {
	const bytes = readFileSync(path, 'utf8');
	if (Buffer.byteLength(bytes) >= 200_000)
		throw new Error(`Matrix shard exceeds 200 KB: ${path}`);
	return JSON.parse(bytes) as Baseline;
});
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
			baselinePaths.map((path) => basename(fileURLToPath(path))).sort(),
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
