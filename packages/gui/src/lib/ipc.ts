/**
 * Typed JSON-RPC method wrappers for the sidecar.
 * Uses IpcClient from ipc-transport.ts.
 */
import { useLogStore } from '@/stores/log-store';
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

export interface RunAssertionsParams {
	connectionId: string;
	dbspContent: string;
	assertContent: string;
	execute?: boolean;
}

export interface AssertionOutcome {
	readonly type: string;
	readonly expected: unknown;
	readonly actual: unknown;
	readonly passed: boolean;
	readonly message: string | undefined;
	readonly skipped?: boolean;
	readonly skipReason?: string;
}

export interface QueryAssertionResult {
	readonly queryIndex: number;
	readonly query: string;
	readonly querySuccess: boolean;
	readonly assertions: readonly AssertionOutcome[];
	readonly passed: boolean;
}

export interface RunAssertionsSummary {
	readonly total: number;
	readonly passed: number;
	readonly failed: number;
	readonly skipped: number;
	readonly results: readonly QueryAssertionResult[];
}

export interface RunAssertionsQueryResult {
	readonly query: string;
	readonly success: boolean;
	readonly dbSuccess?: boolean;
	readonly sql?: string;
	readonly error?: string;
	readonly rowCount?: number;
}

export interface RunAssertionsResult {
	readonly summary: RunAssertionsSummary;
	readonly queryResults: readonly RunAssertionsQueryResult[];
	readonly parseErrors: ReadonlyArray<{ line: number; message: string }>;
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

export interface SchemaDiffChange {
	readonly kind: string;
	readonly table: string;
	readonly column?: string;
	readonly destructive: boolean;
	readonly details: string;
	readonly meta?: Readonly<Record<string, unknown>>;
}

export interface DiffSummary {
	readonly tables: { readonly added: number; readonly dropped: number };
	readonly columns: {
		readonly added: number;
		readonly dropped: number;
		readonly altered: number;
	};
	readonly indexes: { readonly added: number; readonly dropped: number };
	readonly constraints: {
		readonly added: number;
		readonly dropped: number;
		readonly altered: number;
	};
}

export interface SchemaDiffResult {
	readonly changes: readonly SchemaDiffChange[];
	readonly hasDestructive: boolean;
	readonly summary: DiffSummary;
	readonly upSQL: readonly string[];
	readonly downSQL: readonly string[];
	readonly warnings: readonly SchemaDiffComparisonWarning[];
}

/** Fields shared by all JSON-safe expression comparison warnings. */
interface SchemaDiffComparisonWarningBase {
	readonly table: string;
	readonly name: string;
	readonly message: string;
}

/** A JSON-safe expression surface compared as raw text. */
export type SchemaDiffRawComparisonWarning = SchemaDiffComparisonWarningBase & {
	readonly kind: 'check_constraint' | 'column_default' | 'index_predicate';
	readonly outcome?: 'unavailable' | 'rejected' | 'refused';
	readonly comparison: 'raw';
};

/** A column default with no opposite-model counterpart to compare. */
export type SchemaDiffUnpairedColumnDefaultWarning =
	SchemaDiffComparisonWarningBase & {
		readonly kind: 'column_default';
		readonly outcome?: 'unavailable' | 'rejected' | 'refused';
		readonly comparison: 'unpaired';
		readonly side?: 'desired' | 'database';
	};

/** A JSON-safe expression fallback or unpaired column default. */
export type SchemaDiffComparisonWarning =
	| SchemaDiffRawComparisonWarning
	| SchemaDiffUnpairedColumnDefaultWarning;

export interface SchemaApplyParams {
	connectionId: string;
	statements: readonly string[];
}

export interface SchemaApplyResult {
	readonly applied: number;
	readonly success: boolean;
	readonly error?: string;
}

export interface SchemaReloadResult {
	readonly tableNames: readonly string[];
	readonly tableCount: number;
	readonly relationCount: number;
	readonly schemaPath: string;
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

		runAssertions(params: RunAssertionsParams) {
			return client.call<RunAssertionsResult>('runAssertions', params);
		},

		listDatabases(params: DiscoverParams) {
			return client.call<{ databases: string[] }>('listDatabases', params);
		},

		listSchemas(params: ListSchemasParams) {
			return client.call<{ schemas: string[] }>('listSchemas', params);
		},

		schemaDiff(connectionId: string, schemaPath?: string) {
			return client.call<SchemaDiffResult>('schemaDiff', {
				connectionId,
				schemaPath,
			});
		},

		schemaApply(connectionId: string, statements: readonly string[]) {
			return client.call<SchemaApplyResult>('schemaApply', {
				connectionId,
				statements,
			});
		},

		schemaReload(folderPath: string) {
			return client.call<SchemaReloadResult>('schemaReload', {
				folderPath,
			});
		},
	};
}

export type SidecarApi = ReturnType<typeof createSidecarApi>;

// ── Singleton instance ──────────────────────────────────────────

export const ipcClient = new IpcClient();
export const sidecarApi = createSidecarApi(ipcClient);

// ── IPC logging → application log store ─────────────────────────

ipcClient.setLogger((type, method, durationMs, error) => {
	const { addEntry } = useLogStore.getState();
	switch (type) {
		case 'request':
			addEntry('debug', 'ipc', `→ ${method}`);
			break;
		case 'response':
			addEntry('info', 'ipc', `← ${method}`, durationMs);
			break;
		case 'error':
			addEntry(
				'error',
				'ipc',
				`← ${method} ERROR: ${error?.message ?? 'unknown'}`,
				durationMs,
			);
			break;
	}
});
