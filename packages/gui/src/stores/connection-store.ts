import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ── Types ────────────────────────────────────────────────────────

export type SslMode =
	| 'disable'
	| 'allow'
	| 'prefer'
	| 'require'
	| 'verify-full';

export type DatabaseType = 'postgresql' | 'mysql' | 'sqlite' | 'mssql';

export interface ConnectionProfile {
	readonly id: string;
	readonly name: string;
	readonly type: DatabaseType;
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly user: string;
	readonly schema: string;
	readonly sslMode: SslMode;
	readonly color?: string;
}

export type ConnectionStatus =
	| 'disconnected'
	| 'connecting'
	| 'connected'
	| 'error';

interface ActiveConnection {
	readonly connectionId: string;
	readonly profileId: string;
	readonly database: string;
	readonly schema: string;
}

// ── Store ────────────────────────────────────────────────────────

interface ConnectionState {
	readonly profiles: readonly ConnectionProfile[];
	readonly active: ActiveConnection | null;
	readonly status: ConnectionStatus;
	readonly error: string | null;

	// Actions
	addProfile: (profile: ConnectionProfile) => void;
	updateProfile: (
		id: string,
		updates: Partial<Omit<ConnectionProfile, 'id'>>,
	) => void;
	removeProfile: (id: string) => void;
	setActive: (connection: ActiveConnection) => void;
	setStatus: (status: ConnectionStatus, error?: string) => void;
	clearActive: () => void;
}

export const useConnectionStore = create<ConnectionState>()(
	persist(
		(set) => ({
			profiles: [],
			active: null,
			status: 'disconnected',
			error: null,

			addProfile: (profile) =>
				set((state) => ({
					profiles: [...state.profiles, profile],
				})),

			updateProfile: (id, updates) =>
				set((state) => ({
					profiles: state.profiles.map((p) =>
						p.id === id ? { ...p, ...updates } : p,
					),
				})),

			removeProfile: (id) =>
				set((state) => ({
					profiles: state.profiles.filter((p) => p.id !== id),
				})),

			setActive: (connection) =>
				set({ active: connection, status: 'connected', error: null }),

			setStatus: (status, error) => set({ status, error: error ?? null }),

			clearActive: () =>
				set({ active: null, status: 'disconnected', error: null }),
		}),
		{
			name: 'dbsp-connections',
			// Only persist profiles, not runtime state
			partialize: (state) => ({ profiles: state.profiles }),
		},
	),
);
