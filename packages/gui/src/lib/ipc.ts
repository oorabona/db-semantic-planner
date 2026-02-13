/**
 * Typed JSON-RPC method wrappers for the sidecar.
 * Uses IpcClient from ipc-transport.ts.
 */
import type { IpcClient } from "./ipc-transport";

// ── Sidecar method types ─────────────────────────────────────────

export type SslMode = "disable" | "allow" | "prefer" | "require" | "verify-full";

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
	ok: boolean;
	connectionId: string;
	tables: number;
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

// ── Typed API ────────────────────────────────────────────────────

export function createSidecarApi(client: IpcClient) {
	return {
		handshake(version: string) {
			return client.call<{ version: string; capabilities: string[] }>("handshake", { version });
		},

		connect(params: ConnectParams) {
			return client.call<ConnectResult>("connect", params as unknown as Record<string, unknown>);
		},

		disconnect(connectionId: string) {
			return client.call<{ ok: boolean }>("disconnect", { connectionId });
		},

		introspect(connectionId: string, schema?: string) {
			return client.call<unknown>("introspect", { connectionId, schema });
		},

		executeSQL(params: ExecuteSqlParams) {
			return client.call<QueryResult>("executeSQL", params as unknown as Record<string, unknown>);
		},

		compileNQL(params: CompileNqlParams) {
			return client.call<CompileNqlResult>("compileNQL", params as unknown as Record<string, unknown>);
		},

		executeNQL(params: ExecuteNqlParams) {
			return client.call<ExecuteNqlResult>("executeNQL", params as unknown as Record<string, unknown>);
		},

		fetchMore(params: FetchMoreParams) {
			return client.call<QueryResult>("fetchMore", params as unknown as Record<string, unknown>);
		},

		cancel(requestId: string | number) {
			return client.call<{ ok: boolean }>("cancel", { requestId });
		},

		getCompletions(connectionId: string, text: string, position: number, language: "sql" | "nql") {
			return client.call<{ items: CompletionItem[] }>("getCompletions", {
				connectionId,
				text,
				position,
				language,
			});
		},
	};
}

export type SidecarApi = ReturnType<typeof createSidecarApi>;
