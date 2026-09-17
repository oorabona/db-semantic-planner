/**
 * #455 — PostgreSQL's test container does not serve TLS. The GUI sidecar must
 * expose that a prefer connection retried in plaintext, while require refuses
 * the downgrade.
 */
import { afterEach, describe, expect, it } from 'vitest';
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
		it('falls back to plaintext when the testcontainer server has no TLS', async () => {
			const result = await connect({
				...testContainerParams(),
				sslMode: 'prefer',
			});
			connectionId = result.connectionId;

			expect(result.transport).toBe('fallback-plaintext');
		});

		it('does not downgrade sslmode require', async () => {
			await expect(
				connect({ ...testContainerParams(), sslMode: 'require' }),
			).rejects.toThrow('The server does not support SSL connections');
		});
	},
);
