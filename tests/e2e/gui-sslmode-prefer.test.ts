/**
 * #455 — The shared PostgreSQL test container serves TLS, while this suite's
 * dedicated container does not. The GUI sidecar must use TLS when available,
 * retry prefer connections in plaintext when necessary, and never downgrade
 * require connections.
 */

import {
	PostgreSqlContainer,
	type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Wait } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	type ConnectParams,
	connect,
	disconnect,
} from '../../packages/gui/sidecar/connection-manager.js';
import { parsePostgresUrl } from '../../packages/gui/sidecar/profile-resolver.js';
import { LOCAL_CONTAINER_ENV } from './globalSetup.js';

function testContainerParams(): ConnectParams {
	const databaseUrl = process.env.DATABASE_URL;
	if (databaseUrl === undefined) {
		throw new Error('DATABASE_URL not set. Did globalSetup run successfully?');
	}
	const parsed = parsePostgresUrl(databaseUrl);
	return {
		host: parsed.host,
		port: parsed.port,
		database: parsed.database,
		user: parsed.user,
		password: parsed.password,
		...(parsed.schema === undefined ? {} : { schema: parsed.schema }),
	};
}

function containerParams(container: StartedPostgreSqlContainer): ConnectParams {
	return {
		host: container.getHost(),
		port: container.getPort(),
		database: container.getDatabase(),
		user: container.getUsername(),
		password: container.getPassword(),
	};
}

let connectionId: string | undefined;

afterEach(async () => {
	if (connectionId !== undefined) {
		await disconnect(connectionId);
		connectionId = undefined;
	}
});

describe.runIf(process.env[LOCAL_CONTAINER_ENV] === '1')(
	'#455 GUI sslmode prefer',
	() => {
		let noTlsContainer: StartedPostgreSqlContainer | undefined;
		function noTlsContainerParams(): ConnectParams {
			if (noTlsContainer === undefined) {
				throw new Error('No-TLS PostgreSQL container did not start');
			}
			return containerParams(noTlsContainer);
		}

		beforeAll(async () => {
			const pgImage =
				process.env.POSTGRES_IMAGE ??
				'ghcr.io/oorabona/postgres:18-alpine-full';
			noTlsContainer = await new PostgreSqlContainer(pgImage)
				.withDatabase('e2e_test')
				.withUsername('test')
				.withPassword('test')
				.withCommand(['postgres', '-c', 'ssl=off'])
				.withStartupTimeout(120000)
				.withWaitStrategy(
					Wait.forLogMessage(
						/database system is ready to accept connections/,
						2,
					),
				)
				.start();
		});

		afterAll(async () => {
			await noTlsContainer?.stop();
		});

		it('uses TLS with sslmode prefer when the shared testcontainer supports it', async () => {
			const result = await connect({
				...testContainerParams(),
				sslMode: 'prefer',
			});
			connectionId = result.connectionId;

			expect(result.transport).toBe('tls');
		});

		it('uses TLS with sslmode require when the shared testcontainer supports it', async () => {
			const result = await connect({
				...testContainerParams(),
				sslMode: 'require',
			});
			connectionId = result.connectionId;

			expect(result.transport).toBe('tls');
		});

		it('falls back to plaintext with sslmode prefer when the server has no TLS', async () => {
			const result = await connect({
				...noTlsContainerParams(),
				sslMode: 'prefer',
			});
			connectionId = result.connectionId;

			expect(result.transport).toBe('fallback-plaintext');
		});

		it('does not downgrade sslmode require when the server has no TLS', async () => {
			try {
				const result = await connect({
					...noTlsContainerParams(),
					sslMode: 'require',
				});
				await disconnect(result.connectionId);
				throw new Error('sslmode require unexpectedly connected without TLS');
			} catch (error) {
				expect(error).toHaveProperty(
					'message',
					'The server does not support SSL connections',
				);
			}
		});
	},
);
