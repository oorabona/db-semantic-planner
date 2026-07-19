import type {
	CapabilityDescriptor,
	ExecutionCoordinator,
	TransitionConnectionPool,
	TransitionExecutionClient,
} from '@dbsp/core';
import type { DbCasing } from '@dbsp/types';
import type { NamingPlugin } from '../naming-plugin.js';
import { getNamingPluginForDbCasing } from '../naming-plugin.js';
import {
	CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY_DESCRIPTOR,
	INDEX_INCLUDE_CAPABILITY,
	INDEX_NULLS_NOT_DISTINCT_CAPABILITY,
} from './index-feature-capabilities.js';
import {
	ALTER_COLUMN_SET_NOT_NULL_CAPABILITY,
	ALTER_COLUMN_SET_NOT_NULL_MIN_SERVER_VERSION_NUM,
	ALTER_TABLE_ADD_CHECK_CAPABILITY,
	ALTER_TABLE_ADD_CHECK_MIN_SERVER_VERSION_NUM,
	ALTER_TYPE_ADD_VALUE_CAPABILITY,
	ALTER_TYPE_ADD_VALUE_MIN_SERVER_VERSION_NUM,
	ENUM_LABEL_VISIBLE_OBSERVATION,
} from './constants.js';
import { createPgEquivalenceCapability } from './equivalence.js';
import { createPgObservationIssuer } from './observation-issuer.js';
import { createAlterColumnSetNotNullOperationRuntime } from './operations/alter-column-set-not-null.js';
import { createAlterTableAddCheckOperationRuntime } from './operations/alter-table-add-check.js';
import { createAlterTypeAddValueOperationRuntime } from './operations/alter-type-add-value.js';
import { createAttachLogicalIdentityOperationRuntime } from './operations/attach-logical-identity.js';
import { createCreateUniqueIndexConcurrentlyOperationRuntime } from './operations/create-unique-index-concurrently.js';
import { createManualSqlOperationRuntime } from './operations/manual-sql.js';
import { isPgGuardTimeout } from './pg-guard-timeout.js';
import { createAddCheckRule } from './rules/add-check.js';
import {
	createLogicalIdentityAdoptionRule,
	type IdentityAdoptionAsserter,
} from './rules/adopt-logical-identity.js';
import { createCreateUniqueIndexConcurrentlyRule } from './rules/create-unique-index-concurrently.js';
import {
	createEnumAddValueRule,
	satisfiesPgEnumLabelVisibleCompositionFact,
} from './rules/enum-add-value.js';
import { createSetNotNullRule } from './rules/set-not-null.js';

export interface PgTransitionPackOptions {
	readonly dbCasing?: DbCasing;
	readonly naming?: NamingPlugin;
	readonly identityAdoptionAsserter?: IdentityAdoptionAsserter;
	readonly identityAdoptionSelectionBasis?: string;
}

type QueryResultLike = {
	readonly rows: readonly Record<string, unknown>[];
};

type Queryable = {
	query(sql: string, params?: readonly unknown[]): Promise<QueryResultLike>;
};

type ReleasableQueryable = Queryable & {
	release(error?: unknown): void;
};

type PoolLike = {
	connect(): Promise<ReleasableQueryable>;
};

const PG_TRANSACTION_DOMAIN = 'postgresql.transition.connection';

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function poolLike(value: unknown): PoolLike | undefined {
	if (isRecord(value) && typeof value.connect === 'function') {
		return value as PoolLike;
	}
	return undefined;
}

function releasable(value: unknown): value is ReleasableQueryable {
	return (
		isRecord(value) &&
		typeof value.query === 'function' &&
		typeof value.release === 'function'
	);
}

function clientQuery(client: TransitionExecutionClient): Queryable {
	if (
		isRecord(client.opaqueClient) &&
		typeof client.opaqueClient.query === 'function'
	) {
		return client.opaqueClient as Queryable;
	}
	throw new Error('PostgreSQL transition execution client is not queryable');
}

function boundedLockTimeout(maxWaitMs: number): number {
	if (!Number.isFinite(maxWaitMs)) {
		return 5000;
	}
	return Math.max(0, Math.min(86_400_000, Math.trunc(maxWaitMs)));
}

function createPgExecutionCoordinator(): ExecutionCoordinator {
	return {
		transactionDomain: PG_TRANSACTION_DOMAIN,
		async checkout(
			target: TransitionConnectionPool,
		): Promise<TransitionExecutionClient> {
			const pool = poolLike(target);
			if (!pool) {
				throw new Error(
					'PostgreSQL transition target must be a Pool-like object with connect(); checked-out clients are not accepted',
				);
			}
			return { opaqueClient: await pool.connect() };
		},
		release(client: TransitionExecutionClient, error?: unknown) {
			if (releasable(client.opaqueClient)) {
				client.opaqueClient.release(error);
			}
		},
		async begin(client: TransitionExecutionClient) {
			await clientQuery(client).query('BEGIN');
		},
		async setLockTimeout(client: TransitionExecutionClient, maxWaitMs: number) {
			await clientQuery(client).query(
				`SET LOCAL lock_timeout = '${boundedLockTimeout(maxWaitMs)}ms'`,
			);
		},
		async commit(client: TransitionExecutionClient) {
			await clientQuery(client).query('COMMIT');
		},
		async rollback(client: TransitionExecutionClient) {
			await clientQuery(client).query('ROLLBACK');
		},
		isLockTimeout(error: unknown) {
			return isPgGuardTimeout(error);
		},
	};
}

export function createPgTransitionPack(options: PgTransitionPackOptions = {}) {
	const naming =
		options.naming ??
		getNamingPluginForDbCasing(options.dbCasing ?? 'preserve');
	const equivalence = createPgEquivalenceCapability();
	const executionCoordinator = createPgExecutionCoordinator();
	const capabilityDescriptors: readonly CapabilityDescriptor[] = [
		{
			id: ALTER_COLUMN_SET_NOT_NULL_CAPABILITY,
			predicate: {
				kind: 'minServerVersionNum',
				minServerVersionNum: ALTER_COLUMN_SET_NOT_NULL_MIN_SERVER_VERSION_NUM,
			},
		},
		{
			id: ALTER_TABLE_ADD_CHECK_CAPABILITY,
			predicate: {
				kind: 'minServerVersionNum',
				minServerVersionNum: ALTER_TABLE_ADD_CHECK_MIN_SERVER_VERSION_NUM,
			},
		},
		{
			id: ALTER_TYPE_ADD_VALUE_CAPABILITY,
			predicate: {
				kind: 'minServerVersionNum',
				minServerVersionNum: ALTER_TYPE_ADD_VALUE_MIN_SERVER_VERSION_NUM,
			},
		},
		CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY_DESCRIPTOR,
		INDEX_INCLUDE_CAPABILITY,
		INDEX_NULLS_NOT_DISTINCT_CAPABILITY,
	];
	return {
		rules: [
			createLogicalIdentityAdoptionRule({
				naming,
				...(options.identityAdoptionAsserter
					? { asserter: options.identityAdoptionAsserter }
					: {}),
				...(options.identityAdoptionSelectionBasis
					? { selectionBasis: options.identityAdoptionSelectionBasis }
					: {}),
			}),
			createSetNotNullRule({ naming }),
			createAddCheckRule({ naming }),
			createEnumAddValueRule({ naming }),
			createCreateUniqueIndexConcurrentlyRule({ naming }),
		],
		operationSemantics: [
			createAttachLogicalIdentityOperationRuntime(),
			createAlterColumnSetNotNullOperationRuntime(),
			createAlterTableAddCheckOperationRuntime(),
			createAlterTypeAddValueOperationRuntime(),
			createCreateUniqueIndexConcurrentlyOperationRuntime(),
			createManualSqlOperationRuntime(),
		],
		issuer: createPgObservationIssuer(),
		executionCoordinator,
		transactionDomain: executionCoordinator.transactionDomain,
		equivalence,
		capabilityDescriptors,
		comparatorNameNormalizer: {
			normalizeCurrentIdentifier: (identifier: string) =>
				naming.toModel(identifier),
		},
		compositionFactKinds: [ENUM_LABEL_VISIBLE_OBSERVATION],
		satisfiesCompositionFact: satisfiesPgEnumLabelVisibleCompositionFact,
	};
}
