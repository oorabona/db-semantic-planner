import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	mockReadDir,
	mockJoin,
	mockReadSettings,
	mockOpenProjectDb,
	mockCloseProjectDb,
	mockOpenDefaultDb,
	mockGetProjectDb,
	mockAddRecentProject,
	mockSanitizeFolderName,
	mockLoadProfiles,
	mockSetHistoryDbAccessor,
	mockLoadHistory,
	mockWriteSettings,
	mockAddProfile,
	mockMigrateFromLocalStorage,
} = vi.hoisted(() => ({
	mockReadDir: vi.fn(),
	mockJoin: vi.fn(),
	mockReadSettings: vi.fn(),
	mockOpenProjectDb: vi.fn().mockResolvedValue(undefined),
	mockCloseProjectDb: vi.fn().mockResolvedValue(undefined),
	mockOpenDefaultDb: vi.fn().mockResolvedValue(undefined),
	mockGetProjectDb: vi.fn().mockReturnValue(null),
	mockAddRecentProject: vi.fn().mockResolvedValue(undefined),
	mockSanitizeFolderName: vi.fn((name: string) => name.toLowerCase()),
	mockLoadProfiles: vi.fn().mockResolvedValue(undefined),
	mockSetHistoryDbAccessor: vi.fn(),
	mockLoadHistory: vi.fn().mockResolvedValue(undefined),
	mockWriteSettings: vi.fn().mockResolvedValue(undefined),
	mockAddProfile: vi.fn(),
	mockMigrateFromLocalStorage: vi.fn().mockResolvedValue({
		historyMigrated: 0,
		historySkipped: 0,
		connectionsMigrated: 0,
		connectionsSkipped: 0,
		alreadyDone: true,
	}),
}));

vi.mock('@/lib/migration', () => ({
	migrateFromLocalStorage: mockMigrateFromLocalStorage,
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
		writeSettings: mockWriteSettings,
	};
});

vi.mock('@/lib/project-db', () => ({
	openProjectDb: mockOpenProjectDb,
	closeProjectDb: mockCloseProjectDb,
	openDefaultDb: mockOpenDefaultDb,
	getProjectDb: mockGetProjectDb,
}));

vi.mock('@/lib/app-db', () => ({
	addRecentProject: mockAddRecentProject,
}));

vi.mock('@/lib/project-id', () => ({
	sanitizeFolderName: mockSanitizeFolderName,
}));

// Mock connection-store — provide a working zustand-like getState()
const mockConnectionStoreState = {
	profiles: [] as unknown[],
	loadProfiles: mockLoadProfiles,
	addProfile: mockAddProfile,
};
vi.mock('./connection-store', () => ({
	useConnectionStore: Object.assign(() => mockConnectionStoreState, {
		getState: () => mockConnectionStoreState,
		setState: vi.fn((partial: Record<string, unknown>) => {
			Object.assign(mockConnectionStoreState, partial);
		}),
	}),
}));

// Mock history-store
const mockHistoryStoreState = {
	entries: [] as unknown[],
	loaded: false,
	loadHistory: mockLoadHistory,
};
vi.mock('./history-store', () => ({
	setHistoryDbAccessor: mockSetHistoryDbAccessor,
	useHistoryStore: Object.assign(() => mockHistoryStoreState, {
		getState: () => mockHistoryStoreState,
		setState: vi.fn((partial: Record<string, unknown>) => {
			Object.assign(mockHistoryStoreState, partial);
		}),
	}),
}));

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
	mockSanitizeFolderName.mockImplementation((name: string) =>
		name.toLowerCase(),
	);
	// Reset store state
	useProjectStore.setState({
		mode: 'standalone',
		folderPath: null,
		folderName: null,
		settings: null,
		files: [],
		loading: false,
		error: null,
	});
	// Reset mock store states
	Object.assign(mockConnectionStoreState, {
		profiles: [],
		loadProfiles: mockLoadProfiles,
		addProfile: mockAddProfile,
	});
	Object.assign(mockHistoryStoreState, {
		entries: [],
		loaded: false,
		loadHistory: mockLoadHistory,
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

	it('skips directories that throw on readDir (permission errors)', async () => {
		// Arrange: root has a forbidden dir and a readable file
		mockReadDir
			.mockResolvedValueOnce([
				{ name: 'secret-folder', isDirectory: true, isFile: false },
				{ name: 'query.dbsp', isDirectory: false, isFile: true },
			])
			.mockRejectedValueOnce('forbidden path: /project/secret-folder'); // Tauri scope error

		// Act
		const files = await discoverFiles('/project');

		// Assert: forbidden dir skipped, file still included
		expect(files).toHaveLength(1);
		expect(files[0]!.name).toBe('query.dbsp');
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
			expect(state.folderName).toBe('project');
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
			expect(state.folderName).toBeNull();
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
			expect(state.error).toBe('Read settings: Permission denied');
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

		it('opens project DB and wires history on project mode', async () => {
			// Arrange
			mockReadSettings.mockResolvedValue({ version: 1 });
			mockReadDir.mockResolvedValue([]);

			// Act
			await useProjectStore.getState().openFolder('/my/project');

			// Assert — DB lifecycle
			expect(mockCloseProjectDb).toHaveBeenCalled();
			expect(mockOpenProjectDb).toHaveBeenCalledWith(
				'project',
				expect.any(Function),
			);
			expect(mockSetHistoryDbAccessor).toHaveBeenCalledWith(mockGetProjectDb);
			expect(mockLoadProfiles).toHaveBeenCalled();
			expect(mockLoadHistory).toHaveBeenCalled();
		});

		it('runs localStorage migration when project DB is available', async () => {
			// Arrange
			const fakeDb = { execute: vi.fn(), select: vi.fn() };
			mockReadSettings.mockResolvedValue({ version: 1 });
			mockReadDir.mockResolvedValue([]);
			mockGetProjectDb.mockReturnValue(fakeDb);

			// Act
			await useProjectStore.getState().openFolder('/my/project');

			// Assert — migration called with the DB handle
			expect(mockMigrateFromLocalStorage).toHaveBeenCalledWith(fakeDb);

			// Cleanup — restore default null return
			mockGetProjectDb.mockReturnValue(null);
		});

		it('tracks as recent project in app.sqlite', async () => {
			// Arrange
			mockReadSettings.mockResolvedValue({ version: 1 });
			mockReadDir.mockResolvedValue([]);

			// Act
			await useProjectStore.getState().openFolder('/my/project');

			// Assert
			expect(mockAddRecentProject).toHaveBeenCalledWith(
				'/my/project',
				'project',
				'project',
			);
		});

		it('derives folderName via sanitizeFolderName', async () => {
			// Arrange
			mockReadSettings.mockResolvedValue({ version: 1 });
			mockReadDir.mockResolvedValue([]);
			mockSanitizeFolderName.mockReturnValue('my-fancy-project');

			// Act
			await useProjectStore
				.getState()
				.openFolder('/home/user/My Fancy Project');

			// Assert
			expect(mockSanitizeFolderName).toHaveBeenCalledWith('My Fancy Project');
			expect(useProjectStore.getState().folderName).toBe('my-fancy-project');
			expect(mockOpenProjectDb).toHaveBeenCalledWith(
				'my-fancy-project',
				expect.any(Function),
			);
		});

		it('does not open DB in standalone mode', async () => {
			// Arrange
			mockReadSettings.mockResolvedValue(null);

			// Act
			await useProjectStore.getState().openFolder('/my/folder');

			// Assert
			expect(mockOpenProjectDb).not.toHaveBeenCalled();
			expect(mockLoadProfiles).not.toHaveBeenCalled();
			expect(mockAddRecentProject).not.toHaveBeenCalled();
		});
	});

	describe('closeFolder', () => {
		it('resets to standalone mode', async () => {
			// Arrange
			useProjectStore.setState({
				mode: 'project',
				folderPath: '/project',
				folderName: 'project',
				settings: { version: 1 },
				files: [{ path: 'a.dbsp', name: 'a.dbsp', isDirectory: false }],
			});

			// Act
			await useProjectStore.getState().closeFolder();

			// Assert
			const state = useProjectStore.getState();
			expect(state.mode).toBe('standalone');
			expect(state.folderPath).toBeNull();
			expect(state.folderName).toBeNull();
			expect(state.settings).toBeNull();
			expect(state.files).toHaveLength(0);
		});

		it('closes project DB and opens default', async () => {
			// Arrange
			useProjectStore.setState({
				mode: 'project',
				folderPath: '/project',
				folderName: 'project',
				settings: { version: 1 },
				files: [],
			});

			// Act
			await useProjectStore.getState().closeFolder();

			// Assert
			expect(mockCloseProjectDb).toHaveBeenCalled();
			expect(mockOpenDefaultDb).toHaveBeenCalled();
			expect(mockSetHistoryDbAccessor).toHaveBeenCalledWith(mockGetProjectDb);
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
				folderName: 'project',
				settings: { version: 1 },
				files: [{ path: 'a.dbsp', name: 'a.dbsp', isDirectory: false }],
			});

			// Act
			await useProjectStore.getState().onSettingsChanged(false);

			// Assert
			const state = useProjectStore.getState();
			expect(state.mode).toBe('standalone');
			expect(state.folderName).toBeNull();
			expect(state.settings).toBeNull();
			expect(state.files).toHaveLength(0);
		});

		it('closes project DB on settings deletion (SC-28)', async () => {
			// Arrange
			useProjectStore.setState({
				mode: 'project',
				folderPath: '/project',
				folderName: 'project',
				settings: { version: 1 },
				files: [],
			});

			// Act
			await useProjectStore.getState().onSettingsChanged(false);

			// Assert
			expect(mockCloseProjectDb).toHaveBeenCalled();
			expect(mockOpenDefaultDb).toHaveBeenCalled();
			expect(mockSetHistoryDbAccessor).toHaveBeenCalledWith(mockGetProjectDb);
		});

		it('ignores if no folder open', async () => {
			// Act
			await useProjectStore.getState().onSettingsChanged(true);

			// Assert
			expect(mockReadSettings).not.toHaveBeenCalled();
		});
	});

	// ── createProject ───────────────────────────────────────────

	describe('createProject', () => {
		it('writes settings file with project name', async () => {
			// Arrange — openFolder will read back the settings we wrote
			mockReadSettings.mockResolvedValue({
				version: 1,
				project: { name: 'demo' },
			});
			mockReadDir.mockResolvedValue([]);

			// Act
			await useProjectStore.getState().createProject({
				name: 'demo',
				folderPath: '/home/user/demo',
				connections: [],
				generateSchema: false,
			});

			// Assert
			expect(mockWriteSettings).toHaveBeenCalledWith('/home/user/demo', {
				version: 1,
				project: { name: 'demo' },
			});
		});

		it('transitions to project mode after creation', async () => {
			// Arrange
			mockReadSettings.mockResolvedValue({
				version: 1,
				project: { name: 'demo' },
			});
			mockReadDir.mockResolvedValue([]);

			// Act
			await useProjectStore.getState().createProject({
				name: 'demo',
				folderPath: '/home/user/demo',
				connections: [],
				generateSchema: false,
			});

			// Assert
			expect(useProjectStore.getState().mode).toBe('project');
			expect(useProjectStore.getState().folderPath).toBe('/home/user/demo');
		});

		it('saves wizard connections as profiles', async () => {
			// Arrange
			mockReadSettings.mockResolvedValue({ version: 1 });
			mockReadDir.mockResolvedValue([]);

			const connections = [
				{
					formData: {
						name: 'Dev DB',
						type: 'postgresql' as const,
						host: 'localhost',
						port: 5432,
						database: 'devdb',
						user: 'dev',
						password: 'pass',
						schema: 'public',
						sslMode: 'disable' as const,
					},
					environment: 'development',
				},
			];

			// Act
			await useProjectStore.getState().createProject({
				name: 'my-project',
				folderPath: '/project',
				connections,
				generateSchema: false,
			});

			// Assert
			expect(mockAddProfile).toHaveBeenCalledTimes(1);
			expect(mockAddProfile).toHaveBeenCalledWith(
				expect.objectContaining({
					name: 'Dev DB',
					type: 'postgresql',
					config: expect.objectContaining({
						host: 'localhost',
						port: 5432,
						database: 'devdb',
					}),
					environment: 'development',
				}),
			);
		});

		it('uses database@host as profile name when name is empty', async () => {
			// Arrange
			mockReadSettings.mockResolvedValue({ version: 1 });
			mockReadDir.mockResolvedValue([]);

			const connections = [
				{
					formData: {
						name: '',
						type: 'postgresql' as const,
						host: 'db.example.com',
						port: 5432,
						database: 'mydb',
						user: 'admin',
						password: '',
						schema: 'public',
						sslMode: 'disable' as const,
					},
					environment: 'production',
				},
			];

			// Act
			await useProjectStore.getState().createProject({
				name: 'prod-project',
				folderPath: '/prod',
				connections,
				generateSchema: false,
			});

			// Assert
			expect(mockAddProfile).toHaveBeenCalledWith(
				expect.objectContaining({
					name: 'mydb@db.example.com',
				}),
			);
		});

		it('sets error on failure', async () => {
			// Arrange
			mockWriteSettings.mockRejectedValue(new Error('Permission denied'));

			// Act + Assert
			await expect(
				useProjectStore.getState().createProject({
					name: 'fail',
					folderPath: '/no-access',
					connections: [],
					generateSchema: false,
				}),
			).rejects.toThrow('Permission denied');

			expect(useProjectStore.getState().error).toBe('Permission denied');
			expect(useProjectStore.getState().loading).toBe(false);
		});
	});
});
