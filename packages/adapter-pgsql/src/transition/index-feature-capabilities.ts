import type { CapabilityDescriptor } from '@dbsp/types';
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

export const INDEX_INCLUDE_CAPABILITY = {
	id: 'index-include',
	predicate: {
		kind: 'minServerVersionNum',
		minServerVersionNum: 110000,
	},
} as const satisfies CapabilityDescriptor;

export const INDEX_NULLS_NOT_DISTINCT_CAPABILITY = {
	id: 'index-nulls-not-distinct',
	predicate: {
		kind: 'minServerVersionNum',
		minServerVersionNum: 150000,
	},
} as const satisfies CapabilityDescriptor;
