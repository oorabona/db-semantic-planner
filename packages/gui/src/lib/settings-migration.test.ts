import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────

const mockReadDir = vi.fn();
const mockJoin = vi.fn();
const mockWriteSettings = vi.fn();

vi.mock('@tauri-apps/plugin-fs', () => ({
	readDir: (...args: unknown[]) => mockReadDir(...args),
}));

vi.mock('@tauri-apps/api/path', () => ({
	join: (...args: unknown[]) => mockJoin(...args),
}));

vi.mock('./settings', () => ({
	writeSettings: (...args: unknown[]) => mockWriteSettings(...args),
}));

import type { DbspSettings } from './settings';
import { migrateSettings, needsMigration } from './settings-migration';

// ── Helpers ──────────────────────────────────────────────────────

function makeEntry(name: string, isDirectory = false) {
	return { name, isDirectory };
}

beforeEach(() => {
	vi.clearAllMocks();
	mockJoin.mockImplementation((...parts: string[]) =>
		Promise.resolve(parts.join('/')),
	);
	mockWriteSettings.mockResolvedValue(undefined);
});

// ── needsMigration ───────────────────────────────────────────────

describe('needsMigration', () => {
	it('returns false when settings have no project', () => {
		const settings: DbspSettings = { version: 1 };
		expect(needsMigration(settings)).toBe(false);
	});

	it('returns false when project already has files[]', () => {
		const settings: DbspSettings = {
			version: 1,
			project: { files: ['src/main.dbsp'] },
		};
		expect(needsMigration(settings)).toBe(false);
	});

	it('returns false when files is empty array', () => {
		const settings: DbspSettings = {
			version: 1,
			project: { files: [] },
		};
		expect(needsMigration(settings)).toBe(false);
	});

	it('returns true when project has no files field', () => {
		const settings: DbspSettings = {
			version: 1,
			project: { name: 'test' },
		};
		expect(needsMigration(settings)).toBe(true);
	});

	it('returns true when project has legacy include/exclude (cast)', () => {
		// Simulate old settings format loaded as raw JSON
		const settings = {
			version: 1,
			project: {
				name: 'test',
				include: ['**/*.dbsp'],
				exclude: ['node_modules'],
			},
		} as unknown as DbspSettings;
		expect(needsMigration(settings)).toBe(true);
	});
});

// ── migrateSettings ──────────────────────────────────────────────

describe('migrateSettings', () => {
	it('scans filesystem using legacy defaults and populates files[]', async () => {
		mockReadDir.mockResolvedValue([
			makeEntry('main.dbsp'),
			makeEntry('test.assert.dbsp'),
			makeEntry('readme.md'),
		]);

		const settings: DbspSettings = {
			version: 1,
			project: { name: 'my-project' },
		};

		const result = await migrateSettings(settings, '/projects/demo');

		expect(result.project?.files).toEqual(['main.dbsp', 'test.assert.dbsp']);
		expect(mockWriteSettings).toHaveBeenCalledWith('/projects/demo', result);
	});

	it('scans nested directories', async () => {
		// Root dir
		mockReadDir.mockResolvedValueOnce([
			makeEntry('src', true),
			makeEntry('root.dbsp'),
		]);
		// src/ dir
		mockReadDir.mockResolvedValueOnce([
			makeEntry('query.dbsp'),
			makeEntry('query.assert.dbsp'),
		]);

		const settings: DbspSettings = {
			version: 1,
			project: { name: 'nested' },
		};

		const result = await migrateSettings(settings, '/projects/nested');

		expect(result.project?.files).toEqual([
			'root.dbsp',
			'src/query.assert.dbsp',
			'src/query.dbsp',
		]);
	});

	it('skips excluded directories', async () => {
		mockReadDir.mockResolvedValueOnce([
			makeEntry('node_modules', true),
			makeEntry('src', true),
			makeEntry('main.dbsp'),
		]);
		// src/ dir
		mockReadDir.mockResolvedValueOnce([makeEntry('app.dbsp')]);

		const settings: DbspSettings = {
			version: 1,
			project: { name: 'excluded' },
		};

		const result = await migrateSettings(settings, '/projects/excluded');

		expect(result.project?.files).toEqual(['main.dbsp', 'src/app.dbsp']);
		// node_modules should not be scanned
		expect(mockReadDir).toHaveBeenCalledTimes(2);
	});

	it('uses custom include/exclude from legacy settings', async () => {
		mockReadDir.mockResolvedValue([
			makeEntry('query.sql'),
			makeEntry('main.dbsp'),
		]);

		// Old format with custom patterns (cast past new types)
		const settings = {
			version: 1,
			project: {
				name: 'custom',
				include: ['**/*.sql'],
				exclude: [],
			},
		} as unknown as DbspSettings;

		const result = await migrateSettings(settings, '/projects/custom');

		expect(result.project?.files).toEqual(['query.sql']);
	});

	it('handles empty directory gracefully', async () => {
		mockReadDir.mockResolvedValue([]);

		const settings: DbspSettings = {
			version: 1,
			project: { name: 'empty' },
		};

		const result = await migrateSettings(settings, '/projects/empty');

		expect(result.project?.files).toEqual([]);
	});

	it('handles readDir permission error gracefully', async () => {
		mockReadDir.mockRejectedValue(new Error('Permission denied'));

		const settings: DbspSettings = {
			version: 1,
			project: { name: 'no-access' },
		};

		const result = await migrateSettings(settings, '/projects/no-access');

		expect(result.project?.files).toEqual([]);
	});

	it('strips include/exclude from migrated settings', async () => {
		mockReadDir.mockResolvedValue([makeEntry('main.dbsp')]);

		const settings = {
			version: 1,
			project: {
				name: 'strip-test',
				include: ['**/*.dbsp'],
				exclude: ['dist'],
			},
		} as unknown as DbspSettings;

		const result = await migrateSettings(settings, '/projects/strip');

		// Should NOT have include/exclude in the result
		const proj = result.project as Record<string, unknown>;
		expect(proj.include).toBeUndefined();
		expect(proj.exclude).toBeUndefined();
		expect(proj.name).toBe('strip-test');
		expect(result.project?.files).toEqual(['main.dbsp']);
	});

	it('preserves other settings fields during migration', async () => {
		mockReadDir.mockResolvedValue([makeEntry('main.dbsp')]);

		const settings: DbspSettings = {
			version: 1,
			project: { name: 'preserve', schemaPath: 'auto' },
			editor: { tabSize: 4 },
			connections: [{ name: 'dev', profile: 'store://dev' }],
		};

		const result = await migrateSettings(settings, '/projects/preserve');

		expect(result.version).toBe(1);
		expect(result.project?.name).toBe('preserve');
		expect(result.project?.schemaPath).toBe('auto');
		expect(result.editor?.tabSize).toBe(4);
		expect(result.connections).toHaveLength(1);
	});
});
