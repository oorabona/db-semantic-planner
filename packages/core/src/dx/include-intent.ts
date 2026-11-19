/**
 * Include-intent helpers: convert include options to IncludeIntent, parse
 * dot-notation include paths, and validate recursive includes.
 *
 * @module include-intent
 */

import type { Mutable } from '@dbsp/types/internal';
import { POSTGRESQL_CAPABILITIES } from '../dialects/index.js';
import type { IncludeIntent, IncludeRecursiveOptions } from '../intent-ast.js';
import type { ModelIR } from '../model-ir.js';
import { validateRecursiveIncludeStrategy } from '../planner.js';
import { InvalidOperationError } from './errors.js';
import type {
	IncludeOptionsWithRecursive,
	NestedInclude,
	RecursiveIncludeOptions,
} from './types.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if options indicate a recursive include.
 */
export function isRecursiveIncludeOptions(
	options?: IncludeOptionsWithRecursive,
): options is RecursiveIncludeOptions {
	return (
		options !== undefined &&
		'recursive' in options &&
		options.recursive === true
	);
}

/**
 * Convert IncludeOptions to IncludeIntent.
 * Handles exactOptionalPropertyTypes by only including defined properties.
 */
export function includeOptionsToIntent(
	relation: string,
	options?: IncludeOptionsWithRecursive,
): IncludeIntent {
	if (!options) {
		return { relation };
	}

	const intent: Mutable<IncludeIntent> = { relation };

	if (options.limit !== undefined) intent.limit = options.limit;
	if (options.orderBy !== undefined) intent.orderBy = options.orderBy;
	if (options.via !== undefined) {
		intent.via = options.via;
	}
	if (options.where !== undefined) {
		intent.where = options.where;
	}
	if (options.select !== undefined) {
		intent.select = options.select;
	}
	if (options.include !== undefined && options.include.length > 0) {
		intent.include = options.include.map((nested) =>
			nestedIncludeToIntent(nested),
		);
	}

	if (options.join !== undefined) {
		intent.join = options.join;
	}

	// Handle recursive options (DX-017)
	if (isRecursiveIncludeOptions(options)) {
		const recursiveOpts: Mutable<IncludeRecursiveOptions> = {
			direction: options.direction,
			...(options.flat !== undefined && { flat: options.flat }),
			...(options.omitSelf !== undefined && { omitSelf: options.omitSelf }),
		};
		// Only set maxDepth if defined
		if (options.maxDepth !== undefined) {
			recursiveOpts.maxDepth = options.maxDepth;
		}
		// Convert includeDepth to track.depth
		if (options.includeDepth || options.flat) {
			recursiveOpts.track = { depth: true };
		}
		intent.recursive = recursiveOpts;
	}

	return intent as IncludeIntent;
}

/**
 * Convert NestedInclude to IncludeIntent.
 */
export function nestedIncludeToIntent(nested: NestedInclude): IncludeIntent {
	const intent: Mutable<IncludeIntent> = { relation: nested.relation };
	if (nested.join !== undefined) {
		intent.join = nested.join;
	}

	if (nested.limit !== undefined) intent.limit = nested.limit;
	if (nested.orderBy !== undefined) intent.orderBy = nested.orderBy;
	if (nested.via !== undefined) {
		intent.via = nested.via;
	}
	if (nested.where !== undefined) {
		intent.where = nested.where;
	}
	if (nested.select !== undefined) {
		intent.select = nested.select;
	}
	if (nested.include !== undefined && nested.include.length > 0) {
		intent.include = nested.include.map((n) => nestedIncludeToIntent(n));
	}

	return intent as IncludeIntent;
}

/**
 * Parse dot notation include into nested IncludeIntent.
 *
 * @example
 * 'posts.comments.author' becomes:
 * { relation: 'posts', include: [{ relation: 'comments', include: [{ relation: 'author' }] }] }
 */
export function parseDotNotationInclude(
	path: string,
	options?: IncludeOptionsWithRecursive,
): IncludeIntent {
	const parts = path.split('.');
	if (parts.length === 0) {
		throw new Error('Invalid include path');
	}

	// Build from the end (deepest level) to the beginning
	// Options apply to the deepest (last) relation
	const lastPart = parts[parts.length - 1];
	if (!lastPart) {
		throw new Error('Invalid include path: empty segment');
	}
	let current: IncludeIntent = includeOptionsToIntent(lastPart, options);

	// Work backwards through the path, wrapping each level.
	// Propagate the `join` option to intermediate wrappers so the planner
	// picks the join strategy for ALL hops, not just the leaf.
	// Without this, `.include('a.b', {join:'inner'})` produces an outer 'a'
	// with no join → json_agg strategy → 'a' table not in outer FROM →
	// the leaf 'b' JOIN ON clause references a table missing from outer FROM.
	for (let i = parts.length - 2; i >= 0; i--) {
		const part = parts[i];
		if (!part) continue;
		current =
			options?.join !== undefined
				? { relation: part, join: options.join, include: [current] }
				: { relation: part, include: [current] };
	}

	return current;
}

/**
 * Validate recursive include options.
 * Throws InvalidOperationError if:
 * - Relation is not self-referential (source !== target)
 * - Direction is missing
 * - Direction conflicts with relation cardinality
 */
export function validateRecursiveInclude(
	model: ModelIR,
	sourceTable: string,
	relationName: string,
	options: RecursiveIncludeOptions,
): void {
	// Get the relation from the model
	const qualifiedName = `${sourceTable}.${options.via ?? relationName}`;
	const relation = model.getRelation(qualifiedName);

	if (!relation) {
		// Let the planner handle the "relation not found" error
		return;
	}

	// Check if direction is provided (INV-2)
	if (!options.direction) {
		throw new InvalidOperationError(
			'recursive include',
			`'direction' is required when using recursive: true. ` +
				`Use 'ancestors' for parent traversal or 'descendants' for children traversal.`,
		);
	}

	try {
		validateRecursiveIncludeStrategy(
			includeOptionsToIntent(relationName, options),
			relation,
			'include[0]',
			relationName,
			POSTGRESQL_CAPABILITIES,
			undefined,
			undefined,
			false,
			false,
			model,
		);
	} catch (error) {
		throw new InvalidOperationError(
			'recursive include',
			(error as Error).message,
		);
	}
}

// ============================================================================
// RecursiveIncludeConfig
// ============================================================================

/**
 * Configuration for a recursive include.
 * Stores the relation name and recursive options for later processing.
 */
export interface RecursiveIncludeConfig {
	readonly relation: string;
	readonly options: RecursiveIncludeOptions;
}
