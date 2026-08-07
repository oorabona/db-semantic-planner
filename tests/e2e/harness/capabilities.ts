import { getContainerRuntimeClient } from 'testcontainers';
import { beforeAll, describe } from 'vitest';
import { LOCAL_CONTAINER_ENV, LOCAL_CONTAINER_ID_ENV } from '../globalSetup.js';
import { getTestPool } from '../testkit/db.js';

export const E2E_CAPABILITIES = [
	'role-administration',
	'backend-termination',
	'container-exec',
	'standby-topology',
] as const;

export type E2eCapability = (typeof E2E_CAPABILITIES)[number];

export class E2eCapabilityError extends Error {
	readonly capability: E2eCapability;

	constructor(capability: E2eCapability, reason: string, cause?: unknown) {
		super(
			`E2E capability "${capability}" is required but unavailable: ${reason}`,
			{ cause },
		);
		this.name = 'E2eCapabilityError';
		this.capability = capability;
	}
}

export interface CapabilityGateOptions {
	readonly environment?: NodeJS.ProcessEnv;
	/** Test seam used by SC-01 to prove an unavailable role capability fails. */
	readonly probeRoleAdministration?: () => Promise<boolean>;
}

function environmentFor(options: CapabilityGateOptions): NodeJS.ProcessEnv {
	return options.environment ?? process.env;
}

function localContainerReason(
	environment: NodeJS.ProcessEnv,
): string | undefined {
	if (environment[LOCAL_CONTAINER_ENV] !== '1') {
		return `${LOCAL_CONTAINER_ENV}=1 was not exported by e2e globalSetup`;
	}
	if (!environment[LOCAL_CONTAINER_ID_ENV]) {
		return `${LOCAL_CONTAINER_ID_ENV} was not exported by e2e globalSetup`;
	}
	return undefined;
}

async function canAdministerRoles(): Promise<boolean> {
	const pool = await getTestPool();
	const result = await pool.query<{ can_administer_roles: boolean }>(
		`SELECT rolsuper OR rolcreaterole AS can_administer_roles
		   FROM pg_catalog.pg_roles
		  WHERE rolname = current_user`,
	);
	return result.rows[0]?.can_administer_roles === true;
}

async function canTerminateBackends(): Promise<boolean> {
	const pool = await getTestPool();
	const result = await pool.query<{ can_terminate_backends: boolean }>(
		`SELECT rolsuper OR pg_has_role(current_user, 'pg_signal_backend', 'member')
		   AS can_terminate_backends
		   FROM pg_catalog.pg_roles
		  WHERE rolname = current_user`,
	);
	return result.rows[0]?.can_terminate_backends === true;
}

async function canExecuteInRecordedContainer(
	environment: NodeJS.ProcessEnv,
): Promise<boolean> {
	const containerId = environment[LOCAL_CONTAINER_ID_ENV];
	if (!containerId) return false;
	const runtime = await getContainerRuntimeClient();
	const container = runtime.container.getById(containerId);
	const result = await runtime.container.exec(container, ['true']);
	return result.exitCode === 0;
}

/**
 * Fail at the harness boundary for every declared requirement. This function
 * never calls Vitest skip APIs: a missing capability is always an exception.
 */
export async function requireE2eCapabilities(
	requirements: readonly E2eCapability[],
	options: CapabilityGateOptions = {},
): Promise<void> {
	const environment = environmentFor(options);
	for (const capability of requirements) {
		switch (capability) {
			case 'role-administration': {
				let available: boolean;
				try {
					available = await (
						options.probeRoleAdministration ?? canAdministerRoles
					)();
				} catch (error) {
					throw new E2eCapabilityError(
						capability,
						error instanceof Error ? error.message : String(error),
					);
				}
				if (!available) {
					throw new E2eCapabilityError(
						capability,
						'current_user is neither a superuser nor a CREATEROLE role',
					);
				}
				break;
			}
			case 'backend-termination': {
				let available: boolean;
				try {
					available = await canTerminateBackends();
				} catch (error) {
					throw new E2eCapabilityError(
						capability,
						error instanceof Error ? error.message : String(error),
					);
				}
				if (!available) {
					throw new E2eCapabilityError(
						capability,
						'current_user is neither a superuser nor a member of pg_signal_backend',
					);
				}
				break;
			}
			case 'container-exec': {
				const reason = localContainerReason(environment);
				if (reason !== undefined)
					throw new E2eCapabilityError(capability, reason);
				try {
					if (await canExecuteInRecordedContainer(environment)) break;
				} catch (error) {
					throw new E2eCapabilityError(
						capability,
						error instanceof Error ? error.message : String(error),
					);
				}
				throw new E2eCapabilityError(
					capability,
					`${LOCAL_CONTAINER_ID_ENV} is not reachable by the container runtime`,
				);
			}
			case 'standby-topology': {
				const reason = localContainerReason(environment);
				if (reason !== undefined)
					throw new E2eCapabilityError(capability, reason);
				try {
					if (await canExecuteInRecordedContainer(environment)) break;
				} catch (error) {
					throw new E2eCapabilityError(
						capability,
						error instanceof Error ? error.message : String(error),
					);
				}
				throw new E2eCapabilityError(
					capability,
					`${LOCAL_CONTAINER_ID_ENV} is not reachable by the container runtime`,
				);
			}
			default: {
				const exhaustive: never = capability;
				throw new Error(`Unknown e2e capability: ${exhaustive}`);
			}
		}
	}
}

/**
 * The only suite declaration API for privileged e2e capabilities. The gate is
 * installed in beforeAll, making a missing requirement fail the suite before
 * any test body can choose to skip itself.
 */
export function describeWithE2eCapabilities(
	requirements: readonly E2eCapability[],
	name: string,
	define: () => void,
	timeout?: number,
): void {
	describe(
		name,
		() => {
			beforeAll(async () => {
				await requireE2eCapabilities(requirements);
			});
			define();
		},
		timeout,
	);
}
