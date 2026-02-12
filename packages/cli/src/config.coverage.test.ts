// @ts-nocheck — coverage test
/**
 * Coverage tests for config.ts — targets uncovered branches.
 *
 * Branches covered:
 * - branch 0[0]: load() returns cached config when already loaded
 * - branch 2[1]: parsed.table ?? {} fallback when table key is absent
 */

import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs');
vi.mock('node:os', () => ({
	homedir: vi.fn(() => '/mock/cov-home'),
}));

describe('config coverage', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.mocked(fs.existsSync).mockReturnValue(false);
		vi.mocked(fs.readFileSync).mockReturnValue('{}');
		vi.mocked(fs.writeFileSync).mockImplementation(() => {});
		vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
	});

	it('should return cached config on second load() call', async () => {
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(
			JSON.stringify({ table: { borderStyle: 'none' } }),
		);

		const { config } = await import('./config.js');
		const first = config.load();
		const second = config.load();

		// Same reference — second call hits the cache
		expect(first).toBe(second);
		// readFileSync called only once (not twice)
		expect(fs.readFileSync).toHaveBeenCalledTimes(1);
	});

	it('should use fallback when parsed config has no table key', async () => {
		vi.mocked(fs.existsSync).mockReturnValue(true);
		// Valid JSON but no "table" property
		vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ other: 1 }));

		const { config } = await import('./config.js');
		const result = config.load();

		// Should fall back to default table config via ?? {}
		expect(result.table.borderStyle).toBe('all');
		expect(result.table.overflow).toBe('wrap');
		expect(result.table.headerFormatter).toBe('capitalCase');
		expect(result.table.padding).toBe(1);
	});
});
