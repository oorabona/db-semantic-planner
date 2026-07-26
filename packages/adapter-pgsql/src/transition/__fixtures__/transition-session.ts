import type { TransitionSessionClient } from '@dbsp/types';

/**
 * Adapter unit tests exercise an operation against a query double starting
 * inside core's minting boundary, so this cast does not re-test core's minting
 * contract. Tests of that boundary must keep using acquireTransitionLease.
 */
export function createTestTransitionSession(
	client: Pick<TransitionSessionClient, 'query'>,
): TransitionSessionClient {
	return client as TransitionSessionClient;
}
