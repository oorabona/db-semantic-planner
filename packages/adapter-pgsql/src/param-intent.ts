import { isParamIntent } from '@dbsp/types';

/** Normalize the public param() ExpressionSpec without inspecting its bound value. */
export function normalizeParamIntent(value: unknown): unknown {
	if (
		value !== null &&
		typeof value === 'object' &&
		'__expr' in value &&
		value.__expr === true &&
		'intent' in value
	) {
		const intent = value.intent;
		return isParamIntent(intent) ? intent : value;
	}
	return value;
}

/**
 * Unwrap the first-class ParamIntent node before recording a SQL parameter.
 * Single-level only — never recurse into .value; the inner bound value is opaque user data.
 */
export function unwrapParamIntent(value: unknown): unknown {
	const intent = normalizeParamIntent(value);
	return isParamIntent(intent) ? intent.value : value;
}
