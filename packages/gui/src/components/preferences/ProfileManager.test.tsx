// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '@/stores/connection-store';

// ── Mocks ────────────────────────────────────────────────────

const mockAsk = vi.fn().mockResolvedValue(true);
vi.mock('@tauri-apps/plugin-dialog', () => ({
	ask: (...args: unknown[]) => mockAsk(...args),
}));

vi.mock('sonner', () => ({
	toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));
const { toast } = await import('sonner');

const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockDeleteProfile = vi.fn().mockResolvedValue(undefined);
const mockSaveProfile = vi.fn().mockResolvedValue(undefined);
const mockTestConnection = vi.fn().mockResolvedValue(undefined);

vi.mock('@/hooks/useConnection', () => ({
	useConnection: () => ({
		disconnect: mockDisconnect,
		deleteProfile: mockDeleteProfile,
		saveProfile: mockSaveProfile,
		testConnection: mockTestConnection,
		testResult: null,
	}),
}));

const mockUpdateProfile = vi.fn();
const mockRemoveProfile = vi.fn();
const mockAddProfile = vi.fn();

const mockConnectionState = {
	profiles: [] as ConnectionProfile[],
	active: null as null | { profileId: string; connectionId: string },
};

vi.mock('@/stores/connection-store', () => ({
	useConnectionStore: Object.assign(
		(selector: (s: typeof mockConnectionState) => unknown) =>
			selector(mockConnectionState),
		{
			getState: () => ({
				addProfile: mockAddProfile,
				updateProfile: mockUpdateProfile,
				removeProfile: mockRemoveProfile,
			}),
		},
	),
	pgConfig: (profile: ConnectionProfile) => ({
		host: (profile.config as Record<string, unknown>).host ?? 'localhost',
		port: (profile.config as Record<string, unknown>).port ?? 5432,
		database: (profile.config as Record<string, unknown>).database ?? 'db',
		user: (profile.config as Record<string, unknown>).user ?? 'user',
		schema: (profile.config as Record<string, unknown>).schema ?? 'public',
		sslMode: (profile.config as Record<string, unknown>).sslMode ?? 'disable',
	}),
}));

const mockProjectState = {
	mode: 'standalone' as string,
	settings: null as null | Record<string, unknown>,
	folderPath: null as null | string,
};

vi.mock('@/stores/project-store', () => ({
	useProjectStore: Object.assign(
		(selector: (s: typeof mockProjectState) => unknown) =>
			selector(mockProjectState),
		{
			setState: vi.fn(),
		},
	),
}));

const mockWriteSettings = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/settings', () => ({
	writeSettings: (...args: unknown[]) => mockWriteSettings(...args),
}));

vi.mock('@/lib/ipc', () => ({
	sidecarApi: {
		listDatabases: vi.fn().mockResolvedValue({ databases: [] }),
		listSchemas: vi.fn().mockResolvedValue({ schemas: [] }),
	},
}));

// Mock ConnectionDialog — capture onSave for trigger in tests
let capturedOnSave: ((data: Record<string, unknown>) => void) | null = null;
vi.mock('@/components/connection/ConnectionDialog', () => ({
	ConnectionDialog: ({
		open,
		onSave,
	}: {
		open: boolean;
		onSave?: (data: Record<string, unknown>) => void;
	}) => {
		capturedOnSave = onSave ?? null;
		return open ? (
			<div data-testid="connection-dialog">ConnectionDialog</div>
		) : null;
	},
}));

const { ProfileManager } = await import('./ProfileManager');

afterEach(cleanup);

// ── Fixtures ─────────────────────────────────────────────────

function makeProfile(
	overrides?: Partial<ConnectionProfile>,
): ConnectionProfile {
	return {
		id: 'p1',
		name: 'dev-local',
		type: 'postgresql',
		config: {
			host: 'localhost',
			port: 5432,
			database: 'mydb',
			user: 'app',
			schema: 'public',
			sslMode: 'disable',
		},
		environment: 'dev',
		createdAt: Date.now(),
		lastUsedAt: null,
		...overrides,
	};
}

// ── Tests ────────────────────────────────────────────────────

describe('ProfileManager', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockConnectionState.profiles = [];
		mockConnectionState.active = null;
		mockProjectState.mode = 'standalone';
		mockProjectState.settings = null;
		mockProjectState.folderPath = null;
	});

	it('shows empty state when no profiles', () => {
		render(<ProfileManager />);
		expect(screen.getByText(/No connection profiles yet/)).toBeTruthy();
	});

	it('shows "Add Profile" button', () => {
		render(<ProfileManager />);
		expect(screen.getByText('Add Profile')).toBeTruthy();
	});

	it('renders profile with name and host info (SC-10)', () => {
		mockConnectionState.profiles = [makeProfile()];
		render(<ProfileManager />);
		expect(screen.getByText('dev-local')).toBeTruthy();
		expect(screen.getByText(/localhost:5432\/mydb/)).toBeTruthy();
	});

	it('shows environment badge', () => {
		mockConnectionState.profiles = [makeProfile({ environment: 'staging' })];
		render(<ProfileManager />);
		expect(screen.getByText('staging')).toBeTruthy();
	});

	it('shows connected badge for active profile', () => {
		mockConnectionState.profiles = [makeProfile()];
		mockConnectionState.active = {
			profileId: 'p1',
			connectionId: 'c1',
		};
		render(<ProfileManager />);
		expect(screen.getByText('connected')).toBeTruthy();
	});

	it('shows star icon for default profile in project mode (SC-12)', () => {
		mockProjectState.mode = 'project';
		mockProjectState.settings = { version: 1, defaultConnection: 'dev-local' };
		mockConnectionState.profiles = [makeProfile()];
		const { container } = render(<ProfileManager />);
		const starSvg = container.querySelector('svg.lucide-star');
		expect(starSvg).toBeTruthy();
	});

	it('opens ConnectionDialog on "Add Profile" click', () => {
		render(<ProfileManager />);
		fireEvent.click(screen.getByText('Add Profile'));
		expect(screen.getByTestId('connection-dialog')).toBeTruthy();
	});

	it('opens ConnectionDialog on Edit click (SC-11)', () => {
		mockConnectionState.profiles = [makeProfile()];
		render(<ProfileManager />);
		fireEvent.click(screen.getByTitle('Edit profile'));
		expect(screen.getByTestId('connection-dialog')).toBeTruthy();
	});

	it('shows confirmation dialog before delete (SC-13)', async () => {
		mockConnectionState.profiles = [makeProfile()];
		render(<ProfileManager />);
		fireEvent.click(screen.getByTitle('Delete profile'));
		await vi.waitFor(() => {
			expect(mockAsk).toHaveBeenCalledWith(
				expect.stringContaining('dev-local'),
				expect.objectContaining({ kind: 'warning' }),
			);
			expect(mockDeleteProfile).toHaveBeenCalledWith('p1');
		});
	});

	it('does not delete when confirmation is cancelled (SC-13)', async () => {
		mockAsk.mockResolvedValueOnce(false);
		mockConnectionState.profiles = [makeProfile()];
		render(<ProfileManager />);
		fireEvent.click(screen.getByTitle('Delete profile'));
		await vi.waitFor(() => {
			expect(mockAsk).toHaveBeenCalled();
		});
		expect(mockDeleteProfile).not.toHaveBeenCalled();
	});

	it('disconnects before deleting active profile (SC-14, ERR-05)', async () => {
		mockConnectionState.profiles = [makeProfile()];
		mockConnectionState.active = {
			profileId: 'p1',
			connectionId: 'c1',
		};
		render(<ProfileManager />);
		fireEvent.click(screen.getByTitle('Delete profile'));
		await vi.waitFor(() => {
			expect(mockDisconnect).toHaveBeenCalled();
			expect(mockDeleteProfile).toHaveBeenCalledWith('p1');
		});
	});

	it('hides Set/Clear Default buttons in standalone mode', () => {
		mockConnectionState.profiles = [makeProfile()];
		render(<ProfileManager />);
		expect(screen.queryByTitle('Set as default')).toBeNull();
		expect(screen.queryByTitle('Clear default')).toBeNull();
	});

	it('shows Set as Default in project mode', () => {
		mockProjectState.mode = 'project';
		mockProjectState.settings = { version: 1 };
		mockProjectState.folderPath = '/my/project';
		mockConnectionState.profiles = [makeProfile()];
		render(<ProfileManager />);
		expect(screen.getByTitle('Set as default')).toBeTruthy();
	});

	it('shows Clear Default for default profile in project mode', () => {
		mockProjectState.mode = 'project';
		mockProjectState.settings = { version: 1, defaultConnection: 'dev-local' };
		mockProjectState.folderPath = '/my/project';
		mockConnectionState.profiles = [makeProfile()];
		render(<ProfileManager />);
		expect(screen.getByTitle('Clear default')).toBeTruthy();
	});

	it('updates defaultConnection when renaming default profile (SC-17)', async () => {
		mockProjectState.mode = 'project';
		mockProjectState.settings = { version: 1, defaultConnection: 'dev-local' };
		mockProjectState.folderPath = '/my/project';
		mockConnectionState.profiles = [makeProfile()];
		render(<ProfileManager />);
		// Open edit dialog
		fireEvent.click(screen.getByTitle('Edit profile'));
		// Trigger save with new name via captured callback
		expect(capturedOnSave).toBeTruthy();
		await capturedOnSave!({
			name: 'dev-renamed',
			type: 'postgresql',
			host: 'localhost',
			port: 5432,
			database: 'mydb',
			user: 'app',
			schema: 'public',
			sslMode: 'disable',
		});
		expect(mockUpdateProfile).toHaveBeenCalledWith(
			'p1',
			expect.objectContaining({ name: 'dev-renamed' }),
		);
		expect(mockWriteSettings).toHaveBeenCalledWith(
			'/my/project',
			expect.objectContaining({ defaultConnection: 'dev-renamed' }),
		);
	});

	it('rejects duplicate profile name (INV-05)', async () => {
		mockConnectionState.profiles = [
			makeProfile({ id: 'p1', name: 'dev-local' }),
			makeProfile({ id: 'p2', name: 'prod-db' }),
		];
		render(<ProfileManager />);
		// Open Add dialog
		fireEvent.click(screen.getByText('Add Profile'));
		// Attempt to save with existing name
		expect(capturedOnSave).toBeTruthy();
		await capturedOnSave!({
			name: 'dev-local',
			type: 'postgresql',
			host: 'localhost',
			port: 5432,
			database: 'otherdb',
			user: 'app',
			schema: 'public',
			sslMode: 'disable',
		});
		// Should show error toast, not save
		expect(toast.error).toHaveBeenCalledWith(
			expect.stringContaining('dev-local'),
		);
		expect(mockSaveProfile).not.toHaveBeenCalled();
	});
});
