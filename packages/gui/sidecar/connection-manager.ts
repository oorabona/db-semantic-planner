import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { introspect } from "@dbsp/adapter-pgsql";
import type { IntrospectedModelIR } from "@dbsp/adapter-pgsql";

export type SslMode = "disable" | "allow" | "prefer" | "require" | "verify-full";

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
		case "disable":
			return false;
		case "allow":
		case "prefer":
			return { rejectUnauthorized: false };
		case "require":
			return { rejectUnauthorized: false };
		case "verify-full":
			return { rejectUnauthorized: true };
	}
}

export async function connect(params: ConnectParams): Promise<{
	connectionId: string;
	database: string;
	schema: string;
}> {
	const schema = params.schema ?? "public";
	const ssl = sslConfig(params.sslMode ?? "prefer");

	const pool = new Pool({
		host: params.host,
		port: params.port,
		database: params.database,
		user: params.user,
		password: params.password,
		ssl,
		max: 5,
		connectionTimeoutMillis: 10_000,
	});

	// Test the connection
	const client = await pool.connect();
	try {
		await client.query("SELECT 1");
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
): Promise<IntrospectedModelIR> {
	const conn = connections.get(connectionId);
	if (!conn) throw new Error("Not connected");
	return introspect(conn.pool, { schema: conn.schema });
}

export function getPool(connectionId: string): Pool {
	const conn = connections.get(connectionId);
	if (!conn) throw new Error("Not connected");
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

export async function disconnectAll(): Promise<void> {
	const promises: Promise<void>[] = [];
	for (const [id] of connections) {
		promises.push(disconnect(id));
	}
	await Promise.all(promises);
}
