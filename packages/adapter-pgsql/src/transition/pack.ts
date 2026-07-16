import type { DbCasing } from '@dbsp/types';
import type { NamingPlugin } from '../naming-plugin.js';
import { getNamingPluginForDbCasing } from '../naming-plugin.js';
import {
	ALTER_COLUMN_SET_NOT_NULL_CAPABILITY,
	ALTER_COLUMN_SET_NOT_NULL_MIN_SERVER_VERSION_NUM,
} from './constants.js';
import { createPgEquivalenceCapability } from './equivalence.js';
import { createPgObservationIssuer } from './observation-issuer.js';
import { createAlterColumnSetNotNullOperationRuntime } from './operations/alter-column-set-not-null.js';
import { createSetNotNullRule } from './rules/set-not-null.js';

export interface PgTransitionPackOptions {
	readonly dbCasing?: DbCasing;
	readonly naming?: NamingPlugin;
}

export function createPgTransitionPack(options: PgTransitionPackOptions = {}) {
	const naming =
		options.naming ??
		getNamingPluginForDbCasing(options.dbCasing ?? 'preserve');
	const equivalence = createPgEquivalenceCapability();
	return {
		rules: [createSetNotNullRule({ naming })],
		operationSemantics: [createAlterColumnSetNotNullOperationRuntime()],
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
		],
		comparatorNameNormalizer: {
			normalizeCurrentIdentifier: (identifier: string) =>
				naming.toModel(identifier),
		},
	};
}
