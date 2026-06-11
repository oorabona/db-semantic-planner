/**
 * @dbsp/types/internal - Internal type definitions
 *
 * These types are for internal use by @dbsp package implementations.
 * They are NOT part of the public API and may change without notice.
 *
 * @module @dbsp/types/internal
 * @internal
 */

// Internal-only build utilities (NOT part of public API)
export type { IntentBuilder, Mutable } from './builders.js';

const expressionValueIntentMarker = Symbol(
	'@dbsp/internal/expression-value-intent',
);
const paramValueProvenanceMarker = Symbol(
	'@dbsp/internal/param-value-provenance',
);

export interface InternalParamExpressionValueIntent {
	readonly kind: 'param';
	readonly value: unknown;
}

export interface InternalLiteralExpressionValueIntent {
	readonly kind: 'literal';
	readonly value: unknown;
}

function hasOwnMarker(value: unknown, marker: symbol): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		Object.hasOwn(value, marker) &&
		(value as Record<PropertyKey, unknown>)[marker] === true
	);
}

export function markExpressionValueIntent<T extends object>(intent: T): T {
	Object.defineProperty(intent, expressionValueIntentMarker, {
		value: true,
	});
	return intent;
}

export function isParamExpressionValueIntent(
	value: unknown,
): value is InternalParamExpressionValueIntent {
	return (
		hasOwnMarker(value, expressionValueIntentMarker) &&
		(value as Record<string, unknown>).kind === 'param' &&
		'value' in (value as object)
	);
}

export function isLiteralExpressionValueIntent(
	value: unknown,
): value is InternalLiteralExpressionValueIntent {
	return (
		hasOwnMarker(value, expressionValueIntentMarker) &&
		(value as Record<string, unknown>).kind === 'literal' &&
		'value' in (value as object)
	);
}

export function unwrapExpressionValueIntent(value: unknown): unknown {
	return isParamExpressionValueIntent(value) ||
		isLiteralExpressionValueIntent(value)
		? value.value
		: value;
}

export function markParamValueProvenance<T extends object>(intent: T): T {
	Object.defineProperty(intent, paramValueProvenanceMarker, {
		value: true,
	});
	return intent;
}

export function hasParamValueProvenance(value: unknown): boolean {
	return hasOwnMarker(value, paramValueProvenanceMarker);
}

export function paramExpressionValueIntent(
	value: unknown,
): InternalParamExpressionValueIntent {
	return markExpressionValueIntent({ kind: 'param', value });
}

export function wrapParamValueIfProvenanceMarked(
	carrier: unknown,
	value: unknown,
): unknown {
	return hasParamValueProvenance(carrier)
		? paramExpressionValueIntent(value)
		: value;
}

// Re-export all public types for convenience
export * from './index.js';
