/**
 * Local types for Playground sub-components. Public API of theme/playground/
 * is INTENTIONALLY narrow — only the parent (Playground.vue) consumes these.
 */

export interface ErrorBannerData {
	readonly severity: 'warn' | 'fatal';
	readonly title: string;
	readonly message: string;
	readonly actions: readonly ErrorBannerAction[];
}

export interface ErrorBannerAction {
	readonly label: string;
	readonly handler: () => void;
}

/**
 * Shape of a v1 URL hash payload. New version → bump HASH_VERSION,
 * add a discriminated union here.
 */
export interface HashPayloadV1 {
	readonly v: 1;
	readonly s: string; // schema DSL
	readonly n: string; // NQL query
	readonly m: 'nql'; // mode — `'ts'` lands in v2 once T3 ships
}

/** Maximum size of a decoded schema DSL payload, in bytes. */
export const MAX_SCHEMA_BYTES = 8 * 1024;

/** Maximum size of a decoded NQL query payload, in bytes. */
export const MAX_NQL_BYTES = 2 * 1024;
