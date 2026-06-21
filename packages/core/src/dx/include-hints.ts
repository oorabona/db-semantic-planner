import type { IncludeIntent } from '../intent-ast.js';
import type { RelationHints } from './types.js';

/**
 * Apply relation hint to a single include recursively.
 */
export function applyHintToIncludeRecursive(
	inc: IncludeIntent,
	relationHints: RelationHints,
): IncludeIntent {
	// If already has explicit via, don't override
	if (inc.via !== undefined) {
		// But still process nested includes
		if (inc.include && inc.include.length > 0) {
			return {
				...inc,
				include: inc.include.map((nested) =>
					applyHintToIncludeRecursive(nested, relationHints),
				),
			};
		}
		return inc;
	}

	// Check if we have a hint for this target
	const hint = relationHints[inc.relation];
	const result: IncludeIntent = hint ? { ...inc, via: hint } : inc;

	// Process nested includes
	if (result.include && result.include.length > 0) {
		return {
			...result,
			include: result.include.map((nested) =>
				applyHintToIncludeRecursive(nested, relationHints),
			),
		};
	}

	return result;
}
