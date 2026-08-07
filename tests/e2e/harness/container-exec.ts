import { type ExecResult, getContainerRuntimeClient } from 'testcontainers';
import { LOCAL_CONTAINER_ID_ENV } from '../globalSetup.js';
import { E2eCapabilityError, requireE2eCapabilities } from './capabilities.js';

export interface ContainerCommandFailure extends Error {
	readonly result: ExecResult;
}

export interface DumpRestoreOptions {
	readonly sourceDatabase: string;
	readonly targetDatabase: string;
	readonly username?: string;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/gu, "'\\\"'\\\"'")}'`;
}

function assertNonEmpty(label: string, value: string): void {
	if (value.length === 0)
		throw new Error(`E2E container exec requires ${label}`);
}

function commandFailure(
	command: readonly string[],
	result: ExecResult,
): ContainerCommandFailure {
	const error = new Error(
		`E2E container exec failed with exit ${result.exitCode}: ${command.join(' ')}\n${result.stderr}`,
	) as ContainerCommandFailure;
	Object.defineProperty(error, 'result', { value: result, enumerable: true });
	return error;
}

/**
 * Reattach to the setup-owned PostgreSQL container by its exported ID. The
 * global setup and Vitest test workers are separate processes, so retaining a
 * StartedPostgreSqlContainer object would not work here.
 */
export async function execInLocalPostgresContainer(
	command: readonly string[],
): Promise<ExecResult> {
	await requireE2eCapabilities(['container-exec']);
	const containerId = process.env[LOCAL_CONTAINER_ID_ENV];
	if (!containerId) {
		throw new Error(`E2E container exec requires ${LOCAL_CONTAINER_ID_ENV}`);
	}
	let result: ExecResult;
	try {
		const runtime = await getContainerRuntimeClient();
		const container = runtime.container.getById(containerId);
		result = await runtime.container.exec(container, [...command]);
	} catch (error) {
		throw new E2eCapabilityError(
			'container-exec',
			error instanceof Error ? error.message : String(error),
		);
	}
	if (result.exitCode !== 0) throw commandFailure(command, result);
	return result;
}

/**
 * Perform a PostgreSQL dump/restore entirely inside the setup-owned container.
 * Bash's `pipefail` means pg_dump failures cannot be hidden by pg_restore.
 */
export async function dumpAndRestoreInLocalPostgresContainer(
	options: DumpRestoreOptions,
): Promise<void> {
	const username = options.username ?? process.env.PG_USER;
	assertNonEmpty('sourceDatabase', options.sourceDatabase);
	assertNonEmpty('targetDatabase', options.targetDatabase);
	if (username === undefined) {
		throw new Error(
			'E2E container exec requires PG_USER or an explicit username',
		);
	}
	assertNonEmpty('username', username);

	const shell = [
		'set -o pipefail',
		`pg_dump --format=custom --no-owner --no-privileges --username ${shellQuote(username)} --dbname ${shellQuote(options.sourceDatabase)} | pg_restore --clean --if-exists --no-owner --no-privileges --username ${shellQuote(username)} --dbname ${shellQuote(options.targetDatabase)}`,
	].join('; ');
	await execInLocalPostgresContainer(['bash', '-lc', shell]);
}
