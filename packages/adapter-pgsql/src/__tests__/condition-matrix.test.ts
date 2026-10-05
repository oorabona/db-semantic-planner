/** Rewriting records the current checkout's output; the resulting diff is what a reviewer judges. A normal run is read-only. */
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, exists, not, or } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	conditionMatrix,
	isRelationLookupFreeJoinOn,
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
	it('poisons only ON conditions without relation predicates or dotted fields', () => {
		const plain = eq('score', 7);
		expect(isRelationLookupFreeJoinOn(and(plain, not(or(plain))))).toBe(true);
		for (const condition of [
			exists('posts'),
			{ kind: 'notExists' as const, relation: 'posts' },
			...(['some', 'every', 'none'] as const).map((mode) => ({
				kind: 'relationFilter' as const,
				relation: 'posts',
				where: plain,
				mode,
			})),
			eq('posts.score', 7),
		]) {
			for (const wrapped of [
				condition,
				and(plain, condition),
				or(plain, condition),
				not(condition),
			])
				expect(isRelationLookupFreeJoinOn(wrapped)).toBe(false);
		}
	});
	it('emits empty groups once per position and observable key-authority profile', () => {
		for (const position of new Set(
			conditionMatrix.map((entry) => entry.position),
		)) {
			const entries = conditionMatrix.filter(
				(entry) => entry.position === position,
			);
			if (position.endsWith('-to-many-refusal')) {
				expect(entries).toHaveLength(2);
				continue;
			}
			const kinds = ['eq'];
			if (
				position === 'in-subquery-body' ||
				position.startsWith('relation-') ||
				position.startsWith('include-')
			)
				kinds.push('exists-custom-authorities');
			expect(entries).toHaveLength(kinds.length === 2 ? 319 : 317);
			for (const shape of ['empty-or', 'empty-and']) {
				expect(
					entries
						.filter((entry) => entry.shape === shape)
						.map((entry) => entry.kind),
				).toEqual(kinds);
			}
		}
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
