/**
 * Sidecar-side profile URI resolver for file:// and env:// schemes.
 * SEC-01: file:// paths restricted to project folder.
 * SEC-03: only DATABASE_URL key extracted, no caching.
 */
import { readFile } from 'node:fs/promises';
import { normalize, resolve } from 'node:path';

// ── Types ────────────────────────────────────────────────────────

export interface ConnectionParams {
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	schema?: string;
	sslMode?: string;
}

// ── Main Resolver ────────────────────────────────────────────────

export async function resolveProfileUri(
	uri: string,
	projectPath?: string,
): Promise<ConnectionParams> {
	const match = /^(file|env):\/\/(.+)$/.exec(uri);
	if (!match) {
		throw new Error(`Unsupported or invalid URI scheme: ${uri}`);
	}

	const scheme = match[1];
	const value = match[2]!;

	switch (scheme) {
		case 'file':
			return resolveFileProfile(value, projectPath);
		case 'env':
			return resolveEnvProfile(value);
		default:
			throw new Error(`Unsupported scheme: ${scheme}`);
	}
}

// ── file:// scheme ───────────────────────────────────────────────

async function resolveFileProfile(
	relativePath: string,
	projectPath?: string,
): Promise<ConnectionParams> {
	const base = projectPath || process.cwd();
	const resolvedPath = resolve(base, relativePath);

	// SEC-01: restrict to project folder
	const normalizedBase = normalize(base);
	const normalizedPath = normalize(resolvedPath);
	if (!normalizedPath.startsWith(normalizedBase)) {
		throw new Error(
			`Path traversal blocked: "${relativePath}" resolves outside project folder`,
		);
	}

	let content: string;
	try {
		content = await readFile(resolvedPath, 'utf-8');
	} catch {
		throw new Error(`File not found: ${relativePath}`);
	}

	// SEC-03: extract only DATABASE_URL, don't cache or log full content
	const env = parseEnvFile(content);
	const dbUrl = env.DATABASE_URL;
	if (!dbUrl) {
		throw new Error(`DATABASE_URL not found in ${relativePath}`);
	}

	return parsePostgresUrl(dbUrl);
}

// ── env:// scheme ────────────────────────────────────────────────

function resolveEnvProfile(varName: string): ConnectionParams {
	const value = process.env[varName];
	if (!value) {
		throw new Error(`Environment variable ${varName} is not set`);
	}

	return parsePostgresUrl(value);
}

// ── .env Parser (minimal, no dotenv dep) ─────────────────────────

/**
 * Parse KEY=VALUE lines from a .env file.
 * Handles: comments (#), empty lines, quoted values (single/double).
 */
export function parseEnvFile(content: string): Record<string, string> {
	const result: Record<string, string> = {};

	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		const eqIndex = trimmed.indexOf('=');
		if (eqIndex === -1) continue;

		const key = trimmed.slice(0, eqIndex).trim();
		let value = trimmed.slice(eqIndex + 1).trim();

		// Strip surrounding quotes
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		result[key] = value;
	}

	return result;
}

// ── Postgres URL Parser ──────────────────────────────────────────

/**
 * Parse a postgres:// URL into ConnectionParams.
 * Format: postgresql://user:password@host:port/database?schema=public&sslmode=require
 */
export function parsePostgresUrl(url: string): ConnectionParams {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Invalid connection URL: ${url}`);
	}

	if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
		throw new Error(
			`Expected postgresql:// or postgres:// URL, got ${parsed.protocol}`,
		);
	}

	const params: ConnectionParams = {
		host: parsed.hostname || 'localhost',
		port: parsed.port ? Number.parseInt(parsed.port, 10) : 5432,
		database: parsed.pathname.slice(1) || 'postgres', // remove leading /
		user: decodeURIComponent(parsed.username || 'postgres'),
		password: decodeURIComponent(parsed.password || ''),
	};

	// Query params
	const schema =
		parsed.searchParams.get('schema') ??
		parsed.searchParams.get('search_path');
	if (schema) params.schema = schema;

	const sslMode = parsed.searchParams.get('sslmode');
	if (sslMode) params.sslMode = sslMode;

	return params;
}
