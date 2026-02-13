import { beforeEach, describe, expect, it } from 'vitest';
import {
	type ConnectionProfile,
	useConnectionStore,
} from './connection-store.js';

const PROFILE: ConnectionProfile = {
	id: 'test-1',
	name: 'Dev DB',
	type: 'postgresql',
	host: 'localhost',
	port: 5432,
	database: 'testdb',
	user: 'postgres',
	schema: 'public',
	sslMode: 'prefer',
};

describe('useConnectionStore', () => {
	beforeEach(() => {
		// Reset store between tests
		useConnectionStore.setState({
			profiles: [],
			active: null,
			status: 'disconnected',
			error: null,
		});
	});

	describe('profiles', () => {
		it('starts with empty profiles', () => {
			expect(useConnectionStore.getState().profiles).toEqual([]);
		});

		it('adds a profile', () => {
			useConnectionStore.getState().addProfile(PROFILE);
			expect(useConnectionStore.getState().profiles).toHaveLength(1);
			expect(useConnectionStore.getState().profiles[0]).toEqual(PROFILE);
		});

		it('updates a profile', () => {
			useConnectionStore.getState().addProfile(PROFILE);
			useConnectionStore
				.getState()
				.updateProfile('test-1', { name: 'Prod DB' });
			expect(useConnectionStore.getState().profiles[0]!.name).toBe('Prod DB');
			// Other fields unchanged
			expect(useConnectionStore.getState().profiles[0]!.host).toBe('localhost');
		});

		it('does not update non-existent profile', () => {
			useConnectionStore.getState().addProfile(PROFILE);
			useConnectionStore
				.getState()
				.updateProfile('non-existent', { name: 'Nope' });
			expect(useConnectionStore.getState().profiles[0]!.name).toBe('Dev DB');
		});

		it('removes a profile', () => {
			useConnectionStore.getState().addProfile(PROFILE);
			useConnectionStore.getState().removeProfile('test-1');
			expect(useConnectionStore.getState().profiles).toHaveLength(0);
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
