import { randomUUID } from 'node:crypto';
import type {
	IssuedObservation,
	ObservationContext,
	TransitionRunMetadata,
} from '@dbsp/types';
import { observationContextDigest } from './context-match.js';
import { semanticArtifactId } from './ids.js';
import type { InProcessProvenPlan } from './index.js';
import { transitionPlanDigest } from './plan-digest.js';
import { stableJson } from './stable-json.js';

/**
 * The planning artifact, rather than the applier, owns metadata for a run that
 * has been proven but not yet executed.  A durable plan must describe the core
 * planner that made its proof; it must not claim that an applier minted it.
 */
const TRANSITION_PLANNER_ARTIFACT = {
	id: semanticArtifactId('dbsp.core.transition.planner'),
	version: '0.1.0',
};

function evidenceContext(
	observations: readonly IssuedObservation[],
): ObservationContext {
	const evidence = observations.filter(
		(observation) => observation.role === 'evidence',
	);
	const first = evidence[0]?.context;
	if (!first) {
		throw new Error(
			'internal error: minted proven plan has no evidence observation context',
		);
	}
	const expected = stableJson(first);
	for (const observation of evidence.slice(1)) {
		if (stableJson(observation.context) !== expected) {
			throw new Error(
				'internal error: minted proven plan evidence observations do not share one context',
			);
		}
	}
	return first;
}

/**
 * Mint metadata for a proven transition before making it durable.
 *
 * The target digest is deliberately derived from the plan's evidence, not a
 * caller-supplied snapshot.  That is the exact context resume verifies.
 */
export function createTransitionRunMetadata(
	plan: InProcessProvenPlan,
): TransitionRunMetadata {
	const context = evidenceContext(plan.observations);
	return {
		runId: `dbsp-${randomUUID()}`,
		planDigest: transitionPlanDigest(plan),
		targetContextDigest: observationContextDigest(context),
		databaseId: context.databaseId,
		coreVersion: TRANSITION_PLANNER_ARTIFACT.version,
		startedAt: new Date().toISOString(),
	};
}
