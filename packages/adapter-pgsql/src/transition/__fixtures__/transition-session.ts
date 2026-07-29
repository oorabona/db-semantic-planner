import type { TransitionSessionClient } from '@dbsp/types';

/**
 * Adapter unit tests exercise an operation against a query double starting
 * inside core's minting boundary, so this cast does not re-test core's minting
 * contract. Tests of that boundary must keep using acquireTransitionLease.
 */
export function createTestTransitionSession(
	client: Pick<TransitionSessionClient, 'query'>,
): TransitionSessionClient {
	return {
		query(sql: string, params?: unknown) {
			if (sql === "SET client_encoding TO 'UTF8'")
				return Promise.resolve({ rows: [] });
			if (sql === 'SHOW client_encoding')
				return Promise.resolve({ rows: [{ client_encoding: 'UTF8' }] });
			return client.query(sql, params);
		},
	} as TransitionSessionClient;
}
