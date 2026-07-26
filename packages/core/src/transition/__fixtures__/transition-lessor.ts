import type { TransitionLessor, TransitionQueryClient } from '@dbsp/types';
import { createTransitionLessor } from '../transition-lessor.js';

/** Test-only convenience wrapper around the production minting boundary. */
export function createTestTransitionLessor(
	acquire: () => Promise<TransitionQueryClient>,
): TransitionLessor {
	return createTransitionLessor(acquire);
}
