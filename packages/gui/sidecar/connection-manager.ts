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
	schema: string;
	database: string;
	host: string;
	port: number;
	user: string;
}

const connections = new Map<string, ManagedConnection>();

function sslConfig(mode: SslMode): boolean | { rejectUnauthorized: boolean } {
	switch (mode) {
		case 'disable':
			return false;
		case 'allow':
		case 'prefer':
			return { rejectUnauthorized: false };
		case 'require':
			// `require` deliberately encrypts while allowing self-signed development
			// certificates; `verify-full` is the mode that verifies the certificate.
			return { rejectUnauthorized: false };
		case 'verify-full':
			return { rejectUnauthorized: true };
	}
}

export async function connect(params: ConnectParams): Promise<{
	connectionId: string;
	database: string;
	schema: string;
}> {
	const schema = params.schema ?? 'public';
	const ssl = sslConfig(params.sslMode ?? 'prefer');

	const pool = new Pool({
		host: params.host,
		port: params.port,
		database: params.database,
		user: params.user,
		password: params.password,
		ssl,
		max: 5,
		connectionTimeoutMillis: 10_000,
		// Set search_path at connection level so all clients in the pool use it
		...(schema !== 'public' && {
			options: `-c search_path="${schema}",public`,
		}),
	});

	// Test the connection
	const client = await pool.connect();
	try {
		await client.query('SELECT 1');
	} finally {
		client.release();
	}

	const connectionId = randomUUID();
	connections.set(connectionId, {
		pool,
		schema,
		database: params.database,
		host: params.host,
		port: params.port,
		user: params.user,
	});

	return { connectionId, database: params.database, schema };
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
} | null {
	const conn = connections.get(connectionId);
	if (!conn) return null;
	return {
		database: conn.database,
		host: conn.host,
		port: conn.port,
		user: conn.user,
		schema: conn.schema,
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
): Promise<{ databases: string[] }> {
	const ssl = sslConfig(params.sslMode ?? 'prefer');
	const pool = new Pool({
		host: params.host,
		port: params.port,
		database: 'postgres',
		user: params.user,
		password: params.password,
		ssl,
		max: 1,
		connectionTimeoutMillis: 10_000,
	});
	try {
		const { rows } = await pool.query<{ datname: string }>(
			'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname',
		);
		return { databases: rows.map((r) => r.datname) };
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
): Promise<{ schemas: string[] }> {
	const ssl = sslConfig(params.sslMode ?? 'prefer');
	const pool = new Pool({
		host: params.host,
		port: params.port,
		database: params.database,
		user: params.user,
		password: params.password,
		ssl,
		max: 1,
		connectionTimeoutMillis: 10_000,
	});
	try {
		const { rows } = await pool.query<{ schema_name: string }>(
			"SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast') ORDER BY schema_name",
		);
		return { schemas: rows.map((r) => r.schema_name) };
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
