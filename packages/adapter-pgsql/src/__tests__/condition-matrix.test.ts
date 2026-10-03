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
// Fixed-size ordered shards keep every artifact below 200 KB, even for long SQL.
const shards = positions.flatMap((position) => {
	const entries = conditionMatrix.filter(
		(entry) => entry.position === position,
	);
	return Array.from(
		{ length: Math.ceil(entries.length / 100) },
		(_, index) => ({
			path: new URL(
				`${position}${index === 0 ? '' : `.${String(index + 1).padStart(3, '0')}`}.json`,
				baselineDirectory,
			),
			entries: entries.slice(index * 100, (index + 1) * 100),
		}),
	);
});
const baselinePaths = shards.map(({ path }) => path);
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
	shards.forEach(({ path, entries }) => {
		writeFileSync(
			path,
			`${JSON.stringify({ entries: entries.map(({ position, kind, shape, run }) => ({ position, kind, shape, ...run() })) }, null, 2)}\n`,
		);
	});

	execFileSync(
		fileURLToPath(
			new URL('../../../../node_modules/.bin/biome', import.meta.url),
		),
		['format', '--write', ...baselinePaths.map((path) => fileURLToPath(path))],
	);
}
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
			baselinePaths
				.map((path) => fileURLToPath(path).split('/').at(-1)!)
				.sort(),
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
