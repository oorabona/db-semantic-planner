// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '@/stores/connection-store';
import { sortProfiles } from './SidebarConnectionPanel';

// ── Mocks ────────────────────────────────────────────────────

const mockQuickConnect = vi.fn();

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
const { SidebarConnectionPanel } = await import('./SidebarConnectionPanel');

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

describe('SidebarConnectionPanel', () => {
	const onNewConnection = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		mockConnectionState.profiles = [];
		mockConnectionState.active = null;
		mockConnectionState.status = 'disconnected';
		mockProjectState.mode = 'standalone';
		mockProjectState.settings = null;
	});

	it('shows empty state when no profiles (SC-09)', () => {
		render(<SidebarConnectionPanel onNewConnection={onNewConnection} />);
		expect(screen.getByText('No connections')).toBeTruthy();
		expect(screen.getByText('New Connection...')).toBeTruthy();
	});

	it('empty state "New Connection..." calls onNewConnection', () => {
		render(<SidebarConnectionPanel onNewConnection={onNewConnection} />);
		fireEvent.click(screen.getByText('New Connection...'));
		expect(onNewConnection).toHaveBeenCalled();
	});

	it('renders profile list (SC-06)', () => {
		mockConnectionState.profiles = [
			makeProfile(),
			makeProfile({ id: 'p2', name: 'prod-readonly', environment: 'prod' }),
		];
		render(<SidebarConnectionPanel onNewConnection={onNewConnection} />);
		expect(screen.getByText('dev-local')).toBeTruthy();
		expect(screen.getByText('prod-readonly')).toBeTruthy();
	});

	it('renders host:port/database for each profile', () => {
		mockConnectionState.profiles = [makeProfile()];
		render(<SidebarConnectionPanel onNewConnection={onNewConnection} />);
		expect(screen.getByText('localhost:5432/mydb')).toBeTruthy();
	});

	it('clicking profile calls quickConnect (SC-07)', () => {
		const profile = makeProfile();
		mockConnectionState.profiles = [profile];
		render(<SidebarConnectionPanel onNewConnection={onNewConnection} />);
		fireEvent.click(screen.getByText('dev-local'));
		expect(mockQuickConnect).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'dev-local' }),
		);
	});

	it('"New Connection..." button at bottom opens dialog', () => {
		mockConnectionState.profiles = [makeProfile()];
		render(<SidebarConnectionPanel onNewConnection={onNewConnection} />);
		fireEvent.click(screen.getByText('New Connection...'));
		expect(onNewConnection).toHaveBeenCalled();
	});

	it('shows default star in project mode (SC-08)', () => {
		mockProjectState.mode = 'project';
		mockProjectState.settings = { version: 1, defaultConnection: 'dev-local' };
		mockConnectionState.profiles = [makeProfile()];
		const { container } = render(
			<SidebarConnectionPanel onNewConnection={onNewConnection} />,
		);
		// Star icon rendered for default profile (lucide Star component)
		const starSvg = container.querySelector(
			'svg.lucide-star, [data-testid="star-icon"]',
		);
		expect(starSvg).toBeTruthy();
	});
});

// ── Sort function unit tests ─────────────────────────────────

describe('sortProfiles', () => {
	it('puts default profile first', () => {
		const profiles = [
			makeProfile({ id: 'p1', name: 'beta' }),
			makeProfile({ id: 'p2', name: 'alpha' }),
		];
		const sorted = sortProfiles(profiles, 'alpha');
		expect(sorted[0]!.name).toBe('alpha');
	});

	it('sorts by lastUsedAt desc (null last)', () => {
		const profiles = [
			makeProfile({ id: 'p1', name: 'old', lastUsedAt: 100 }),
			makeProfile({ id: 'p2', name: 'new', lastUsedAt: 200 }),
			makeProfile({ id: 'p3', name: 'never', lastUsedAt: null }),
		];
		const sorted = sortProfiles(profiles);
		expect(sorted.map((p) => p.name)).toEqual(['new', 'old', 'never']);
	});

	it('tie-breaks by name asc', () => {
		const profiles = [
			makeProfile({ id: 'p1', name: 'zed', lastUsedAt: null }),
			makeProfile({ id: 'p2', name: 'alpha', lastUsedAt: null }),
		];
		const sorted = sortProfiles(profiles);
		expect(sorted.map((p) => p.name)).toEqual(['alpha', 'zed']);
	});
});
