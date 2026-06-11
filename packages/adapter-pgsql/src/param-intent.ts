import { isParamIntent } from '@dbsp/types';

/**
 * Unwrap the first-class ParamIntent node before recording a SQL parameter.
 */
export function unwrapParamIntent(value: unknown): unknown {
	return isParamIntent(value) ? value.value : value;
}
