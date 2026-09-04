import {
	type LedgerAddress,
	REFUSAL_VOCABULARY,
	refusalFor,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { serializeCliJson } from '../utils/output.js';
import { formatApplyHuman } from './apply.js';
import { inspectRefusal, renderInspectHuman } from './inspect.js';
import { formatReconcileHuman } from './reconcile.js';
import { preAppendRefusalFor } from './refusal-output.js';
import { formatReleaseHuman } from './release.js';

const address: LedgerAddress = {
	scope: 'schema',
	engine: 'postgresql',
	database: 'fixture',
	schema: 'public',
	kind: 'table',
	name: 'accounts',
};

/** The channel is contractual: only a durable refused terminal uses inspect. */
const SC64_REFUSAL_CHANNELS = [
	['ERR-01', 'unaccepted non-transactional segment', 'command', 'apply'],
	['ERR-02', 'unadmitted occupied address', 'command', 'apply'],
	['ERR-03', 'older marker', 'command', 'apply'],
	['ERR-03', 'future marker', 'command', 'apply'],
	['ERR-03', 'mixed marker', 'command', 'reconcile'],
	['ERR-03', 'unreadable marker', 'command', 'reconcile'],
	['ERR-03', 'ledger lock error', 'command', 'reconcile'],
	['ERR-04', 'removal containment', 'command', 'apply'],
	['ERR-05', 'recorded identity mismatch', 'inspect', 'inspect'],
	['ERR-06', 'lineage mismatch', 'command', 'release'],
	['ERR-07', 'read-only target', 'command', 'reconcile'],
	['ERR-08', 'malformed ledger chain', 'command', 'reconcile'],
	['ERR-09', 'catalogue unavailable', 'command', 'reconcile'],
	['ERR-10', 'recorded-plan removal', 'command', 'apply'],
] as const;

describe('SC-64 refusal channel matrix', () => {
	it.each(SC64_REFUSAL_CHANNELS)(
		'%s %s is rendered through %s',
		(code, _arm, channel, command) => {
			const state = code === 'ERR-10' ? 'recorded-plan' : 'unknown';
			if (channel === 'inspect') {
				const refusal = inspectRefusal({
					kind: 'projected-ledger-chain',
					ledger: { scope: 'schema', schema: 'public' },
					address,
					events: [
						{
							eventId: 'intent',
							address,
							eventKind: 'intent',
							controller: 'deploy',
						},
						{
							eventId: 'refused',
							address,
							eventKind: 'refused',
							predecessor: 'intent',
							refusal: refusalFor(code, { address, state: 'unknown' }),
							controller: 'deploy',
						},
					],
					stableState: 'unknown',
					reportedState: { kind: 'unknown' },
				});
				if (!refusal) throw new Error('expected a terminal refusal');
				expect(refusal).toMatchObject({
					address,
					state: 'unknown',
					...REFUSAL_VOCABULARY[code],
				});
				expect(
					JSON.parse(
						renderInspectHuman({
							ledger: { scope: 'schema', schema: 'public' },
							marker: { kind: 'current' },
							refusal,
							live: { kind: 'not-requested' },
						}),
					),
				).toMatchObject({ refusal });
				return;
			}

			const refusal = preAppendRefusalFor(code, { address, state });
			const human =
				command === 'apply'
					? formatApplyHuman({ outcome: 'refused', runId: 'run-1', refusal })
					: command === 'release'
						? formatReleaseHuman({
								outcome: 'release-refused',
								detail: REFUSAL_VOCABULARY[code].cause,
								address,
								refusal: refusalFor(
									code as 'ERR-02' | 'ERR-05' | 'ERR-06' | 'ERR-08',
									{ address, state: 'unknown' },
								),
							})
						: formatReconcileHuman({
								outcome: 'reconcile-unresolved',
								runId: 'run-1',
								addresses: [address],
								refusal,
							});
			expect(human).toContain(`address: ${JSON.stringify(address)}`);
			expect(human).toContain(`state: ${state}`);
			expect(human).toContain(
				`withheld authority: ${REFUSAL_VOCABULARY[code].withheldAuthority}`,
			);
			expect(human).toContain(
				`resolving command: ${REFUSAL_VOCABULARY[code].resolvingCommand}`,
			);
			expect(JSON.parse(serializeCliJson({ refusal }))).toMatchObject({
				refusal,
			});
		},
	);
});
