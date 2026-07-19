import type { JsonValue, ResourceAddress } from '@dbsp/types';
import { ENUM_LABEL_VISIBLE_OBSERVATION } from './constants.js';

export interface PgEnumLabelVisibleFactInput {
	readonly database: string;
	readonly schema: string;
	readonly type: string;
	readonly label: string;
}

export function pgEnumLabelVisibleFact(input: PgEnumLabelVisibleFactInput) {
	const resource: ResourceAddress = {
		engine: 'postgresql',
		database: input.database,
		kind: 'type',
		name: input.type,
		qualifiedBy: ['enum'],
		schema: input.schema,
	};
	return {
		kind: ENUM_LABEL_VISIBLE_OBSERVATION,
		resource,
		detail: {
			schema: input.schema,
			type: input.type,
			label: input.label,
		} as JsonValue,
	};
}
