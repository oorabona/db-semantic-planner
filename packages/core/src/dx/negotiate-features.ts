import type {
	DDLFeature,
	DialectCapabilities,
	FeatureBehaviorConfig,
	FeatureWarning,
	ModelIR,
	UnsupportedFeatureBehavior,
} from '@dbsp/types';
import { UnsupportedFeatureError } from '@dbsp/types';
import {
	DEFAULT_FEATURE_CHECKERS,
	type FeatureChecker,
} from './feature-checkers.js';

export type { FeatureChecker, FeatureUsage } from './feature-checkers.js';
export { DEFAULT_FEATURE_CHECKERS } from './feature-checkers.js';

export interface NegotiationResult {
	readonly warnings: readonly FeatureWarning[];
}

/** Resolve effective behavior for a specific feature */
function resolveBehavior(
	feature: DDLFeature,
	config: UnsupportedFeatureBehavior | FeatureBehaviorConfig,
): UnsupportedFeatureBehavior {
	if (typeof config === 'string') return config;
	return config.overrides?.[feature] ?? config.default;
}

/**
 * Cross-check ModelIR features against DialectCapabilities.
 * Emits warnings or throws based on UnsupportedFeatureBehavior.
 *
 * INV-06: MUST NOT modify the ModelIR.
 * ERR-02: error mode throws on FIRST unsupported feature (fail-fast).
 * ERR-03: warning mode collects ALL warnings.
 *
 * OCP-001: extend by adding FeatureChecker entries to DEFAULT_FEATURE_CHECKERS
 * (or pass a custom checkers array) -- no edits to this function required.
 */
export function negotiateFeatures(
	model: ModelIR,
	capabilities: DialectCapabilities,
	behavior: UnsupportedFeatureBehavior | FeatureBehaviorConfig = 'warning',
	checkers: readonly FeatureChecker[] = DEFAULT_FEATURE_CHECKERS,
): NegotiationResult {
	const warnings: FeatureWarning[] = [];
	const adapterName = capabilities.name;

	for (const checker of checkers) {
		if (capabilities[checker.capability]) continue; // supported
		const usages = checker.detectUsage(model);
		if (usages.length === 0) continue; // not used
		const effectiveBehavior = resolveBehavior(checker.feature, behavior);
		if (effectiveBehavior === 'ignore') continue;
		for (const usage of usages) {
			if (effectiveBehavior === 'error') {
				throw new UnsupportedFeatureError(
					checker.feature,
					adapterName,
					usage.detail,
				);
			}
			// warning mode
			const message = `Unsupported feature "${checker.feature}" on adapter "${adapterName}" for "${usage.detail}"`;
			warnings.push({
				feature: checker.feature,
				adapter: adapterName,
				element: usage.detail,
				message,
			});
		}
	}

	return { warnings };
}
