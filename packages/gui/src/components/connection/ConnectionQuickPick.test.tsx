// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '@/stores/connection-store';

// ── Mocks ────────────────────────────────────────────────────

const mockQuickConnect = vi.fn();
const mockDisconnect = vi.fn();

vi.mock('@/hooks/useConnectFlow', () => ({
	useConnectFlow: () => ({
		quickConnect: mockQuickConnect,
		promptOpen: false,
		promptProfile: null,
		promptError: null,
		connecting: false,
		submitPassword: vi.fn(),
		cancelPassword: vi.fn(),
	}),
}));

vi.mock('@/hooks/useConnection', () => ({
	useConnection: () => ({
		disconnect: mockDisconnect,
	}),
}));

vi.mock('@/components/ui/popover', () => ({
	Popover: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	PopoverContent: ({ children }: { children: React.ReactNode }) => (
		<div data-testid="popover-content">{children}</div>
	),
}));

vi.mock('@/components/ui/dialog', () => ({
	Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
		open ? <div data-testid="dialog">{children}</div> : null,
	DialogContent: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	DialogHeader: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	DialogTitle: ({ children }: { children: React.ReactNode }) => (
		<h2>{children}</h2>
	),
	DialogFooter: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
}));

const mockConnectionState = {
	profiles: [] as ConnectionProfile[],
	active: null as null | { profileId: string; connectionId: string },
	status: 'disconnected' as string,
	error: null as string | null,
};

const mockProjectState = {
	mode: 'standalone' as string,
	settings: null as null | { version: 1; defaultConnection?: string },
};

vi.mock('@/stores/connection-store', () => ({
	useConnectionStore: (selector: (s: typeof mockConnectionState) => unknown) =>
		selector(mockConnectionState),
	pgConfig: (profile: ConnectionProfile) => ({
		host: (profile.config as Record<string, unknown>).host ?? 'localhost',
		port: (profile.config as Record<string, unknown>).port ?? 5432,
		database: (profile.config as Record<string, unknown>).database ?? 'db',
		user: (profile.config as Record<string, unknown>).user ?? 'user',
		schema: (profile.config as Record<string, unknown>).schema ?? 'public',
		sslMode: (profile.config as Record<string, unknown>).sslMode ?? 'disable',
	}),
}));

vi.mock('@/stores/project-store', () => ({
	useProjectStore: (selector: (s: typeof mockProjectState) => unknown) =>
		selector(mockProjectState),
}));

// Dynamic import AFTER mocks
const { ConnectionQuickPick } = await import('./ConnectionQuickPick');

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

describe('ConnectionQuickPick', () => {
	const onNewConnection = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		mockConnectionState.profiles = [];
		mockConnectionState.active = null;
		mockConnectionState.status = 'disconnected';
		mockConnectionState.error = null;
		mockProjectState.mode = 'standalone';
		mockProjectState.settings = null;
	});

	it('renders ConnectionStatus as trigger', () => {
		render(<ConnectionQuickPick onNewConnection={onNewConnection} />);
		// ConnectionStatus shows "Disconnected" label by default
		expect(screen.getByText('Disconnected')).toBeTruthy();
	});

	it('shows "No profiles" when empty', () => {
		render(<ConnectionQuickPick onNewConnection={onNewConnection} />);
		expect(screen.getByText('No profiles')).toBeTruthy();
	});

	it('renders profile list (SC-15)', () => {
		mockConnectionState.profiles = [
			makeProfile(),
			makeProfile({ id: 'p2', name: 'staging-db', environment: 'staging' }),
		];
		render(<ConnectionQuickPick onNewConnection={onNewConnection} />);
		expect(screen.getByText('dev-local')).toBeTruthy();
		expect(screen.getByText('staging-db')).toBeTruthy();
	});

	it('shows checkmark for active profile (SC-15)', () => {
		mockConnectionState.profiles = [makeProfile()];
		mockConnectionState.active = {
			profileId: 'p1',
			connectionId: 'c1',
		};
		mockConnectionState.status = 'connected';
		const { container } = render(
			<ConnectionQuickPick onNewConnection={onNewConnection} />,
		);
		// ProfileListItem renders Check icon when isActive
		const checkSvg = container.querySelector('svg.lucide-check');
		expect(checkSvg).toBeTruthy();
	});

	it('clicking profile calls quickConnect (SC-16)', () => {
		const profile = makeProfile();
		mockConnectionState.profiles = [profile];
		render(<ConnectionQuickPick onNewConnection={onNewConnection} />);
		fireEvent.click(screen.getByText('dev-local'));
		expect(mockQuickConnect).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'dev-local' }),
		);
	});

	it('shows Disconnect when connected', () => {
		mockConnectionState.profiles = [makeProfile()];
		mockConnectionState.active = {
			profileId: 'p1',
			connectionId: 'c1',
		};
		mockConnectionState.status = 'connected';
		render(<ConnectionQuickPick onNewConnection={onNewConnection} />);
		expect(screen.getByText('Disconnect')).toBeTruthy();
	});

	it('hides Disconnect when disconnected', () => {
		mockConnectionState.profiles = [makeProfile()];
		render(<ConnectionQuickPick onNewConnection={onNewConnection} />);
		expect(screen.queryByText('Disconnect')).toBeNull();
	});

	it('clicking Disconnect calls disconnect', () => {
		mockConnectionState.profiles = [makeProfile()];
		mockConnectionState.active = {
			profileId: 'p1',
			connectionId: 'c1',
		};
		mockConnectionState.status = 'connected';
		render(<ConnectionQuickPick onNewConnection={onNewConnection} />);
		fireEvent.click(screen.getByText('Disconnect'));
		expect(mockDisconnect).toHaveBeenCalled();
	});

	it('shows "New Connection..." button', () => {
		render(<ConnectionQuickPick onNewConnection={onNewConnection} />);
		expect(screen.getByText('New Connection...')).toBeTruthy();
	});

	it('clicking "New Connection..." calls onNewConnection', () => {
		render(<ConnectionQuickPick onNewConnection={onNewConnection} />);
		fireEvent.click(screen.getByText('New Connection...'));
		expect(onNewConnection).toHaveBeenCalled();
	});

	it('shows default star in project mode', () => {
		mockProjectState.mode = 'project';
		mockProjectState.settings = { version: 1, defaultConnection: 'dev-local' };
		mockConnectionState.profiles = [makeProfile()];
		const { container } = render(
			<ConnectionQuickPick onNewConnection={onNewConnection} />,
		);
		const starSvg = container.querySelector('svg.lucide-star');
		expect(starSvg).toBeTruthy();
	});
});
