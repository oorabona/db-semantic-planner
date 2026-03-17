import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	mockJoin,
	mockRemove,
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
	mockNeedsMigration,
	mockMigrateSettings,
} = vi.hoisted(() => ({
	mockJoin: vi.fn(),
	mockRemove: vi.fn().mockResolvedValue(undefined),
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
	mockNeedsMigration: vi.fn().mockReturnValue(false),
	mockMigrateSettings: vi.fn(),
}));

vi.mock('@/lib/migration', () => ({
	migrateFromLocalStorage: mockMigrateFromLocalStorage,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
	remove: mockRemove,
}));

vi.mock('@/lib/settings-migration', () => ({
	needsMigration: mockNeedsMigration,
	migrateSettings: mockMigrateSettings,
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

import { useProjectStore } from './project-store';

// ── Reset store between tests ───────────────────────────────────

beforeEach(() => {
	vi.clearAllMocks();
	mockJoin.mockImplementation((...parts: string[]) =>
		Promise.resolve(parts.join('/')),
	);
	mockSanitizeFolderName.mockImplementation((name: string) =>
		name.toLowerCase(),
	);
	// Reset migration mocks to defaults (clearAllMocks doesn't reset return values)
	mockNeedsMigration.mockReturnValue(false);
	mockMigrateSettings.mockReset();
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

// ── useProjectStore ─────────────────────────────────────────────

describe('useProjectStore', () => {
	describe('openFolder', () => {
		it('enters project mode when settings exist with files[]', async () => {
			// Arrange
			mockReadSettings.mockResolvedValue({
				version: 1,
				project: { files: ['users.dbsp'] },
				connections: [],
			});

			// Act
			await useProjectStore.getState().openFolder('/my/project');

			// Assert
			const state = useProjectStore.getState();
			expect(state.mode).toBe('project');
			expect(state.folderPath).toBe('/my/project');
			expect(state.folderName).toBe('project');
			expect(state.files).toHaveLength(1);
			expect(state.files[0]).toHaveProperty('name', 'users.dbsp');
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

		it('uses explicit files[] from settings', async () => {
			// Arrange
			mockReadSettings.mockResolvedValue({
				version: 1,
				project: {
					files: ['src/query.dbsp', 'src/users.dbsp'],
				},
			});

			// Act
			await useProjectStore.getState().openFolder('/project');

			// Assert — buildPairedTree produces dir nodes with type='dir'
			const state = useProjectStore.getState();
			expect(state.files).toHaveLength(1); // 1 directory node (src)
			const dir = state.files[0]!;
			expect(dir).toHaveProperty('type', 'dir');
			expect(dir).toHaveProperty('children');
			if ('children' in dir) {
				expect(dir.children).toHaveLength(2);
			}
		});

		it('triggers migration when legacy settings detected', async () => {
			// Arrange
			const legacySettings = { version: 1 as const, project: { name: 'old' } };
			const migratedSettings = {
				version: 1 as const,
				project: { name: 'old', files: ['main.dbsp'] },
			};
			mockReadSettings.mockResolvedValue(legacySettings);
			mockNeedsMigration.mockReturnValue(true);
			mockMigrateSettings.mockResolvedValue(migratedSettings);

			// Act
			await useProjectStore.getState().openFolder('/project');

			// Assert
			expect(mockNeedsMigration).toHaveBeenCalledWith(legacySettings);
			expect(mockMigrateSettings).toHaveBeenCalledWith(
				legacySettings,
				'/project',
			);
			const state = useProjectStore.getState();
			expect(state.files).toHaveLength(1);
			expect(state.files[0]).toHaveProperty('name', 'main.dbsp');
		});

		it('opens project DB and wires history on project mode', async () => {
			// Arrange
			mockReadSettings.mockResolvedValue({
				version: 1,
				project: { files: [] },
			});

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
			mockReadSettings.mockResolvedValue({
				version: 1,
				project: { files: [] },
			});
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
			mockReadSettings.mockResolvedValue({
				version: 1,
				project: { files: [] },
			});

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
			mockReadSettings.mockResolvedValue({
				version: 1,
				project: { files: [] },
			});
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
				files: [
					{ type: 'file', path: 'a.dbsp', name: 'a.dbsp', language: 'dbsp' },
				],
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
		it('rebuilds file tree from settings.project.files', async () => {
			// Arrange
			useProjectStore.setState({
				mode: 'project',
				folderPath: '/project',
				settings: {
					version: 1,
					project: { files: ['new.dbsp', 'src/query.dbsp'] },
				},
				files: [],
			});

			// Act
			await useProjectStore.getState().refreshFiles();

			// Assert
			const files = useProjectStore.getState().files;
			expect(files).toHaveLength(2); // src dir + new.dbsp
		});

		it('does nothing without folder', async () => {
			// Act
			await useProjectStore.getState().refreshFiles();

			// Assert — no crash, no state change
			expect(useProjectStore.getState().files).toHaveLength(0);
		});
	});

	describe('onSettingsChanged (SC-27/SC-28)', () => {
		it('transitions standalone → project when settings appear', async () => {
			// Arrange
			useProjectStore.setState({
				mode: 'standalone',
				folderPath: '/project',
			});
			mockReadSettings.mockResolvedValue({
				version: 1,
				project: { files: ['x.dbsp'] },
			});

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
				files: [
					{ type: 'file', path: 'a.dbsp', name: 'a.dbsp', language: 'dbsp' },
				],
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
				project: { name: 'demo', files: [] },
			});

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
				project: { name: 'demo', files: [] },
			});

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
			mockReadSettings.mockResolvedValue({
				version: 1,
				project: { files: [] },
			});

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
			mockReadSettings.mockResolvedValue({
				version: 1,
				project: { files: [] },
			});

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
