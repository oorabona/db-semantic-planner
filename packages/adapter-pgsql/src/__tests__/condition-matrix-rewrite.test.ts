import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import {
	conditionMatrix,
	prepareConditionMatrix,
} from './condition-matrix.cases.js';

it('rewrites retired and shrinking parts inside the directory and preserves non-JSON files', () => {
	const directory = mkdtempSync(join(tmpdir(), 'condition-matrix-'));
	const url = pathToFileURL(directory);
	try {
		const entry = conditionMatrix[0]!;
		const matrix = Array.from({ length: 201 }, () => entry);
		const unmanaged = ['notes.txt', `${entry.position}.002.json.bak`];
		for (const name of unmanaged) writeFileSync(join(directory, name), 'keep');
		const before = unmanaged.map(
			(name) => statSync(join(directory, name)).mtimeMs,
		);
		prepareConditionMatrix(url, matrix, true);
		expect(readdirSync(url).sort()).toEqual(
			[
				...unmanaged,
				`${entry.position}.json`,
				`${entry.position}.002.json`,
				`${entry.position}.003.json`,
			].sort(),
		);
		// Normal mode must preserve even a stale inventory, including modification times.
		const snapshot = readdirSync(url)
			.sort()
			.map((name) => ({
				name,
				bytes: readFileSync(join(directory, name), 'utf8'),
				mtime: statSync(join(directory, name)).mtimeMs,
			}));
		prepareConditionMatrix(url, matrix.slice(0, 101), false);
		expect(
			readdirSync(url)
				.sort()
				.map((name) => ({
					name,
					bytes: readFileSync(join(directory, name), 'utf8'),
					mtime: statSync(join(directory, name)).mtimeMs,
				})),
		).toEqual(snapshot);
		for (const count of [101, 1, 0]) {
			for (const name of [
				'retired-position.json',
				'select-where.1000.json',
				`${entry.position}.01.json`,
			]) {
				writeFileSync(join(directory, name), 'stale');
			}
			prepareConditionMatrix(url, matrix.slice(0, count), true);
			const expected =
				count === 101
					? [`${entry.position}.json`, `${entry.position}.002.json`]
					: count === 1
						? [`${entry.position}.json`]
						: [];
			expect(readdirSync(url).sort()).toEqual(
				[...unmanaged, ...expected].sort(),
			);
		}
		expect(
			unmanaged.map((name) => readFileSync(join(directory, name), 'utf8')),
		).toEqual(unmanaged.map(() => 'keep'));
		expect(
			unmanaged.map((name) => statSync(join(directory, name)).mtimeMs),
		).toEqual(before);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
