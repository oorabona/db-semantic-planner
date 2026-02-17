/**
 * Zustand store for connection profiles — SQLite-backed via project-db.
 *
 * Profiles are persisted in data.sqlite/connection_profiles with a
 * generic `type + config (JSON blob)` schema. Active connection state
 * is in-memory only (not persisted).
 */
import { create } from 'zustand';
import type { ConnectionProfileRow } from '@/lib/project-db';
import {
	deleteConnectionProfile,
	listConnectionProfiles,
	touchConnectionProfile,
	upsertConnectionProfile,
} from '@/lib/project-db';

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
	/** Engine-specific connection params (host, port, etc.) as JSON blob. */
	readonly config: Record<string, unknown>;
	/** Environment label: dev, staging, prod, or custom string. */
	readonly environment: string | null;
	readonly color?: string;
	readonly createdAt: number;
	readonly lastUsedAt: number | null;
}

/** PostgreSQL-specific connection config fields. */
export interface PostgresConfig {
	host: string;
	port: number;
	database: string;
	user: string;
	schema: string;
	sslMode: SslMode;
}

/** Extract PostgreSQL-specific config from a profile's config blob. */
export function pgConfig(profile: ConnectionProfile): PostgresConfig {
	const c = profile.config;
	return {
		host: (c.host as string) ?? 'localhost',
		port: (c.port as number) ?? 5432,
		database: (c.database as string) ?? '',
		user: (c.user as string) ?? 'postgres',
		schema: (c.schema as string) ?? 'public',
		sslMode: (c.sslMode as SslMode) ?? 'prefer',
	};
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
	/** Original connect params — used to pre-populate wizard when no saved profile. */
	readonly connectParams?: {
		readonly host: string;
		readonly port: number;
		readonly user: string;
		readonly sslMode: SslMode;
	};
}

// ── Row ↔ Profile converters ─────────────────────────────────────

function rowToProfile(row: ConnectionProfileRow): ConnectionProfile {
	return {
		id: row.id,
		name: row.name,
		type: row.type as DatabaseType,
		config: JSON.parse(row.config),
		environment: row.environment,
		...(row.color != null ? { color: row.color } : {}),
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
	};
}

function profileToRow(profile: ConnectionProfile): ConnectionProfileRow {
	return {
		id: profile.id,
		name: profile.name,
		type: profile.type,
		config: JSON.stringify(profile.config),
		environment: profile.environment,
		color: profile.color ?? null,
		created_at: profile.createdAt,
		last_used_at: profile.lastUsedAt,
	};
}

// ── Store ────────────────────────────────────────────────────────

interface ConnectionState {
	readonly profiles: readonly ConnectionProfile[];
	readonly active: ActiveConnection | null;
	readonly status: ConnectionStatus;
	readonly error: string | null;

	/** Load profiles from project-db. */
	loadProfiles: () => Promise<void>;
	/** Migrate legacy localStorage profiles to SQLite (one-time). */
	migrateFromLocalStorage: () => Promise<void>;

	// CRUD — optimistic in-memory + fire-and-forget SQLite write
	addProfile: (profile: ConnectionProfile) => void;
	updateProfile: (
		id: string,
		updates: Partial<Omit<ConnectionProfile, 'id'>>,
	) => void;
	removeProfile: (id: string) => void;
	touchProfile: (id: string) => void;

	// Runtime — in-memory only
	setActive: (connection: ActiveConnection) => void;
	setStatus: (status: ConnectionStatus, error?: string) => void;
	clearActive: () => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
	profiles: [],
	active: null,
	status: 'disconnected',
	error: null,

	loadProfiles: async () => {
		const rows = await listConnectionProfiles();
		set({ profiles: rows.map(rowToProfile) });
	},

	migrateFromLocalStorage: async () => {
		const raw = localStorage.getItem('dbsp-connections');
		if (!raw) return;

		try {
			const stored = JSON.parse(raw);
			const oldProfiles: Array<Record<string, unknown>> =
				stored?.state?.profiles ?? [];
			if (oldProfiles.length === 0) return;

			for (const old of oldProfiles) {
				const profile: ConnectionProfile = {
					id: (old.id as string) ?? crypto.randomUUID(),
					name: (old.name as string) ?? 'Migrated',
					type: ((old.type as string) ?? 'postgresql') as DatabaseType,
					config: {
						host: old.host ?? 'localhost',
						port: old.port ?? 5432,
						database: old.database ?? '',
						user: old.user ?? 'postgres',
						schema: old.schema ?? 'public',
						sslMode: old.sslMode ?? 'prefer',
					},
					environment: null,
					createdAt: Date.now(),
					lastUsedAt: null,
				};
				await upsertConnectionProfile(profileToRow(profile));
			}

			// Clear localStorage after successful migration
			localStorage.removeItem('dbsp-connections');

			// Reload from DB
			await get().loadProfiles();
		} catch {
			console.error('[connection-store] Migration from localStorage failed');
		}
	},

	addProfile: (profile) => {
		set((state) => ({ profiles: [...state.profiles, profile] }));
		upsertConnectionProfile(profileToRow(profile)).catch((err: unknown) =>
			console.error('[connection-store] Failed to persist profile:', err),
		);
	},

	updateProfile: (id, updates) => {
		set((state) => ({
			profiles: state.profiles.map((p) =>
				p.id === id ? { ...p, ...updates } : p,
			),
		}));
		const updated = get().profiles.find((p) => p.id === id);
		if (updated) {
			upsertConnectionProfile(profileToRow(updated)).catch((err: unknown) =>
				console.error('[connection-store] Failed to update profile:', err),
			);
		}
	},

	removeProfile: (id) => {
		set((state) => ({
			profiles: state.profiles.filter((p) => p.id !== id),
		}));
		deleteConnectionProfile(id).catch((err: unknown) =>
			console.error('[connection-store] Failed to delete profile:', err),
		);
	},

	touchProfile: (id) => {
		const now = Date.now();
		set((state) => ({
			profiles: state.profiles.map((p) =>
				p.id === id ? { ...p, lastUsedAt: now } : p,
			),
		}));
		touchConnectionProfile(id).catch((err: unknown) =>
			console.error('[connection-store] Failed to touch profile:', err),
		);
	},

	setActive: (connection) =>
		set({ active: connection, status: 'connected', error: null }),

	setStatus: (status, error) => set({ status, error: error ?? null }),

	clearActive: () => set({ active: null, status: 'disconnected', error: null }),
}));
