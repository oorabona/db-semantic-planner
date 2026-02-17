// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type ConnectionProfile,
	pgConfig,
	useConnectionStore,
} from './connection-store.js';

// Mock project-db — store calls these for persistence
vi.mock('@/lib/project-db.js', () => ({
	upsertConnectionProfile: vi.fn().mockResolvedValue(undefined),
	listConnectionProfiles: vi.fn().mockResolvedValue([]),
	deleteConnectionProfile: vi.fn().mockResolvedValue(undefined),
	touchConnectionProfile: vi.fn().mockResolvedValue(undefined),
}));

import {
	deleteConnectionProfile,
	listConnectionProfiles,
	touchConnectionProfile,
	upsertConnectionProfile,
} from '@/lib/project-db.js';

const PROFILE: ConnectionProfile = {
	id: 'test-1',
	name: 'Dev DB',
	type: 'postgresql',
	config: {
		host: 'localhost',
		port: 5432,
		database: 'testdb',
		user: 'postgres',
		schema: 'public',
		sslMode: 'prefer',
	},
	environment: null,
	createdAt: 1700000000000,
	lastUsedAt: null,
};

describe('useConnectionStore', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset store between tests
		useConnectionStore.setState({
			profiles: [],
			active: null,
			status: 'disconnected',
			error: null,
		});
	});

	describe('pgConfig', () => {
		it('extracts PostgreSQL config from profile', () => {
			const pg = pgConfig(PROFILE);
			expect(pg).toEqual({
				host: 'localhost',
				port: 5432,
				database: 'testdb',
				user: 'postgres',
				schema: 'public',
				sslMode: 'prefer',
			});
		});

		it('provides defaults for missing config fields', () => {
			const sparse: ConnectionProfile = {
				id: 'sparse-1',
				name: 'Sparse',
				type: 'postgresql',
				config: {},
				environment: null,
				createdAt: 0,
				lastUsedAt: null,
			};
			const pg = pgConfig(sparse);
			expect(pg.host).toBe('localhost');
			expect(pg.port).toBe(5432);
			expect(pg.database).toBe('');
			expect(pg.user).toBe('postgres');
			expect(pg.schema).toBe('public');
			expect(pg.sslMode).toBe('prefer');
		});
	});

	describe('profiles CRUD', () => {
		it('starts with empty profiles', () => {
			expect(useConnectionStore.getState().profiles).toEqual([]);
		});

		it('adds a profile (optimistic + SQLite)', () => {
			useConnectionStore.getState().addProfile(PROFILE);
			expect(useConnectionStore.getState().profiles).toHaveLength(1);
			expect(useConnectionStore.getState().profiles[0]).toEqual(PROFILE);
			// Fire-and-forget SQLite write
			expect(upsertConnectionProfile).toHaveBeenCalledWith(
				expect.objectContaining({
					id: 'test-1',
					name: 'Dev DB',
					type: 'postgresql',
					config: JSON.stringify(PROFILE.config),
				}),
			);
		});

		it('updates a profile', () => {
			useConnectionStore.getState().addProfile(PROFILE);
			useConnectionStore
				.getState()
				.updateProfile('test-1', { name: 'Prod DB' });
			expect(useConnectionStore.getState().profiles[0]!.name).toBe('Prod DB');
			// Config blob unchanged
			expect(pgConfig(useConnectionStore.getState().profiles[0]!).host).toBe(
				'localhost',
			);
		});

		it('does not update non-existent profile', () => {
			useConnectionStore.getState().addProfile(PROFILE);
			useConnectionStore
				.getState()
				.updateProfile('non-existent', { name: 'Nope' });
			expect(useConnectionStore.getState().profiles[0]!.name).toBe('Dev DB');
		});

		it('removes a profile (optimistic + SQLite)', () => {
			useConnectionStore.getState().addProfile(PROFILE);
			vi.clearAllMocks(); // Reset to only track the delete call
			useConnectionStore.getState().removeProfile('test-1');
			expect(useConnectionStore.getState().profiles).toHaveLength(0);
			expect(deleteConnectionProfile).toHaveBeenCalledWith('test-1');
		});

		it('touches a profile (updates lastUsedAt)', () => {
			useConnectionStore.getState().addProfile(PROFILE);
			vi.clearAllMocks();
			const before = Date.now();
			useConnectionStore.getState().touchProfile('test-1');
			const after = Date.now();

			const updated = useConnectionStore.getState().profiles[0]!;
			expect(updated.lastUsedAt).toBeGreaterThanOrEqual(before);
			expect(updated.lastUsedAt).toBeLessThanOrEqual(after);
			expect(touchConnectionProfile).toHaveBeenCalledWith('test-1');
		});
	});

	describe('loadProfiles', () => {
		it('loads profiles from SQLite rows', async () => {
			vi.mocked(listConnectionProfiles).mockResolvedValue([
				{
					id: 'db-1',
					name: 'From DB',
					type: 'postgresql',
					config: JSON.stringify({
						host: 'db-host',
						port: 5433,
						database: 'mydb',
						user: 'admin',
					}),
					environment: 'prod',
					color: '#ff0000',
					created_at: 1700000000000,
					last_used_at: 1700000001000,
				},
			]);

			await useConnectionStore.getState().loadProfiles();

			const profiles = useConnectionStore.getState().profiles;
			expect(profiles).toHaveLength(1);
			expect(profiles[0]).toEqual({
				id: 'db-1',
				name: 'From DB',
				type: 'postgresql',
				config: {
					host: 'db-host',
					port: 5433,
					database: 'mydb',
					user: 'admin',
				},
				environment: 'prod',
				color: '#ff0000',
				createdAt: 1700000000000,
				lastUsedAt: 1700000001000,
			});
		});
	});

	describe('migrateFromLocalStorage', () => {
		it('migrates legacy localStorage profiles to SQLite', async () => {
			// Set up legacy localStorage format
			const legacy = {
				state: {
					profiles: [
						{
							id: 'old-1',
							name: 'Old Profile',
							type: 'postgresql',
							host: 'oldhost',
							port: 5432,
							database: 'olddb',
							user: 'olduser',
							schema: 'public',
							sslMode: 'prefer',
						},
					],
				},
			};
			localStorage.setItem('dbsp-connections', JSON.stringify(legacy));

			// After migration, loadProfiles will be called — mock it to return the migrated data
			vi.mocked(listConnectionProfiles).mockResolvedValue([
				{
					id: 'old-1',
					name: 'Old Profile',
					type: 'postgresql',
					config: JSON.stringify({
						host: 'oldhost',
						port: 5432,
						database: 'olddb',
						user: 'olduser',
						schema: 'public',
						sslMode: 'prefer',
					}),
					environment: null,
					color: null,
					created_at: expect.any(Number) as unknown as number,
					last_used_at: null,
				},
			]);

			await useConnectionStore.getState().migrateFromLocalStorage();

			// Should have upserted to SQLite
			expect(upsertConnectionProfile).toHaveBeenCalledWith(
				expect.objectContaining({
					id: 'old-1',
					name: 'Old Profile',
					type: 'postgresql',
				}),
			);
			// Should have cleared localStorage
			expect(localStorage.getItem('dbsp-connections')).toBeNull();
		});

		it('skips when no localStorage data', async () => {
			localStorage.removeItem('dbsp-connections');
			await useConnectionStore.getState().migrateFromLocalStorage();
			expect(upsertConnectionProfile).not.toHaveBeenCalled();
		});

		it('skips when localStorage has empty profiles array', async () => {
			localStorage.setItem(
				'dbsp-connections',
				JSON.stringify({ state: { profiles: [] } }),
			);
			await useConnectionStore.getState().migrateFromLocalStorage();
			expect(upsertConnectionProfile).not.toHaveBeenCalled();
		});
	});

	describe('active connection', () => {
		it('starts disconnected', () => {
			const state = useConnectionStore.getState();
			expect(state.active).toBeNull();
			expect(state.status).toBe('disconnected');
			expect(state.error).toBeNull();
		});

		it('sets active connection', () => {
			useConnectionStore.getState().setActive({
				connectionId: 'conn-abc',
				profileId: 'test-1',
				database: 'testdb',
				schema: 'public',
			});
			const state = useConnectionStore.getState();
			expect(state.active?.connectionId).toBe('conn-abc');
			expect(state.status).toBe('connected');
			expect(state.error).toBeNull();
		});

		it('clears active connection', () => {
			useConnectionStore.getState().setActive({
				connectionId: 'conn-abc',
				profileId: 'test-1',
				database: 'testdb',
				schema: 'public',
			});
			useConnectionStore.getState().clearActive();
			const state = useConnectionStore.getState();
			expect(state.active).toBeNull();
			expect(state.status).toBe('disconnected');
		});
	});

	describe('status', () => {
		it('sets status without error', () => {
			useConnectionStore.getState().setStatus('connecting');
			expect(useConnectionStore.getState().status).toBe('connecting');
			expect(useConnectionStore.getState().error).toBeNull();
		});

		it('sets status with error', () => {
			useConnectionStore.getState().setStatus('error', 'Connection refused');
			expect(useConnectionStore.getState().status).toBe('error');
			expect(useConnectionStore.getState().error).toBe('Connection refused');
		});

		it('clears error when setting non-error status', () => {
			useConnectionStore.getState().setStatus('error', 'Some error');
			useConnectionStore.getState().setStatus('connecting');
			expect(useConnectionStore.getState().error).toBeNull();
		});
	});
});
