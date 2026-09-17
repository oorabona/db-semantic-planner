import { randomUUID } from 'node:crypto';
import type { IntrospectedModelIR } from '@dbsp/adapter-pgsql';
import { introspect } from '@dbsp/adapter-pgsql';
import { Pool } from 'pg';

export type SslMode =
	| 'disable'
	| 'allow'
	| 'prefer'
	| 'require'
	| 'verify-full';

export type ConnectionTransport = 'tls' | 'plaintext' | 'fallback-plaintext';

export interface ConnectParams {
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	sslMode?: SslMode;
	schema?: string;
}

interface ManagedConnection {
	pool: Pool;
	transport: ConnectionTransport;
	schema: string;
	database: string;
	host: string;
	port: number;
	user: string;
}

const connections = new Map<string, ManagedConnection>();

const SERVER_DOES_NOT_SUPPORT_SSL_ERROR =
	'The server does not support SSL connections';

function isServerWithoutSsl(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'message' in error &&
		error.message === SERVER_DOES_NOT_SUPPORT_SSL_ERROR
	);
}

function assertSupportedSslMode(mode: SslMode): void {
	if (mode === 'allow') {
		throw new Error(
			'sslmode "allow" is not supported. Choose disable, prefer, require, or verify-full.',
		);
	}
}

function sslConfig(mode: SslMode): boolean | { rejectUnauthorized: boolean } {
	switch (mode) {
		case 'disable':
			return false;
		case 'prefer':
			return { rejectUnauthorized: false };
		case 'require':
			// `require` deliberately encrypts while allowing self-signed development
			// certificates; `verify-full` is the mode that verifies the certificate.
			return { rejectUnauthorized: false };
		case 'verify-full':
			return { rejectUnauthorized: true };
		case 'allow':
			throw new Error('sslmode "allow" is not supported');
	}
}

interface PoolOpenParams {
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	sslMode?: SslMode;
	max: number;
	options?: string;
}

function buildPool(
	params: PoolOpenParams,
	ssl: ReturnType<typeof sslConfig>,
): Pool {
	return new Pool({
		host: params.host,
		port: params.port,
		database: params.database,
		user: params.user,
		password: params.password,
		ssl,
		max: params.max,
		connectionTimeoutMillis: 10_000,
		...(params.options === undefined ? {} : { options: params.options }),
	});
}

async function establishPool(pool: Pool): Promise<void> {
	const client = await pool.connect();
	client.release();
}

async function endAfterFailedConnection(pool: Pool): Promise<void> {
	try {
		await pool.end();
	} catch {
		// Preserve the connection error that prompted cleanup.
	}
}

async function openPool(
	params: PoolOpenParams,
): Promise<{ pool: Pool; transport: ConnectionTransport }> {
	const mode = params.sslMode ?? 'prefer';
	assertSupportedSslMode(mode);

	const pool = buildPool(params, sslConfig(mode));
	try {
		await establishPool(pool);
		return {
			pool,
			transport: mode === 'disable' ? 'plaintext' : 'tls',
		};
	} catch (error) {
		if (mode === 'prefer' && isServerWithoutSsl(error)) {
			await endAfterFailedConnection(pool);
			const plaintextPool = buildPool(params, false);
			try {
				await establishPool(plaintextPool);
				return { pool: plaintextPool, transport: 'fallback-plaintext' };
			} catch (fallbackError) {
				await endAfterFailedConnection(plaintextPool);
				throw fallbackError;
			}
		}

		await endAfterFailedConnection(pool);
		throw error;
	}
}

export async function connect(params: ConnectParams): Promise<{
	connectionId: string;
	database: string;
	schema: string;
	transport: ConnectionTransport;
}> {
	const schema = params.schema ?? 'public';
	const { pool, transport } = await openPool({
		...params,
		max: 5,
		// Set search_path at connection level so all clients in the pool use it
		...(schema === 'public'
			? {}
			: { options: `-c search_path="${schema}",public` }),
	});

	try {
		// Test the connection after the helper has established its transport.
		const client = await pool.connect();
		try {
			await client.query('SELECT 1');
		} finally {
			client.release();
		}
	} catch (error) {
		await endAfterFailedConnection(pool);
		throw error;
	}

	const connectionId = randomUUID();
	connections.set(connectionId, {
		pool,
		transport,
		schema,
		database: params.database,
		host: params.host,
		port: params.port,
		user: params.user,
	});

	return { connectionId, database: params.database, schema, transport };
}

export async function disconnect(connectionId: string): Promise<void> {
	const conn = connections.get(connectionId);
	if (!conn) return;
	await conn.pool.end();
	connections.delete(connectionId);
}

export async function introspectConnection(
	connectionId: string,
	schema?: string,
): Promise<IntrospectedModelIR> {
	const conn = connections.get(connectionId);
	if (!conn) throw new Error('Not connected');
	return introspect(conn.pool, { schema: schema ?? conn.schema });
}

export function getPool(connectionId: string): Pool {
	const conn = connections.get(connectionId);
	if (!conn) throw new Error('Not connected');
	return conn.pool;
}

export function getConnectionInfo(connectionId: string): {
	database: string;
	host: string;
	port: number;
	user: string;
	schema: string;
	transport: ConnectionTransport;
} | null {
	const conn = connections.get(connectionId);
	if (!conn) return null;
	return {
		database: conn.database,
		host: conn.host,
		port: conn.port,
		user: conn.user,
		schema: conn.schema,
		transport: conn.transport,
	};
}

export function isConnected(connectionId: string): boolean {
	return connections.has(connectionId);
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

/**
 * Discover all non-template databases on the server.
 * Uses a temporary connection to the `postgres` maintenance database.
 */
export async function listDatabases(
	params: DiscoverParams,
): Promise<{ databases: string[]; transport: ConnectionTransport }> {
	const { pool, transport } = await openPool({
		...params,
		database: 'postgres',
		max: 1,
	});
	try {
		const { rows } = await pool.query<{ datname: string }>(
			'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname',
		);
		return { databases: rows.map((r) => r.datname), transport };
	} finally {
		await pool.end();
	}
}

/**
 * List non-system schemas in a specific database.
 * Uses a temporary connection.
 */
export async function listSchemas(
	params: ListSchemasParams,
): Promise<{ schemas: string[]; transport: ConnectionTransport }> {
	const { pool, transport } = await openPool({
		...params,
		max: 1,
	});
	try {
		const { rows } = await pool.query<{ schema_name: string }>(
			"SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast') ORDER BY schema_name",
		);
		return { schemas: rows.map((r) => r.schema_name), transport };
	} finally {
		await pool.end();
	}
}

export async function disconnectAll(): Promise<void> {
	const promises: Promise<void>[] = [];
	for (const [id] of connections) {
		promises.push(disconnect(id));
	}
	await Promise.all(promises);
}
