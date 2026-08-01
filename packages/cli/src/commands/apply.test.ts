import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { semanticArtifactId } from '@dbsp/core';
import type { ApplyResult } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import {
	APPLY_OUTCOME_CONTRACT,
	authorizationDigest,
	canonicalApplyPolicy,
	effectiveApplyPolicy,
	exitCodeForApplyOutcome,
	hasReusableAuthorization,
	outcomeForApplyResult,
	policyDigest,
	runApply,
	validateAssumptionAcceptance,
	withPoolCleanupReported,
} from './apply.js';

type TestOutcomeReasonCode =
	| 'operation-failed-not-applied'
	| 'partially-applied'
	| 'unknown-step-result'
	| 'guard-failed'
	| 'guard-timeout'
	| 'context-mismatch';

function result(
	lifecycle: ApplyResult['assessment']['lifecycle'],
	code: TestOutcomeReasonCode,
): ApplyResult {
	const operationKind = {
		artifact: { id: semanticArtifactId('dbsp.test.apply'), version: '0.1.0' },
		name: 'TestOperation',
	};
	const step = {
		stepId: 'step:test',
		operationKind,
		operationRef: 'test-operation',
		scope: [],
	};
	const reason =
		code === 'context-mismatch'
			? {
					code,
					artifact: operationKind.artifact,
					fact: { key: 'test-context', value: 'mismatch' },
					scope: [],
				}
			: code === 'guard-timeout'
				? { code, ...step, maxWaitMs: 1 }
				: code === 'guard-failed'
					? { code, ...step, recovery: [] }
					: { code, ...step };
	return {
		assessment: {
			decision: 'blocked',
			assurance: 'unproven',
			lifecycle,
			continuation: 'none',
			reasons: [reason],
		},
		journals: [],
		observations: [],
	};
}

describe('dbsp apply contract and policy', () => {
	it('mutation: collapsing outcome exit codes is caught by the public contract table', () => {
		const codes = APPLY_OUTCOME_CONTRACT.map(([, code]) => code);
		expect(new Set(codes).size).toBe(codes.length);
		for (const [outcome, code] of APPLY_OUTCOME_CONTRACT)
			expect(exitCodeForApplyOutcome(outcome)).toBe(code);
	});

	it('mutation: describing transactional refusal as an enum visibility limitation misstates the durable boundary', () => {
		expect(APPLY_OUTCOME_CONTRACT).toContainEqual([
			'transactional-only-refusal',
			17,
			'durable apply executes transactional segments and refuses operations that forbid a transaction block',
		]);
	});

	it.each([
		['operation-failed-not-applied', 'planned', 'operation-failed-not-applied'],
		['partially-applied', 'partially-applied', 'partially-applied'],
		['unknown-step-result', 'outcome-unknown', 'unknown-step-result'],
		['guard-failed', 'planned', 'guard-failed'],
		['guard-timeout', 'planned', 'guard-timeout'],
		['context-mismatch', 'planned', 'context-mismatch'],
	] as const)('mutation: remapping core %s loses its stable CLI outcome', (_name, lifecycle, code) => {
		expect(outcomeForApplyResult(result(lifecycle, code))).toBe(code);
	});

	it.each([
		'guard-failed',
		'guard-timeout',
		'context-mismatch',
		'operation-failed-not-applied',
	] as const)('mutation: reporting a later %s hides an earlier committed segment', (code) => {
		expect(outcomeForApplyResult(result('partially-applied', code))).toBe(
			'partially-applied',
		);
	});

	it('mutation: accepting a misspelled trust-root field is rejected with its entry path', () => {
		expect(() =>
			validateAssumptionAcceptance(
				{
					class: 'manual-proof',
					fromTrustRoot: { kind: 'human', identitty: 'operator' },
				},
				'acceptance[3]',
			),
		).toThrow('acceptance[3].fromTrustRoot.identitty');
	});

	it('mutation: accepting malformed nested scope is rejected with its entry path', () => {
		expect(() =>
			validateAssumptionAcceptance(
				{
					class: 'manual-proof',
					withinScope: [{ within: { engine: 'postgresql', database: 'db' } }],
				},
				'acceptance[1]',
			),
		).toThrow('acceptance[1].withinScope[0].within.kind');
	});

	it('mutation: policy digest changes with object spelling or duplicate selector order', () => {
		const first = canonicalApplyPolicy([
			{
				class: 'manual-proof',
				withinScope: [
					{ schema: 'public', kind: 'table' },
					{ schema: 'audit', kind: 'table' },
					{ schema: 'public', kind: 'table' },
				],
			},
		]);
		const second = canonicalApplyPolicy([
			{
				withinScope: [
					{ kind: 'table', schema: 'audit' },
					{ kind: 'table', schema: 'public' },
				],
				class: 'manual-proof',
			},
		]);
		expect(first).toEqual(second);
		expect(policyDigest(first)).toBe(policyDigest(second));
	});

	it('mutation: treating file and repeated --accept as overwrite instead of set union loses a grant', () => {
		const merged = canonicalApplyPolicy([
			{ class: 'file-grant' },
			{ class: 'command-grant' },
			{ class: 'file-grant' },
		]);
		expect(merged).toEqual([
			{ class: 'command-grant' },
			{ class: 'file-grant' },
		]);
	});

	it('mutation: allowing apply without the review anchor can reach authorization or DDL', async () => {
		await expect(
			runApply('run-reviewed', { db: 'postgres://must-not-connect' }),
		).resolves.toEqual({
			outcome: 'plan-digest-required',
			runId: 'run-reviewed',
		});
	});

	it('reports a rejecting pool cleanup beside a successful apply outcome', async () => {
		const close = vi.fn(async () => {
			throw new Error('pool shutdown failed');
		});
		await expect(
			withPoolCleanupReported(
				{ outcome: 'completed' as const, runId: 'run-1' },
				close,
			),
		).resolves.toEqual({
			outcome: 'completed',
			runId: 'run-1',
			cleanupError: 'database pool cleanup failed: pool shutdown failed',
		});
		expect(close).toHaveBeenCalledOnce();
	});

	it('mutation: reusing an authorization from another run replays approval across run ids', () => {
		const policy = [{ class: 'manual-proof' }] as const;
		const grants = [{ assumptionId: 'assumption:1', grant: 0 }] as const;
		const record = {
			policy,
			grants,
			actor: 'operator',
			authorizedAt: '2026-07-29T00:00:00.000Z',
			digest: authorizationDigest(
				'run-reviewed',
				'plan-digest',
				policy,
				grants,
				'operator',
				'2026-07-29T00:00:00.000Z',
			),
		};
		expect(
			hasReusableAuthorization(
				[record],
				'another-run',
				'plan-digest',
				policy,
				grants,
			),
		).toBe(false);
	});

	it('mutation: rejecting a matching authorization breaks a retry before any step intent', () => {
		const policy = [{ class: 'manual-proof' }] as const;
		const grants = [{ assumptionId: 'assumption:1', grant: 0 }] as const;
		const record = {
			policy,
			grants,
			actor: 'operator',
			authorizedAt: '2026-07-29T00:00:00.000Z',
			digest: authorizationDigest(
				'run-reviewed',
				'plan-digest',
				policy,
				grants,
				'operator',
				'2026-07-29T00:00:00.000Z',
			),
		};
		expect(
			hasReusableAuthorization(
				[record],
				'run-reviewed',
				'plan-digest',
				policy,
				grants,
			),
		).toBe(true);
	});

	it('refuses reuse when the stored policy is corrupted despite an intact digest', () => {
		const policy = [{ class: 'manual-proof' }] as const;
		const grants = [{ assumptionId: 'assumption:1', grant: 0 }] as const;
		const record = {
			policy: [{ class: 'corrupted-policy' }] as const,
			grants,
			actor: 'operator',
			authorizedAt: '2026-07-29T00:00:00.000Z',
			digest: authorizationDigest(
				'run-reviewed',
				'plan-digest',
				policy,
				grants,
				'operator',
				'2026-07-29T00:00:00.000Z',
			),
		};
		expect(
			hasReusableAuthorization(
				[record],
				'run-reviewed',
				'plan-digest',
				policy,
				grants,
			),
		).toBe(false);
	});

	it('mutation: ignoring a valid policy file or replacing it with --accept loses one source', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'dbsp-apply-policy-'));
		const file = join(directory, 'policy.json');
		try {
			await writeFile(file, JSON.stringify([{ class: 'file-grant' }]));
			await expect(
				effectiveApplyPolicy({
					db: 'postgres://unused',
					acceptPolicy: file,
					accept: ['command-grant', 'file-grant'],
				}),
			).resolves.toEqual({
				accepts: [{ class: 'command-grant' }, { class: 'file-grant' }],
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
