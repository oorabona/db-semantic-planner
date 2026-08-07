import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAdoptionFileAtomically } from './preflight.js';

const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

describe('preflight adoption output', () => {
	it('publishes only the complete adoption document at the requested path', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'dbsp-preflight-test-'));
		directories.push(directory);
		const out = join(directory, 'adoption.json');
		await writeFile(out, 'previous', 'utf8');
		await writeAdoptionFileAtomically(out, {
			scopes: [],
			adoptionCandidates: [],
		});
		expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({
			version: 1,
			adoptions: [],
		});
	});
});
