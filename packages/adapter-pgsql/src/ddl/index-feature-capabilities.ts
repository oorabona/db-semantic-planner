import type { CapabilityDescriptor } from '@dbsp/types';

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
