import type { DbCasing } from '@dbsp/types';
import type { NamingPlugin } from '../naming-plugin.js';
import { getNamingPluginForDbCasing } from '../naming-plugin.js';
import {
	ALTER_COLUMN_SET_NOT_NULL_CAPABILITY,
	ALTER_COLUMN_SET_NOT_NULL_MIN_SERVER_VERSION_NUM,
	ALTER_TABLE_ADD_CHECK_CAPABILITY,
	ALTER_TABLE_ADD_CHECK_MIN_SERVER_VERSION_NUM,
	ALTER_TYPE_ADD_VALUE_CAPABILITY,
	ALTER_TYPE_ADD_VALUE_MIN_SERVER_VERSION_NUM,
	CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY,
	CREATE_UNIQUE_INDEX_CONCURRENTLY_MIN_SERVER_VERSION_NUM,
	ENUM_LABEL_VISIBLE_OBSERVATION,
} from './constants.js';
import { createPgEquivalenceCapability } from './equivalence.js';
import { createPgObservationIssuer } from './observation-issuer.js';
import { createAlterColumnSetNotNullOperationRuntime } from './operations/alter-column-set-not-null.js';
import { createAlterTableAddCheckOperationRuntime } from './operations/alter-table-add-check.js';
import { createAlterTypeAddValueOperationRuntime } from './operations/alter-type-add-value.js';
import { createAttachLogicalIdentityOperationRuntime } from './operations/attach-logical-identity.js';
import { createCreateUniqueIndexConcurrentlyOperationRuntime } from './operations/create-unique-index-concurrently.js';
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

export function createPgTransitionPack(options: PgTransitionPackOptions = {}) {
	const naming =
		options.naming ??
		getNamingPluginForDbCasing(options.dbCasing ?? 'preserve');
	const equivalence = createPgEquivalenceCapability();
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
		],
		issuer: createPgObservationIssuer(),
		equivalence,
		capabilityDescriptors: [
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
			{
				id: CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY,
				predicate: {
					kind: 'minServerVersionNum',
					minServerVersionNum:
						CREATE_UNIQUE_INDEX_CONCURRENTLY_MIN_SERVER_VERSION_NUM,
				},
			},
		],
		comparatorNameNormalizer: {
			normalizeCurrentIdentifier: (identifier: string) =>
				naming.toModel(identifier),
		},
		compositionFactKinds: [ENUM_LABEL_VISIBLE_OBSERVATION],
		satisfiesCompositionFact: satisfiesPgEnumLabelVisibleCompositionFact,
	};
}
