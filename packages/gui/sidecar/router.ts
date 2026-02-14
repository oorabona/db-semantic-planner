/**
 * JSON-RPC method router with Valibot parameter validation.
 */
import * as v from 'valibot';
import {
	ErrorCode,
	error,
	type JsonRpcId,
	type JsonRpcRequest,
	type JsonRpcResponse,
	ProtocolError,
	success,
} from './protocol.js';

// ── Types ────────────────────────────────────────────────────────

export type MethodHandler<P = unknown, R = unknown> = (
	params: P,
	requestId: JsonRpcId,
) => R | Promise<R>;

interface MethodRegistration {
	readonly schema: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>> | null;
	readonly handler: MethodHandler;
}

// ── Valibot schemas for method params ────────────────────────────

const HandshakeParams = v.object({
	version: v.string(),
});

const ConnectParams = v.object({
	host: v.string(),
	port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
	database: v.string(),
	user: v.string(),
	password: v.string(),
	schema: v.optional(v.string()),
	sslMode: v.optional(
		v.picklist(['disable', 'allow', 'prefer', 'require', 'verify-full']),
	),
});

const DisconnectParams = v.object({
	connectionId: v.string(),
});

const IntrospectParams = v.object({
	connectionId: v.string(),
	schema: v.optional(v.string()),
	exclude: v.optional(v.string()),
	include: v.optional(v.string()),
});

const ExecuteSqlParams = v.object({
	connectionId: v.string(),
	sql: v.string(),
	params: v.optional(v.array(v.unknown())),
	maxRows: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
	timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

const CompileNqlParams = v.object({
	connectionId: v.string(),
	nql: v.string(),
});

const ExecuteNqlParams = v.object({
	connectionId: v.string(),
	nql: v.string(),
	maxRows: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
	timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

const FetchMoreParams = v.object({
	cursorId: v.string(),
	maxRows: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

const CancelParams = v.object({
	requestId: v.union([v.string(), v.number()]),
});

const ResolveProfileParams = v.object({
	uri: v.string(),
	projectPath: v.optional(v.string()),
});

const GetCompletionsParams = v.object({
	text: v.string(),
	position: v.number(),
	language: v.picklist(['sql', 'nql']),
	connectionId: v.string(),
});

const RunAssertionsParams = v.object({
	connectionId: v.string(),
	dbspContent: v.string(),
	assertContent: v.string(),
	execute: v.optional(v.boolean()),
});

const SchemaDiffParams = v.object({
	connectionId: v.string(),
	schemaPath: v.optional(v.string()),
});

const ListDatabasesParams = v.object({
	host: v.string(),
	port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
	user: v.string(),
	password: v.string(),
	sslMode: v.optional(
		v.picklist(['disable', 'allow', 'prefer', 'require', 'verify-full']),
	),
});

const ListSchemasParams = v.object({
	host: v.string(),
	port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
	user: v.string(),
	password: v.string(),
	sslMode: v.optional(
		v.picklist(['disable', 'allow', 'prefer', 'require', 'verify-full']),
	),
	database: v.string(),
});

// ── Router ───────────────────────────────────────────────────────

export class Router {
	private readonly methods = new Map<string, MethodRegistration>();

	constructor() {
		// Register all methods with their schemas (handlers are stubs until wired)
		this.registerSchemas();
	}

	private registerSchemas(): void {
		// handshake — always available
		this.register('handshake', HandshakeParams, (params) => {
			const { version } = params as { version: string };
			return {
				version,
				capabilities: ['sql', 'nql', 'introspect', 'cancel'],
			};
		});

		// Stubs for methods wired in later blocks
		this.registerStub('connect', ConnectParams);
		this.registerStub('disconnect', DisconnectParams);
		this.registerStub('introspect', IntrospectParams);
		this.registerStub('executeSQL', ExecuteSqlParams);
		this.registerStub('compileNQL', CompileNqlParams);
		this.registerStub('executeNQL', ExecuteNqlParams);
		this.registerStub('fetchMore', FetchMoreParams);
		this.registerStub('cancel', CancelParams);
		this.registerStub('getCompletions', GetCompletionsParams);
		this.registerStub('resolveProfile', ResolveProfileParams);
		this.registerStub('runAssertions', RunAssertionsParams);
		this.registerStub('schemaDiff', SchemaDiffParams);
		this.registerStub('listDatabases', ListDatabasesParams);
		this.registerStub('listSchemas', ListSchemasParams);
	}

	/** Register a method with validation schema and handler. */
	register<P, R>(
		method: string,
		schema: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>> | null,
		handler: MethodHandler<P, R>,
	): void {
		this.methods.set(method, {
			schema,
			handler: handler as MethodHandler,
		});
	}

	/** Register a stub that returns "Not connected" error. */
	private registerStub(
		method: string,
		schema: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
	): void {
		this.methods.set(method, {
			schema,
			handler: () => {
				throw new ProtocolError(
					ErrorCode.NotConnected,
					'Not connected to a database',
				);
			},
		});
	}

	/** Replace a stub handler with a real implementation. */
	setHandler<P, R>(method: string, handler: MethodHandler<P, R>): void {
		const existing = this.methods.get(method);
		if (!existing) {
			throw new Error(`Method '${method}' is not registered`);
		}
		this.methods.set(method, {
			schema: existing.schema,
			handler: handler as MethodHandler,
		});
	}

	/** Dispatch a JSON-RPC request and return a response. */
	async dispatch(request: JsonRpcRequest): Promise<JsonRpcResponse> {
		const registration = this.methods.get(request.method);
		if (!registration) {
			return error(
				request.id,
				ErrorCode.MethodNotFound,
				`Method '${request.method}' not found`,
			);
		}

		// Validate params
		if (registration.schema) {
			const result = v.safeParse(registration.schema, request.params ?? {});
			if (!result.success) {
				const issues = result.issues.map((i) => i.message).join('; ');
				return error(
					request.id,
					ErrorCode.InvalidParams,
					`Invalid params: ${issues}`,
				);
			}
		}

		try {
			const result = await registration.handler(
				request.params ?? {},
				request.id,
			);
			return success(request.id, result);
		} catch (err) {
			if (err instanceof ProtocolError) {
				return error(request.id, err.code, err.message);
			}
			const message = err instanceof Error ? err.message : 'Unknown error';
			return error(request.id, ErrorCode.InternalError, message);
		}
	}
}
