/**
 * @module builders
 * Builder utility types for progressive intent construction.
 *
 * @internal Not part of the public API. Exported via @dbsp/types/internal only.
 */

/**
 * Utility type: removes readonly modifiers for progressive intent construction.
 * Use for building intents step-by-step, then finalize to readonly type.
 *
 * @internal Not part of the public API. Exported via @dbsp/types/internal only.
 */
export type Mutable<T> = {
	-readonly [K in keyof T]: T[K];
};

/**
 * Intent builder type: required fields + optional rest.
 * Use Pick for the required fields, Partial for the optional ones.
 *
 * @example
 * type IncludeBuilder = IntentBuilder<IncludeIntent, 'relation'>;
 * // = { relation: string } & Partial<Omit<IncludeIntent, 'relation'>>
 *
 * @internal Not part of the public API.
 */
export type IntentBuilder<T, TRequired extends keyof T> = Pick<T, TRequired> &
	Partial<Omit<T, TRequired>>;
