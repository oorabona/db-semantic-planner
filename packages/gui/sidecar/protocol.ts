/**
 * JSON-RPC 2.0 protocol types and codec for sidecar communication.
 * Framing: Newline-delimited JSON (JSON Lines).
 */

// ── JSON-RPC 2.0 types ──────────────────────────────────────────

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
	readonly jsonrpc: "2.0";
	readonly id: JsonRpcId;
	readonly method: string;
	readonly params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
	readonly jsonrpc: "2.0";
	readonly id: JsonRpcId;
	readonly result: unknown;
}

export interface JsonRpcErrorResponse {
	readonly jsonrpc: "2.0";
	readonly id: JsonRpcId;
	readonly error: JsonRpcError;
}

export interface JsonRpcError {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

export interface JsonRpcNotification {
	readonly jsonrpc: "2.0";
	readonly method: string;
	readonly params?: Record<string, unknown>;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ── Error codes ──────────────────────────────────────────────────

export const ErrorCode = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603,
	// Custom codes
	NotConnected: -32000,
	EngineRestarting: -32001,
	QueryCancelled: -32002,
	QueryTimeout: -32003,
	ConnectionFailed: -32004,
} as const;

// ── BigInt-safe JSON serializer ──────────────────────────────────

/** Custom replacer: BigInt → string */
function bigintReplacer(_key: string, value: unknown): unknown {
	if (typeof value === "bigint") {
		return value.toString();
	}
	return value;
}

// ── Codec ────────────────────────────────────────────────────────

/** Serialize a JSON-RPC message to a JSON Line (with trailing \n). */
export function encode(message: JsonRpcMessage): string {
	return `${JSON.stringify(message, bigintReplacer)}\n`;
}

/** Normalize CRLF → LF and parse a JSON line into a JSON-RPC request. */
export function decode(line: string): JsonRpcRequest {
	const normalized = line.replace(/\r\n/g, "\n").trim();
	if (normalized.length === 0) {
		throw new ProtocolError(ErrorCode.ParseError, "Empty message");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(normalized);
	} catch {
		throw new ProtocolError(ErrorCode.ParseError, "Invalid JSON");
	}

	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("jsonrpc" in parsed) ||
		(parsed as { jsonrpc: unknown }).jsonrpc !== "2.0"
	) {
		throw new ProtocolError(ErrorCode.InvalidRequest, "Not a JSON-RPC 2.0 message");
	}

	const msg = parsed as Record<string, unknown>;
	if (typeof msg.method !== "string") {
		throw new ProtocolError(ErrorCode.InvalidRequest, "Missing or invalid 'method'");
	}

	return {
		jsonrpc: "2.0",
		id: (msg.id as JsonRpcId) ?? null,
		method: msg.method,
		params: (msg.params as Record<string, unknown>) ?? undefined,
	};
}

/** Create a success response. */
export function success(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
	return { jsonrpc: "2.0", id, result };
}

/** Create an error response. */
export function error(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
	return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined && { data }) } };
}

/** Create a notification (no id, no response expected). */
export function notification(method: string, params?: Record<string, unknown>): JsonRpcNotification {
	return { jsonrpc: "2.0", method, ...(params !== undefined && { params }) };
}

// ── Protocol error ───────────────────────────────────────────────

export class ProtocolError extends Error {
	constructor(
		public readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "ProtocolError";
	}
}
