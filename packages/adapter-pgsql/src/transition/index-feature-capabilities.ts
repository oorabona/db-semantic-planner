import type { CapabilityDescriptor } from '@dbsp/types';

export {
	INDEX_INCLUDE_CAPABILITY,
	INDEX_NULLS_NOT_DISTINCT_CAPABILITY,
} from '../ddl/index-feature-capabilities.js';

import {
	CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY,
	CREATE_UNIQUE_INDEX_CONCURRENTLY_MIN_SERVER_VERSION_NUM,
} from './constants.js';

export const CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY_DESCRIPTOR = {
	id: CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY,
	predicate: {
		kind: 'minServerVersionNum',
		minServerVersionNum:
			CREATE_UNIQUE_INDEX_CONCURRENTLY_MIN_SERVER_VERSION_NUM,
	},
} as const satisfies CapabilityDescriptor;
