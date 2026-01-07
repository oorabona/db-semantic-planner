/**
 * @module redact
 * Parameter redaction utilities for safe logging.
 * ADAPTER-004: Enhanced Observability
 */

import {
	DEFAULT_REDACTION_PATTERNS,
	REDACTED_PLACEHOLDER,
	type RedactionOptions,
} from './types.js';

/**
 * Check if a field name matches any redaction pattern.
 * Case-insensitive matching.
 *
 * @param fieldName - The field name to check
 * @param patterns - Patterns to match against
 * @returns true if the field should be redacted
 */
function matchesRedactionPattern(
	fieldName: string,
	patterns: readonly string[],
): boolean {
	const lowerField = fieldName.toLowerCase();
	return patterns.some((pattern) => lowerField.includes(pattern.toLowerCase()));
}

/**
 * Redact sensitive parameter values based on field name hints.
 *
 * @param params - Original parameter values
 * @param fieldHints - Field names corresponding to each parameter (by index)
 * @param options - Redaction options
 * @returns New array with sensitive values replaced by '[REDACTED]'
 *
 * @example
 * ```typescript
 * // Basic usage with default patterns
 * const params = ['john@example.com', 'secret123', 42];
 * const fields = ['email', 'password', 'userId'];
 * const redacted = redactParams(params, fields);
 * // Result: ['john@example.com', '[REDACTED]', 42]
 *
 * // Custom patterns
 * const result = redactParams(params, fields, {
 *   patterns: ['ssn', 'dob']
 * });
 * ```
 */
export function redactParams(
	params: readonly unknown[],
	fieldHints: readonly string[],
	options: RedactionOptions = {},
): readonly unknown[] {
	// Empty params returns empty array
	if (params.length === 0) {
		return [];
	}

	// Determine patterns to use
	let patterns: readonly string[];
	if (options.patterns) {
		// Custom patterns replace defaults
		patterns = options.patterns;
	} else {
		// Start with defaults
		patterns = [...DEFAULT_REDACTION_PATTERNS];
		// Add additional patterns if provided
		if (options.additionalPatterns) {
			patterns = [...patterns, ...options.additionalPatterns];
		}
	}

	const whitelist = new Set(
		(options.whitelist ?? []).map((w) => w.toLowerCase()),
	);

	return params.map((value, index) => {
		const fieldName = fieldHints[index] ?? '';

		// Skip if whitelisted
		if (whitelist.has(fieldName.toLowerCase())) {
			return value;
		}

		// Check if field matches redaction pattern
		if (matchesRedactionPattern(fieldName, patterns)) {
			return REDACTED_PLACEHOLDER;
		}

		return value;
	});
}
