// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '@/stores/connection-store';
import { ProfileListItem } from './ProfileListItem';

vi.mock('@/stores/connection-store', () => ({
	pgConfig: (profile: ConnectionProfile) => ({
		host: (profile.config as Record<string, unknown>).host ?? 'localhost',
		port: (profile.config as Record<string, unknown>).port ?? 5432,
		database: (profile.config as Record<string, unknown>).database ?? 'db',
		user: (profile.config as Record<string, unknown>).user ?? 'user',
		schema: (profile.config as Record<string, unknown>).schema ?? 'public',
		sslMode: (profile.config as Record<string, unknown>).sslMode ?? 'disable',
	}),
}));

function makeProfile(
	overrides?: Partial<ConnectionProfile>,
): ConnectionProfile {
	return {
		id: 'prof-1',
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

afterEach(cleanup);

describe('ProfileListItem', () => {
	it('renders profile name', () => {
		render(<ProfileListItem profile={makeProfile()} />);
		expect(screen.getByText('dev-local')).toBeTruthy();
	});

	it('renders host:port/database when not compact', () => {
		render(<ProfileListItem profile={makeProfile()} />);
		expect(screen.getByText('localhost:5432/mydb')).toBeTruthy();
	});

	it('hides host:port/database in compact mode', () => {
		render(<ProfileListItem profile={makeProfile()} compact />);
		expect(screen.queryByText('localhost:5432/mydb')).toBeNull();
	});

	it('shows environment badge', () => {
		render(
			<ProfileListItem profile={makeProfile({ environment: 'staging' })} />,
		);
		expect(screen.getByText('staging')).toBeTruthy();
	});

	it('hides environment badge when null', () => {
		render(<ProfileListItem profile={makeProfile({ environment: null })} />);
		expect(screen.queryByText('dev')).toBeNull();
	});

	it('calls onClick when clicked', () => {
		const onClick = vi.fn();
		render(<ProfileListItem profile={makeProfile()} onClick={onClick} />);
		fireEvent.click(screen.getByRole('button'));
		expect(onClick).toHaveBeenCalled();
	});

	it('is a button element', () => {
		render(<ProfileListItem profile={makeProfile()} />);
		expect(screen.getByRole('button')).toBeTruthy();
	});
});
