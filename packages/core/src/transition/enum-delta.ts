import type { EnumIR } from '@dbsp/types';
import { stableJson } from './stable-json.js';

export type EnumAddDelta =
	| { readonly kind: 'none' }
	| {
			readonly kind: 'add-label';
			readonly label: string;
			readonly after?: string;
	  }
	| { readonly kind: 'unsupported' };

export interface EnumAddDeltaOptions {
	readonly targetSchema?: string;
}

export function resolveEnumSchemaForComparison(
	enumDef: EnumIR,
	targetSchema?: string,
): EnumIR {
	if (enumDef.schema !== undefined || targetSchema === undefined) {
		return enumDef;
	}
	return { ...enumDef, schema: targetSchema };
}

// Shared by the core comparator and adapter enum-add rules; keep this as the
// single enum-add classifier.
export function enumAddDelta(
	desired: EnumIR,
	current: EnumIR,
	options: EnumAddDeltaOptions = {},
): EnumAddDelta {
	const resolvedDesired = resolveEnumSchemaForComparison(
		desired,
		options.targetSchema,
	);
	const resolvedCurrent = resolveEnumSchemaForComparison(
		current,
		options.targetSchema,
	);
	if (resolvedDesired.schema !== resolvedCurrent.schema) {
		return { kind: 'unsupported' };
	}
	if (
		stableJson(resolvedDesired.values) === stableJson(resolvedCurrent.values)
	) {
		return { kind: 'none' };
	}
	if (new Set(resolvedDesired.values).size !== resolvedDesired.values.length) {
		return { kind: 'unsupported' };
	}
	if (new Set(resolvedCurrent.values).size !== resolvedCurrent.values.length) {
		return { kind: 'unsupported' };
	}
	const desiredValueSet = new Set(resolvedDesired.values);
	if (resolvedCurrent.values.some((value) => !desiredValueSet.has(value))) {
		return { kind: 'unsupported' };
	}
	const currentValueSet = new Set(resolvedCurrent.values);
	const added = resolvedDesired.values.filter(
		(value) => !currentValueSet.has(value),
	);
	if (added.length !== 1) {
		return { kind: 'unsupported' };
	}
	const withoutAdded = resolvedDesired.values.filter(
		(value) => value !== added[0],
	);
	if (stableJson(withoutAdded) !== stableJson(resolvedCurrent.values)) {
		return { kind: 'unsupported' };
	}
	const label = added[0];
	if (label === undefined) {
		return { kind: 'unsupported' };
	}
	const index = resolvedDesired.values.indexOf(label);
	if (index <= 0) {
		return { kind: 'unsupported' };
	}
	const appended = index === resolvedDesired.values.length - 1;
	if (appended) {
		return { kind: 'add-label', label };
	}
	const after = resolvedDesired.values[index - 1];
	return typeof after === 'string'
		? {
				kind: 'add-label',
				label,
				after,
			}
		: { kind: 'unsupported' };
}
