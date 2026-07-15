import type { DbCasing } from '@dbsp/types';
import type { NamingPlugin } from '../naming-plugin.js';
import { getNamingPluginForDbCasing } from '../naming-plugin.js';
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
	return {
		rules: [createSetNotNullRule({ naming })],
		operationSemantics: [createAlterColumnSetNotNullOperationRuntime()],
		issuer: createPgObservationIssuer(),
		comparatorNameNormalizer: {
			normalizeCurrentIdentifier: (identifier: string) =>
				naming.toModel(identifier),
		},
	};
}
