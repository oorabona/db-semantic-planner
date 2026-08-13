import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	formatReinitializeSplit,
	writeAdoptionFileAtomically,
} from './preflight.js';

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
		expect((await stat(out)).mode & 0o777).toBe(0o600);
	});

	it('OBL-CLI3 fsyncs file then parent around the atomic replacement', async () => {
		const calls: string[] = [];
		const fileSystem = {
			mkdtemp: async () => '/tmp/adoption-temp',
			open: async (path: string, _flags: string, mode?: number) => ({
				writeFile: async () => {
					calls.push(`write:${path}:${mode ?? ''}`);
				},
				sync: async () => {
					calls.push(`sync:${path}`);
				},
				close: async () => {
					calls.push(`close:${path}`);
				},
			}),
			rename: async (from: string, to: string) => {
				calls.push(`rename:${from}:${to}`);
			},
			rm: async (path: string) => {
				calls.push(`rm:${path}`);
			},
		};
		await writeAdoptionFileAtomically(
			'/tmp/adoption.json',
			{ scopes: [], adoptionCandidates: [] },
			fileSystem,
		);
		expect(calls).toEqual([
			'write:/tmp/adoption-temp/adoption.json:384',
			'sync:/tmp/adoption-temp/adoption.json',
			'close:/tmp/adoption-temp/adoption.json',
			'rename:/tmp/adoption-temp/adoption.json:/tmp/adoption.json',
			'sync:/tmp',
			'close:/tmp',
			'rm:/tmp/adoption-temp',
		]);
	});

	it('OBL-REC7 reports changed, failed, and not-attempted scopes together', () => {
		expect(
			formatReinitializeSplit([
				{
					ledger: { scope: 'schema', schema: 'changed' },
					outcome: 'current',
					marker: { kind: 'absent' },
				},
				{
					ledger: { scope: 'schema', schema: 'failed' },
					outcome: 'failed',
					marker: { kind: 'absent' },
					reason: { step: 'create', message: 'injected' },
				},
				{
					ledger: { scope: 'schema', schema: 'later' },
					outcome: 'not-attempted',
					marker: { kind: 'absent' },
				},
			]),
		).toBe(
			'reinitialize-split: changed=changed; failed=failed; not-attempted=later',
		);
	});
});
