import { isParamIntent } from '@dbsp/types';

/**
 * Unwrap the first-class ParamIntent node before recording a SQL parameter.
 * Single-level only — never recurse into .value; the inner bound value is opaque user data.
 */
export function unwrapParamIntent(value: unknown): unknown {
	return isParamIntent(value) ? value.value : value;
}
