import { createHash } from 'node:crypto';
import type { ProvenPlanShape } from '@dbsp/types';
import { stableJson } from './stable-json.js';

/**
 * Canonical digest used to bind a durable transition run to its proven plan.
 */
export function transitionPlanDigest(plan: ProvenPlanShape): string {
	return createHash('sha256').update(stableJson(plan)).digest('hex');
}
