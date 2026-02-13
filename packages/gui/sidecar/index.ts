/**
 * Sidecar entry point — JSON-RPC over stdin/stdout.
 *
 * CRITICAL: console.log/warn/info/debug are monkey-patched to stderr
 * immediately on startup to prevent protocol corruption.
 */
import { createInterface } from 'node:readline';
import {
	connect,
	disconnect,
	disconnectAll,
	introspectConnection,
} from './connection-manager.js';
import {
	decode,
	ErrorCode,
	encode,
	error,
	type JsonRpcResponse,
	notification,
} from './protocol.js';
import { Router } from './router.js';

// ── Step 1: Monkey-patch console to stderr (MUST be first) ───────

const stderrWrite = (data: string) => process.stderr.write(`${data}\n`);
console.log = (...args: unknown[]) => stderrWrite(args.map(String).join(' '));
console.warn = (...args: unknown[]) =>
	stderrWrite(`[WARN] ${args.map(String).join(' ')}`);
console.info = (...args: unknown[]) =>
	stderrWrite(`[INFO] ${args.map(String).join(' ')}`);
console.debug = (...args: unknown[]) =>
	stderrWrite(`[DEBUG] ${args.map(String).join(' ')}`);
console.error = (...args: unknown[]) =>
	stderrWrite(`[ERROR] ${args.map(String).join(' ')}`);

// ── Step 2: Initialize router ────────────────────────────────────

const router = new Router();

// ── Step 2b: Wire connection handlers ─────────────────────────────

router.setHandler('connect', async (params) => {
	const p = params as {
		host: string;
		port: number;
		database: string;
		user: string;
		password: string;
		schema?: string;
		sslMode?: 'disable' | 'allow' | 'prefer' | 'require' | 'verify-full';
	};
	return connect(p);
});

router.setHandler('disconnect', async (params) => {
	const { connectionId } = params as { connectionId: string };
	await disconnect(connectionId);
	return { ok: true };
});

router.setHandler('introspect', async (params) => {
	const { connectionId, schema } = params as {
		connectionId: string;
		schema?: string;
	};
	const model = await introspectConnection(connectionId, schema);

	// Convert ReadonlyMap to plain arrays for JSON serialization
	const tables = [...model.tables.values()].map((t) => ({
		...t,
		foreignKeys: [...t.foreignKeys],
		indexes: [...t.indexes],
		columns: [...t.columns],
	}));
	const relations = [...model.relations.values()];

	return {
		tables,
		relations,
		hierarchies: [...model.hierarchies],
		warnings: [...model.warnings],
		introspectedAt: model.introspectedAt.toISOString(),
	};
});

// ── Step 3: Write to stdout (protocol output) ────────────────────

function send(
	message: JsonRpcResponse | ReturnType<typeof notification>,
): void {
	process.stdout.write(encode(message));
}

// ── Step 4: Heartbeat ────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 3000;
const heartbeatTimer = setInterval(() => {
	send(notification('heartbeat'));
}, HEARTBEAT_INTERVAL_MS);

// Keep the event loop alive but allow clean shutdown
heartbeatTimer.unref();

// ── Step 5: Read stdin line by line ──────────────────────────────

const rl = createInterface({
	input: process.stdin,
	crlfDelay: Number.POSITIVE_INFINITY, // Treat \r\n as single newline
});

rl.on('line', async (line: string) => {
	// Skip empty lines
	if (line.trim().length === 0) return;

	let response: JsonRpcResponse;
	try {
		const request = decode(line);
		response = await router.dispatch(request);
	} catch (err) {
		// Protocol-level parse error
		const message = err instanceof Error ? err.message : 'Unknown parse error';
		const code =
			'code' in (err as object)
				? (err as { code: number }).code
				: ErrorCode.ParseError;
		response = error(null, code, message);
	}

	send(response);
});

// ── Step 6: Graceful shutdown ────────────────────────────────────

rl.on('close', async () => {
	clearInterval(heartbeatTimer);
	await disconnectAll();
	console.log('Sidecar: stdin closed, shutting down');
	process.exit(0);
});

process.on('SIGTERM', async () => {
	clearInterval(heartbeatTimer);
	await disconnectAll();
	console.log('Sidecar: SIGTERM received, shutting down');
	process.exit(0);
});

// ── Ready ────────────────────────────────────────────────────────

console.log('Sidecar: ready, waiting for JSON-RPC messages on stdin');
