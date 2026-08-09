import { createHash } from 'node:crypto';
import type { ProvenPlanShape } from '@dbsp/types';
import { stableJson } from './stable-json.js';
import { validateNormalizedManagedStepManifest } from './validation.js';

function hasManagedStepShape(steps: unknown): boolean {
	return (
		Array.isArray(steps) &&
		steps.length > 0 &&
		steps.every((step) => {
			const candidate = step as unknown as Record<string, unknown>;
			return (
				typeof candidate.stepKey === 'string' &&
				typeof candidate.order === 'number' &&
				'statementBundle' in candidate
			);
		})
	);
}

/**
 * Canonical digest used to bind a durable transition run to its proven plan.
 */
export function transitionPlanDigest(plan: ProvenPlanShape): string {
	const normalized = hasManagedStepShape(plan.steps)
		? (() => {
				const validation = validateNormalizedManagedStepManifest(
					plan.steps as unknown as readonly import('@dbsp/types').NormalizedManagedStep[],
				);
				if (!validation.ok)
					throw new Error(
						`cannot digest invalid managed-step manifest: ${validation.detail}`,
					);
				return { ...plan, steps: validation.manifest.steps };
			})()
		: plan;
	return createHash('sha256').update(stableJson(normalized)).digest('hex');
}
