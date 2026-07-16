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

// Shared by the core comparator and adapter enum-add rules; keep this as the
// single enum-add classifier.
export function enumAddDelta(desired: EnumIR, current: EnumIR): EnumAddDelta {
	if (desired.schema !== undefined && desired.schema !== current.schema) {
		return { kind: 'unsupported' };
	}
	if (stableJson(desired.values) === stableJson(current.values)) {
		return { kind: 'none' };
	}
	if (new Set(desired.values).size !== desired.values.length) {
		return { kind: 'unsupported' };
	}
	if (new Set(current.values).size !== current.values.length) {
		return { kind: 'unsupported' };
	}
	const desiredValueSet = new Set(desired.values);
	if (current.values.some((value) => !desiredValueSet.has(value))) {
		return { kind: 'unsupported' };
	}
	const currentValueSet = new Set(current.values);
	const added = desired.values.filter((value) => !currentValueSet.has(value));
	if (added.length !== 1) {
		return { kind: 'unsupported' };
	}
	const withoutAdded = desired.values.filter((value) => value !== added[0]);
	if (stableJson(withoutAdded) !== stableJson(current.values)) {
		return { kind: 'unsupported' };
	}
	const label = added[0];
	if (label === undefined) {
		return { kind: 'unsupported' };
	}
	const index = desired.values.indexOf(label);
	if (index <= 0) {
		return { kind: 'unsupported' };
	}
	const appended = index === desired.values.length - 1;
	if (appended) {
		return { kind: 'add-label', label };
	}
	const after = desired.values[index - 1];
	return typeof after === 'string'
		? {
				kind: 'add-label',
				label,
				after,
			}
		: { kind: 'unsupported' };
}
