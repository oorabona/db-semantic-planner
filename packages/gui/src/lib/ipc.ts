/**
 * Typed JSON-RPC method wrappers for the sidecar.
 * Uses IpcClient from ipc-transport.ts.
 */
import { IpcClient } from './ipc-transport.js';

// ── Sidecar method types ─────────────────────────────────────────

export type SslMode =
	| 'disable'
	| 'allow'
	| 'prefer'
	| 'require'
	| 'verify-full';

export interface ConnectParams {
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	schema?: string;
	sslMode?: SslMode;
}

export interface ConnectResult {
	connectionId: string;
	database: string;
	schema: string;
}

export interface ExecuteSqlParams {
	connectionId: string;
	sql: string;
	params?: unknown[];
	maxRows?: number;
	timeoutMs?: number;
}

export interface QueryResult {
	rows: unknown[][];
	columns: Array<{ name: string; type: string }>;
	rowCount: number;
	timeMs: number;
	truncated: boolean;
	cursorId?: string;
}

export interface CompileNqlParams {
	connectionId: string;
	nql: string;
}

export interface CompileNqlResult {
	sql: string;
	params: unknown[];
	plan?: unknown;
	warnings: Array<{ code: string; message: string }>;
}

export interface ExecuteNqlParams {
	connectionId: string;
	nql: string;
	maxRows?: number;
	timeoutMs?: number;
}

export interface ExecuteNqlResult extends QueryResult {
	plan: unknown;
}

export interface FetchMoreParams {
	cursorId: string;
	maxRows?: number;
}

export interface CompletionItem {
	label: string;
	kind: string;
	detail?: string;
	insertText?: string;
}

export interface ResolveProfileParams {
	uri: string;
	projectPath?: string;
}

export interface DiscoverParams {
	host: string;
	port: number;
	user: string;
	password: string;
	sslMode?: SslMode;
}

export interface ListSchemasParams extends DiscoverParams {
	database: string;
}

// ── Typed API ────────────────────────────────────────────────────

export function createSidecarApi(client: IpcClient) {
	return {
		handshake(version: string) {
			return client.call<{ version: string; capabilities: string[] }>(
				'handshake',
				{ version },
			);
		},

		connect(params: ConnectParams) {
			return client.call<ConnectResult>('connect', params);
		},

		disconnect(params: { connectionId: string }) {
			return client.call<{ ok: boolean }>('disconnect', params);
		},

		introspect(connectionId: string, schema?: string) {
			return client.call<unknown>('introspect', { connectionId, schema });
		},

		executeSQL(params: ExecuteSqlParams) {
			return client.call<QueryResult>('executeSQL', params);
		},

		compileNQL(params: CompileNqlParams) {
			return client.call<CompileNqlResult>('compileNQL', params);
		},

		executeNQL(params: ExecuteNqlParams) {
			return client.call<ExecuteNqlResult>('executeNQL', params);
		},

		fetchMore(params: FetchMoreParams) {
			return client.call<QueryResult>('fetchMore', params);
		},

		cancel(requestId: string | number) {
			return client.call<{ ok: boolean }>('cancel', { requestId });
		},

		getCompletions(
			connectionId: string,
			text: string,
			position: number,
			language: 'sql' | 'nql',
		) {
			return client.call<{ items: CompletionItem[] }>('getCompletions', {
				connectionId,
				text,
				position,
				language,
			});
		},

		resolveProfile(params: ResolveProfileParams) {
			return client.call<ConnectParams>('resolveProfile', params);
		},

		listDatabases(params: DiscoverParams) {
			return client.call<{ databases: string[] }>('listDatabases', params);
		},

		listSchemas(params: ListSchemasParams) {
			return client.call<{ schemas: string[] }>('listSchemas', params);
		},
	};
}

export type SidecarApi = ReturnType<typeof createSidecarApi>;

// ── Singleton instance ──────────────────────────────────────────

export const ipcClient = new IpcClient();
export const sidecarApi = createSidecarApi(ipcClient);
