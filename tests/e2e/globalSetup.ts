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

// Testcontainers requires DOCKER_HOST to be set for Podman environments
// Add to your ~/.bashrc: export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman/podman.sock"
if (!process.env.DOCKER_HOST) {
	throw new Error(
		'DOCKER_HOST is not set. For Podman, add to ~/.bashrc:\n' +
			'  export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/podman/podman.sock"',
	);
}

// Use host networking for better Podman compatibility
process.env.TESTCONTAINERS_HOST_OVERRIDE = 'localhost';

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
	// Check Docker availability
	const dockerAvailable = await isDockerAvailable();
	if (!dockerAvailable) {
		console.warn('\n⚠️  Docker is not available. E2E tests will be skipped.\n');
		process.env.SKIP_E2E_TESTS = 'true';
		return;
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
			.withStartupTimeout(60000) // 1 minute
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
		process.env.SKIP_E2E_TESTS = 'true';
		// Don't throw - allow compile-only tests to run
	}
}

export async function teardown(): Promise<void> {
	if (container) {
		console.log('\n🧹 Stopping PostgreSQL container...');
		await container.stop();
		console.log('✅ PostgreSQL container stopped.\n');
	}
}
