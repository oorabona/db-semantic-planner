/**
 * E10: Injectable Logger
 *
 * Provides a pluggable logging interface for library code.
 * Default implementation uses console, but can be replaced for:
 * - Silent mode (testing, production)
 * - Custom logging frameworks (pino, winston, etc.)
 * - Structured logging
 */

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
 */
export function resetLogger(): void {
	globalLogger = defaultLogger;
}
