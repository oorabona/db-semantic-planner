import pg from 'pg';
import {
	GenericContainer,
	Network,
	type StartedNetwork,
	type StartedTestContainer,
	Wait,
} from 'testcontainers';
import { E2eCapabilityError, requireE2eCapabilities } from './capabilities.js';

const { Pool } = pg;

const POSTGRES_IMAGE = 'ghcr.io/oorabona/postgres:18-alpine-full';
const POSTGRES_USER = 'postgres';
const POSTGRES_DATABASE = 'postgres';
const REPLICATION_ROLE = 'dbsp_e2e_replication';

export interface StreamingStandbyTopology {
	readonly primary: StartedTestContainer;
	readonly standby: StartedTestContainer;
	readonly primaryPool: pg.Pool;
	readonly standbyPool: pg.Pool;
	/** Stop both containers, their pools and their isolated network. */
	stop(): Promise<void>;
}

function postgresPool(container: StartedTestContainer): pg.Pool {
	return new Pool({
		host: container.getHost(),
		port: container.getMappedPort(5432),
		user: POSTGRES_USER,
		database: POSTGRES_DATABASE,
		max: 2,
	});
}

async function checkedExec(
	container: StartedTestContainer,
	command: readonly string[],
): Promise<void> {
	const result = await container.exec([...command]);
	if (result.exitCode === 0) return;
	throw new Error(
		`container command failed with exit ${result.exitCode}: ${command.join(' ')}\n${result.stderr}`,
	);
}

async function stopQuietly(
	resource: { stop(): Promise<unknown> } | undefined,
): Promise<void> {
	await resource?.stop().catch(() => undefined);
}

/**
 * Start an isolated primary/standby pair. The shared e2e database container is
 * not reused or reconfigured. The standby image obtains its data with
 * pg_basebackup -R over the private network, which creates standby.signal.
 */
export async function createStreamingStandbyTopology(): Promise<StreamingStandbyTopology> {
	await requireE2eCapabilities(['standby-topology']);
	const image = process.env.POSTGRES_IMAGE ?? POSTGRES_IMAGE;
	let network: StartedNetwork | undefined;
	let primary: StartedTestContainer | undefined;
	let standby: StartedTestContainer | undefined;
	let primaryPool: pg.Pool | undefined;
	let standbyPool: pg.Pool | undefined;

	try {
		network = await new Network().start();
		primary = await new GenericContainer(image)
			.withEnvironment({
				POSTGRES_DB: POSTGRES_DATABASE,
				POSTGRES_USER,
				POSTGRES_HOST_AUTH_METHOD: 'trust',
			})
			.withNetwork(network)
			.withNetworkAliases('dbsp-e2e-primary')
			.withExposedPorts(5432)
			.withWaitStrategy(
				Wait.forLogMessage(/database system is ready to accept connections/, 2),
			)
			.start();
		await checkedExec(primary, [
			'psql',
			'-v',
			'ON_ERROR_STOP=1',
			'-U',
			POSTGRES_USER,
			'-d',
			POSTGRES_DATABASE,
			'-c',
			`CREATE ROLE ${REPLICATION_ROLE} WITH REPLICATION LOGIN`,
		]);

		standby = await new GenericContainer(image)
			.withEnvironment({ PGDATA: '/var/lib/postgresql/data' })
			.withEntrypoint(['bash', '-lc'])
			.withCommand([
				[
					'set -eu',
					'rm -rf "$PGDATA"',
					'mkdir -p "$PGDATA"',
					`pg_basebackup -h dbsp-e2e-primary -U ${REPLICATION_ROLE} -D "$PGDATA" -R -X stream`,
					'exec postgres',
				].join('\n'),
			])
			.withNetwork(network)
			.withExposedPorts(5432)
			.withHealthCheck({
				test: [
					'CMD-SHELL',
					'psql -U postgres -d postgres -tAc "SELECT pg_is_in_recovery() AND EXISTS (SELECT 1 FROM pg_stat_wal_receiver)" | grep -qx t',
				],
			})
			.withWaitStrategy(Wait.forHealthCheck())
			.start();

		primaryPool = postgresPool(primary);
		standbyPool = postgresPool(standby);
		const [primaryState, standbyState] = await Promise.all([
			primaryPool.query<{ receiving: boolean }>(
				'SELECT EXISTS (SELECT 1 FROM pg_stat_replication) AS receiving',
			),
			standbyPool.query<{ streaming: boolean }>(
				'SELECT pg_is_in_recovery() AND EXISTS (SELECT 1 FROM pg_stat_wal_receiver) AS streaming',
			),
		]);
		if (
			primaryState.rows[0]?.receiving !== true ||
			standbyState.rows[0]?.streaming !== true
		) {
			throw new Error(
				'primary/standby containers started without observable streaming replication state',
			);
		}

		const ownedNetwork = network;
		const ownedPrimary = primary;
		const ownedStandby = standby;
		const ownedPrimaryPool = primaryPool;
		const ownedStandbyPool = standbyPool;
		return {
			primary: ownedPrimary,
			standby: ownedStandby,
			primaryPool: ownedPrimaryPool,
			standbyPool: ownedStandbyPool,
			async stop(): Promise<void> {
				await Promise.allSettled([
					ownedPrimaryPool.end(),
					ownedStandbyPool.end(),
				]);
				await stopQuietly(ownedStandby);
				await stopQuietly(ownedPrimary);
				await stopQuietly(ownedNetwork);
			},
		};
	} catch (error) {
		await Promise.allSettled([primaryPool?.end(), standbyPool?.end()]);
		await stopQuietly(standby);
		await stopQuietly(primary);
		await stopQuietly(network);
		if (error instanceof E2eCapabilityError) throw error;
		throw new E2eCapabilityError(
			'standby-topology',
			error instanceof Error ? error.message : String(error),
		);
	}
}
