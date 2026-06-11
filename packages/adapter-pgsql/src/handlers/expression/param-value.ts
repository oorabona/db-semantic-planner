import {
	isLiteralExpressionValueIntent,
	isParamExpressionValueIntent,
	unwrapExpressionValueIntent,
} from '@dbsp/types/internal';
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
	return isParamExpressionValueIntent(value);
}

export function isLiteralExpressionLike(
	value: unknown,
): value is LiteralExpressionLike {
	return isLiteralExpressionValueIntent(value);
}

export function unwrapParamExpression(value: unknown): unknown {
	return unwrapExpressionValueIntent(value);
}

export function bindParameter(value: unknown, state: CompilerState): Node {
	const idx = ++state.paramIndex;
	state.parameters.push(unwrapParamExpression(value));
	return createParamRef(idx);
}
