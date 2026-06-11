import type { Node } from '@pgsql/types';
import { createParamRef } from '../../param-ref.js';
import type { CompilerState } from '../types.js';

interface ParamExpressionLike {
	readonly kind: 'param';
	readonly value: unknown;
}

interface LiteralExpressionLike {
	readonly kind: 'literal';
	readonly value: unknown;
}

export function isParamExpressionLike(
	value: unknown,
): value is ParamExpressionLike {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as Record<string, unknown>).kind === 'param' &&
		'value' in value
	);
}

export function isLiteralExpressionLike(
	value: unknown,
): value is LiteralExpressionLike {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as Record<string, unknown>).kind === 'literal' &&
		'value' in value
	);
}

export function unwrapParamExpression(value: unknown): unknown {
	return isParamExpressionLike(value) || isLiteralExpressionLike(value)
		? value.value
		: value;
}

export function bindParameter(value: unknown, state: CompilerState): Node {
	const idx = ++state.paramIndex;
	state.parameters.push(unwrapParamExpression(value));
	return createParamRef(idx);
}
