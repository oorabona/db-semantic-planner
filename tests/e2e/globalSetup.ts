/**
 * E2E Test Global Setup
 *
 * Starts a PostgreSQL container via Testcontainers and exposes
 * connection details via environment variables.
 */

import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Wait } from 'testcontainers';

// Store container reference for teardown
let container: StartedPostgreSqlContainer | undefined;

/**
 * Check if Docker is available
 */
async function isDockerAvailable(): Promise<boolean> {
	try {
		const { exec } = await import('node:child_process');
		const { promisify } = await import('node:util');
		const execAsync = promisify(exec);
		await execAsync('docker info');
		return true;
	} catch {
		return false;
	}
}

export async function setup(): Promise<void> {
	// If DATABASE_URL is already set externally, use it directly (no container needed)
	if (process.env.DATABASE_URL) {
		console.log(
			`\n🐘 Using external DATABASE_URL: ${process.env.DATABASE_URL}\n`,
		);
		return;
	}

	// Check Docker/Podman availability (works with or without DOCKER_HOST)
	const dockerAvailable = await isDockerAvailable();
	if (!dockerAvailable) {
		console.error(
			'\n❌ No DATABASE_URL set and Docker/Podman is not available.\n' +
				'  Either set DATABASE_URL or install Docker/Podman.\n' +
				'  For Podman on WSL2, you may need: export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman/podman.sock"\n',
		);
		return;
	}

	// For Podman/WSL2 environments, ensure Testcontainers connects to localhost
	if (process.env.DOCKER_HOST || !process.env.TESTCONTAINERS_HOST_OVERRIDE) {
		process.env.TESTCONTAINERS_HOST_OVERRIDE = 'localhost';
	}

	// Allow custom PostgreSQL image via environment variable
	// Supports: docker.io/oorabona/postgres:16-full-alpine, docker.io/oorabona/postgres:17-full-alpine
	const pgImage = process.env.POSTGRES_IMAGE ?? 'postgres:16-alpine';
	console.log(`\n🐘 Starting PostgreSQL container (${pgImage})...`);

	try {
		container = await new PostgreSqlContainer(pgImage)
			.withDatabase('e2e_test')
			.withUsername('test')
			.withPassword('test')
			.withStartupTimeout(120000) // 2 minutes
			.withWaitStrategy(
				Wait.forLogMessage(/database system is ready to accept connections/, 2),
			)
			.start();

		// Set environment variables for tests
		const connectionUri = container.getConnectionUri();
		process.env.DATABASE_URL = connectionUri;
		process.env.PG_HOST = container.getHost();
		process.env.PG_PORT = container.getPort().toString();
		process.env.PG_DATABASE = container.getDatabase();
		process.env.PG_USER = container.getUsername();
		process.env.PG_PASSWORD = container.getPassword();

		console.log(`✅ PostgreSQL container started at ${connectionUri}\n`);
	} catch (error) {
		console.error('\n❌ Failed to start PostgreSQL container:', error);
		console.warn('\n⚠️  E2E database tests will be skipped.\n');
		return;
	}
}

export async function teardown(): Promise<void> {
	if (container) {
		console.log('\n🧹 Stopping PostgreSQL container...');
		await container.stop();
		console.log('✅ PostgreSQL container stopped.\n');
	}
}
