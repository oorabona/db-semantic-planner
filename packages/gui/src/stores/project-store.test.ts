import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadDir, mockJoin, mockReadSettings } = vi.hoisted(() => ({
	mockReadDir: vi.fn(),
	mockJoin: vi.fn(),
	mockReadSettings: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
	readDir: mockReadDir,
}));

vi.mock('@tauri-apps/api/path', () => ({
	join: mockJoin,
}));

vi.mock('@/lib/settings', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/settings')>();
	return {
		...actual,
		readSettings: mockReadSettings,
	};
});

import {
	discoverFiles,
	matchesGlob,
	shouldIncludeFile,
	useProjectStore,
} from './project-store';

// ── Reset store between tests ───────────────────────────────────

beforeEach(() => {
	vi.clearAllMocks();
	mockJoin.mockImplementation((...parts: string[]) =>
		Promise.resolve(parts.join('/')),
	);
	// Reset store state
	useProjectStore.setState({
		mode: 'standalone',
		folderPath: null,
		settings: null,
		files: [],
		loading: false,
		error: null,
	});
});

// ── matchesGlob ─────────────────────────────────────────────────

describe('matchesGlob', () => {
	it('matches **/*.dbsp', () => {
		expect(matchesGlob('src/users.dbsp', '**/*.dbsp')).toBe(true);
	});

	it('matches **/*.assert.dbsp', () => {
		expect(matchesGlob('src/users.assert.dbsp', '**/*.assert.dbsp')).toBe(true);
	});

	it('rejects non-matching extension', () => {
		expect(matchesGlob('src/readme.md', '**/*.dbsp')).toBe(false);
	});

	it('matches *.ext against filename', () => {
		expect(matchesGlob('users.dbsp', '*.dbsp')).toBe(true);
	});

	it('matches exact directory name (exclude)', () => {
		expect(matchesGlob('node_modules', 'node_modules')).toBe(true);
	});

	it('matches directory in path', () => {
		expect(matchesGlob('foo/node_modules/bar', 'node_modules')).toBe(true);
	});

	it('rejects non-matching exact', () => {
		expect(matchesGlob('src/utils.ts', 'node_modules')).toBe(false);
	});
});

// ── shouldIncludeFile ───────────────────────────────────────────

describe('shouldIncludeFile', () => {
	const include = ['**/*.dbsp', '**/*.assert.dbsp'];
	const exclude = ['node_modules', 'dist', '.git'];

	it('includes .dbsp files', () => {
		expect(shouldIncludeFile('src/users.dbsp', include, exclude)).toBe(true);
	});

	it('includes .assert.dbsp files', () => {
		expect(shouldIncludeFile('src/users.assert.dbsp', include, exclude)).toBe(
			true,
		);
	});

	it('excludes node_modules paths', () => {
		expect(shouldIncludeFile('node_modules/foo.dbsp', include, exclude)).toBe(
			false,
		);
	});

	it('excludes non-matching files', () => {
		expect(shouldIncludeFile('src/readme.md', include, exclude)).toBe(false);
	});
});

// ── discoverFiles ───────────────────────────────────────────────

describe('discoverFiles', () => {
	it('discovers .dbsp files in flat directory', async () => {
		// Arrange
		mockReadDir.mockResolvedValue([
			{ name: 'users.dbsp', isDirectory: false, isFile: true },
			{ name: 'orders.dbsp', isDirectory: false, isFile: true },
			{ name: 'readme.md', isDirectory: false, isFile: true },
		]);

		// Act
		const files = await discoverFiles('/project');

		// Assert
		expect(files).toHaveLength(2);
		expect(files[0]!.name).toBe('orders.dbsp');
		expect(files[1]!.name).toBe('users.dbsp');
	});

	it('discovers files in subdirectories', async () => {
		// Arrange
		mockReadDir
			.mockResolvedValueOnce([
				{ name: 'src', isDirectory: true, isFile: false },
				{ name: 'readme.md', isDirectory: false, isFile: true },
			])
			.mockResolvedValueOnce([
				{ name: 'users.dbsp', isDirectory: false, isFile: true },
				{
					name: 'users.assert.dbsp',
					isDirectory: false,
					isFile: true,
				},
			]);

		// Act
		const files = await discoverFiles('/project');

		// Assert
		expect(files).toHaveLength(1); // src directory
		expect(files[0]!.isDirectory).toBe(true);
		expect(files[0]!.children).toHaveLength(2);
	});

	it('skips excluded directories', async () => {
		// Arrange
		mockReadDir.mockResolvedValue([
			{ name: 'node_modules', isDirectory: true, isFile: false },
			{ name: 'users.dbsp', isDirectory: false, isFile: true },
		]);

		// Act
		const files = await discoverFiles('/project');

		// Assert
		expect(files).toHaveLength(1);
		expect(files[0]!.name).toBe('users.dbsp');
		expect(mockReadDir).toHaveBeenCalledTimes(1); // no recurse into node_modules
	});

	it('omits empty directories', async () => {
		// Arrange
		mockReadDir
			.mockResolvedValueOnce([
				{ name: 'empty', isDirectory: true, isFile: false },
			])
			.mockResolvedValueOnce([]); // empty directory

		// Act
		const files = await discoverFiles('/project');

		// Assert
		expect(files).toHaveLength(0);
	});

	it('sorts directories before files', async () => {
		// Arrange
		mockReadDir
			.mockResolvedValueOnce([
				{ name: 'b.dbsp', isDirectory: false, isFile: true },
				{ name: 'a-dir', isDirectory: true, isFile: false },
			])
			.mockResolvedValueOnce([
				{ name: 'z.dbsp', isDirectory: false, isFile: true },
			]);

		// Act
		const files = await discoverFiles('/project');

		// Assert
		expect(files[0]!.isDirectory).toBe(true);
		expect(files[0]!.name).toBe('a-dir');
		expect(files[1]!.name).toBe('b.dbsp');
	});
});

// ── useProjectStore ─────────────────────────────────────────────

describe('useProjectStore', () => {
	describe('openFolder', () => {
		it('enters project mode when settings exist', async () => {
			// Arrange
			mockReadSettings.mockResolvedValue({
				version: 1,
				connections: [],
			});
			mockReadDir.mockResolvedValue([
				{ name: 'users.dbsp', isDirectory: false, isFile: true },
			]);

			// Act
			await useProjectStore.getState().openFolder('/my/project');

			// Assert
			const state = useProjectStore.getState();
			expect(state.mode).toBe('project');
			expect(state.folderPath).toBe('/my/project');
			expect(state.settings).toEqual({ version: 1, connections: [] });
			expect(state.files).toHaveLength(1);
			expect(state.loading).toBe(false);
		});

		it('stays standalone when no settings', async () => {
			// Arrange
			mockReadSettings.mockResolvedValue(null);

			// Act
			await useProjectStore.getState().openFolder('/my/folder');

			// Assert
			const state = useProjectStore.getState();
			expect(state.mode).toBe('standalone');
			expect(state.folderPath).toBe('/my/folder');
			expect(state.settings).toBeNull();
			expect(state.files).toHaveLength(0);
		});

		it('sets error on failure', async () => {
			// Arrange
			mockReadSettings.mockRejectedValue(new Error('Permission denied'));

			// Act
			await useProjectStore.getState().openFolder('/restricted');

			// Assert
			const state = useProjectStore.getState();
			expect(state.error).toBe('Permission denied');
			expect(state.loading).toBe(false);
		});

		it('uses include/exclude from settings', async () => {
			// Arrange
			mockReadSettings.mockResolvedValue({
				version: 1,
				project: {
					include: ['**/*.sql'],
					exclude: ['backup'],
				},
			});
			mockReadDir.mockResolvedValue([
				{ name: 'query.sql', isDirectory: false, isFile: true },
				{ name: 'users.dbsp', isDirectory: false, isFile: true },
			]);

			// Act
			await useProjectStore.getState().openFolder('/project');

			// Assert
			const state = useProjectStore.getState();
			expect(state.files).toHaveLength(1);
			expect(state.files[0]!.name).toBe('query.sql');
		});
	});

	describe('closeFolder', () => {
		it('resets to standalone mode', () => {
			// Arrange
			useProjectStore.setState({
				mode: 'project',
				folderPath: '/project',
				settings: { version: 1 },
				files: [{ path: 'a.dbsp', name: 'a.dbsp', isDirectory: false }],
			});

			// Act
			useProjectStore.getState().closeFolder();

			// Assert
			const state = useProjectStore.getState();
			expect(state.mode).toBe('standalone');
			expect(state.folderPath).toBeNull();
			expect(state.settings).toBeNull();
			expect(state.files).toHaveLength(0);
		});
	});

	describe('refreshFiles', () => {
		it('re-discovers files with current settings', async () => {
			// Arrange
			useProjectStore.setState({
				mode: 'project',
				folderPath: '/project',
				settings: { version: 1 },
				files: [],
			});
			mockReadDir.mockResolvedValue([
				{ name: 'new.dbsp', isDirectory: false, isFile: true },
			]);

			// Act
			await useProjectStore.getState().refreshFiles();

			// Assert
			expect(useProjectStore.getState().files).toHaveLength(1);
			expect(useProjectStore.getState().files[0]!.name).toBe('new.dbsp');
		});

		it('does nothing without folder', async () => {
			// Act
			await useProjectStore.getState().refreshFiles();

			// Assert
			expect(mockReadDir).not.toHaveBeenCalled();
		});
	});

	describe('onSettingsChanged (SC-27/SC-28)', () => {
		it('transitions standalone → project when settings appear', async () => {
			// Arrange
			useProjectStore.setState({
				mode: 'standalone',
				folderPath: '/project',
			});
			mockReadSettings.mockResolvedValue({ version: 1 });
			mockReadDir.mockResolvedValue([
				{ name: 'x.dbsp', isDirectory: false, isFile: true },
			]);

			// Act
			await useProjectStore.getState().onSettingsChanged(true);

			// Assert
			expect(useProjectStore.getState().mode).toBe('project');
		});

		it('transitions project → standalone when settings deleted', async () => {
			// Arrange
			useProjectStore.setState({
				mode: 'project',
				folderPath: '/project',
				settings: { version: 1 },
				files: [{ path: 'a.dbsp', name: 'a.dbsp', isDirectory: false }],
			});

			// Act
			await useProjectStore.getState().onSettingsChanged(false);

			// Assert
			const state = useProjectStore.getState();
			expect(state.mode).toBe('standalone');
			expect(state.settings).toBeNull();
			expect(state.files).toHaveLength(0);
		});

		it('ignores if no folder open', async () => {
			// Act
			await useProjectStore.getState().onSettingsChanged(true);

			// Assert
			expect(mockReadSettings).not.toHaveBeenCalled();
		});
	});
});
