import { useCallback, useState } from 'react';
import { sidecarApi } from '@/lib/ipc';
import {
	type ConnectionProfile,
	pgConfig,
	type SslMode,
	useConnectionStore,
} from '@/stores/connection-store';

interface ConnectParams {
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	schema?: string;
	sslMode?: SslMode;
}

export function useConnection() {
	const { setActive, setStatus, clearActive, addProfile, removeProfile } =
		useConnectionStore();
	const [testResult, setTestResult] = useState<{
		ok: boolean;
		message: string;
	} | null>(null);

	const connect = useCallback(
		async (params: ConnectParams, profileId?: string) => {
			setStatus('connecting');
			setTestResult(null);
			try {
				const result = await sidecarApi.connect(params);
				setActive({
					connectionId: result.connectionId,
					profileId: profileId ?? '',
					database: result.database,
					schema: result.schema,
				});
				return result;
			} catch (err) {
				const message =
					err instanceof Error ? err.message : 'Connection failed';
				setStatus('error', message);
				throw err;
			}
		},
		[setActive, setStatus],
	);

	const disconnect = useCallback(async () => {
		const active = useConnectionStore.getState().active;
		if (active) {
			try {
				await sidecarApi.disconnect({ connectionId: active.connectionId });
			} catch {
				// Ignore disconnect errors (sidecar may be down)
			}
		}
		clearActive();
	}, [clearActive]);

	const testConnection = useCallback(async (params: ConnectParams) => {
		setTestResult(null);
		try {
			const result = await sidecarApi.connect(params);
			// Immediately disconnect the test connection
			await sidecarApi.disconnect({
				connectionId: result.connectionId,
			});
			setTestResult({ ok: true, message: 'Connection successful!' });
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Connection failed';
			setTestResult({ ok: false, message });
		}
	}, []);

	const saveProfile = useCallback(
		(profile: ConnectionProfile) => {
			addProfile(profile);
		},
		[addProfile],
	);

	const deleteProfile = useCallback(
		(id: string) => {
			removeProfile(id);
		},
		[removeProfile],
	);

	const connectFromProfile = useCallback(
		async (profile: ConnectionProfile, password: string) => {
			const pg = pgConfig(profile);
			return connect(
				{
					host: pg.host,
					port: pg.port,
					database: pg.database,
					user: pg.user,
					password,
					schema: pg.schema,
					sslMode: pg.sslMode,
				},
				profile.id,
			);
		},
		[connect],
	);

	return {
		connect,
		disconnect,
		testConnection,
		testResult,
		saveProfile,
		deleteProfile,
		connectFromProfile,
	};
}
