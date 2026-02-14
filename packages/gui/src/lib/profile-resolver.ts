/**
 * Profile URI resolver — dispatches file://, env://, store:// schemes.
 *
 * - file:// and env:// → delegated to sidecar (Node.js has fs + env access)
 * - store:// → resolved in frontend via Tauri plugin-store (plaintext JSON, NOT keychain)
 */
import { load } from '@tauri-apps/plugin-store';
import type { ConnectParams } from './ipc';
import { sidecarApi } from './ipc';

// ── URI Parsing ──────────────────────────────────────────────────

export type ProfileScheme = 'file' | 'env' | 'store';

export interface ParsedProfileUri {
	readonly scheme: ProfileScheme;
	readonly value: string;
}

const URI_RE = /^(file|env|store):\/\/(.+)$/;

export function parseProfileUri(uri: string): ParsedProfileUri {
	const match = URI_RE.exec(uri);
	if (!match) {
		throw new ProfileResolutionError(
			uri,
			`Invalid profile URI. Must use file://, env://, or store:// scheme.`,
		);
	}
	return { scheme: match[1] as ProfileScheme, value: match[2] ?? '' };
}

// ── Resolution ───────────────────────────────────────────────────

/**
 * Resolve a profile URI to connection parameters.
 *
 * - `file://.env.local` → sidecar reads .env file, extracts DATABASE_URL
 * - `env://DATABASE_URL` → sidecar reads process.env
 * - `store://dev-local` → frontend reads Tauri secure store key `profile:dev-local`
 */
export async function resolveProfile(
	uri: string,
	projectPath?: string,
): Promise<ConnectParams> {
	const { scheme, value } = parseProfileUri(uri);

	switch (scheme) {
		case 'file':
		case 'env':
			return sidecarApi.resolveProfile({ uri, projectPath });

		case 'store':
			return resolveStoreProfile(value);
	}
}

/**
 * Read connection params from Tauri store.
 *
 * **Security note (GUI-MW-D01):**
 * `@tauri-apps/plugin-store` persists data as **plaintext JSON** in the OS
 * app-data directory (e.g. `~/.local/share/com.dbsp.gui/credentials.json`).
 * It does NOT use the OS keychain (macOS Keychain / Windows Credential Manager
 * / Linux Secret Service). Passwords stored via `store://` are readable by any
 * process running as the same OS user.
 *
 * Acceptable for local-dev desktop use. For production credentials, prefer
 * `env://` (reads process env, no disk persistence) or `file://` pointing to
 * a file with restricted permissions.
 *
 * Future: migrate to `tauri-plugin-stronghold` (IOTA Stronghold — encrypted
 * vault with runtime-only decryption) when available and stable for v2.
 */
async function resolveStoreProfile(key: string): Promise<ConnectParams> {
	const store = await load('credentials.json');
	const data = await store.get<ConnectParams>(`profile:${key}`);
	if (!data) {
		throw new ProfileResolutionError(
			`store://${key}`,
			`No stored profile found for key "profile:${key}"`,
		);
	}
	return data;
}

// ── Error ────────────────────────────────────────────────────────

export class ProfileResolutionError extends Error {
	constructor(
		public readonly uri: string,
		public readonly reason: string,
	) {
		super(`Failed to resolve profile "${uri}": ${reason}`);
		this.name = 'ProfileResolutionError';
	}
}
