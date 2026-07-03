/**
 * E10: Injectable Logger
 *
 * Provides a pluggable logging interface for library code.
 * Default implementation uses console, but can be replaced for:
 * - Silent mode (testing, production)
 * - Custom logging frameworks (pino, winston, etc.)
 * - Structured logging
 */

import { resetWarnedReservedWords } from './table-ref-factory.js';

/**
 * Category of a DX warning, used internally by {@link emitWarning} to decide
 * env/per-instance suppression (#159). The category is NEVER passed to the
 * logger sink (see {@link Logger.warn}) — it only drives the suppression
 * decision inside `emitWarning`.
 *
 * - `'dx'`: developer-experience warnings (e.g. reserved word column access).
 *   Suppressible via `DBSP_SUPPRESS_DX_WARNINGS` and per-instance `suppressDxWarnings`.
 * - `'runtime'`: operational warnings (e.g. raw SQL usage). Suppressible via
 *   its own gate (e.g. `NODE_ENV`) plus the global logger, but NOT via
 *   `DBSP_SUPPRESS_DX_WARNINGS` or per-instance `suppressDxWarnings`.
 */
export type WarningCategory = 'dx' | 'runtime';

/**
 * Logger interface for dbsp library code.
 *
 * Only includes methods actually used by the library.
 * Extend as needed when new log levels are required.
 */
export interface Logger {
	/**
	 * Log a warning message.
	 * Used for: reserved word usage, raw SQL warnings, deprecation notices.
	 *
	 * @param message - The warning message text (stable across versions —
	 *   downstream consumers may parse it). This is the ONLY argument the
	 *   sink ever receives — {@link WarningCategory} is internal to
	 *   {@link emitWarning}'s suppression decision and is never forwarded
	 *   here, so a `{ warn: console.warn }` or rest-arg/pino-style wrapper
	 *   never sees an unexpected extra token.
	 */
	warn(message: string): void;
}

/**
 * Default logger that writes to console.
 * Used when no custom logger is provided.
 */
export const defaultLogger: Logger = {
	warn: (message: string) => console.warn(message),
};

/**
 * Silent logger that discards all messages.
 * Useful for testing or when warnings should be suppressed.
 */
export const silentLogger: Logger = {
	warn: () => {},
};

/**
 * Global logger instance.
 * Can be replaced via setLogger() for application-wide configuration.
 */
let globalLogger: Logger = defaultLogger;

/**
 * Set the global logger instance.
 *
 * @param logger - Logger implementation to use globally
 *
 * @example
 * ```typescript
 * import { setLogger, silentLogger } from '@dbsp/core';
 *
 * // Silence all warnings in tests
 * setLogger(silentLogger);
 *
 * // Use custom logger
 * setLogger({
 *   warn: (msg) => myLogger.warning('[dbsp]', msg),
 * });
 * ```
 */
export function setLogger(logger: Logger): void {
	globalLogger = logger;
}

/**
 * Get the current global logger.
 * Internal use - prefer using getLogger() in library code.
 */
export function getLogger(): Logger {
	return globalLogger;
}

/**
 * Reset logger to default (for testing).
 *
 * Also clears the module-level reserved-word warning dedup (#159) so tests
 * that install a spy logger and assert on warn call counts stay isolated
 * from each other.
 */
export function resetLogger(): void {
	globalLogger = defaultLogger;
	resetWarnedReservedWords();
}

/**
 * Options for {@link emitWarning}.
 */
export interface EmitWarningOptions {
	/**
	 * Categories to suppress for this call site — e.g. an ORM instance's
	 * `suppressDxWarnings` option (passing `['dx']`). Union'd with the env gate: a warning is
	 * suppressed if EITHER applies.
	 */
	readonly suppress?: readonly WarningCategory[];
}

/**
 * Parse a boolean-ish environment variable value.
 *
 * `undefined`, `''`, `'0'`, and `'false'` (case-insensitive) are treated as
 * disabled; every other value (including `'1'`, `'true'`, `'yes'`, or any
 * other non-empty string) is treated as enabled. This avoids the common
 * `if (process.env.FLAG)` bug where `FLAG=0` or `FLAG=false` are truthy
 * strings and therefore incorrectly enable the flag.
 */
function isEnvFlagEnabled(value: string | undefined): boolean {
	if (value === undefined) {
		return false;
	}
	const normalized = value.trim().toLowerCase();
	return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

/**
 * Central warning emission helper (#159).
 *
 * Suppression precedence (a warning is suppressed if ANY of the following hold):
 * 1. `category === 'dx'` AND `DBSP_SUPPRESS_DX_WARNINGS` is enabled per
 *    {@link isEnvFlagEnabled} (read per-call, matching this repo's `NODE_ENV`
 *    gate convention; `'0'`/`'false'` do NOT enable it).
 * 2. `options.suppress` includes `category`.
 * 3. The global logger is the exported `silentLogger` singleton (an explicit
 *    global silence — checked by reference, not behavior, so a custom no-op
 *    logger does NOT trigger this branch).
 *
 * Default (no env var, no `suppress` option, non-silent logger) → nothing is
 * suppressed; the message reaches `getLogger().warn(...)`.
 *
 * The category is used ONLY for this suppression decision — it is NEVER
 * passed to `getLogger().warn(...)`, which receives just the message (see
 * {@link Logger.warn}).
 *
 * @returns `true` when the warning was actually emitted, `false` when
 *   suppressed. Callers that dedup (e.g. the reserved-word warning) MUST
 *   only record the dedup key when this returns `true` — recording it
 *   unconditionally would let a suppressed call permanently "poison" the
 *   dedup slot for every later, non-suppressed caller in the same process.
 */
export function emitWarning(
	message: string,
	category: WarningCategory,
	options?: EmitWarningOptions,
): boolean {
	if (
		category === 'dx' &&
		isEnvFlagEnabled(process.env.DBSP_SUPPRESS_DX_WARNINGS)
	) {
		return false;
	}
	if (options?.suppress?.includes(category)) {
		return false;
	}
	const logger = getLogger();
	if (logger === silentLogger) {
		return false;
	}
	logger.warn(message);
	return true;
}
