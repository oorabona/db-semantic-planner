import { afterEach, describe, expect, it, vi } from 'vitest';

const { runPlan } = vi.hoisted(() => ({ runPlan: vi.fn() }));
const { runGeneratorPlan } = vi.hoisted(() => ({ runGeneratorPlan: vi.fn() }));
vi.mock('./plan.js', () => ({
	runPlan,
	exitCodeForPlanResult: () => 0,
	formatPlanHuman: () => '',
	formatPlanJson: () => ({}),
}));
vi.mock('./generator-plan.js', () => ({ runGeneratorPlan }));

import { serializeCliJson } from '../utils/output.js';
import {
	formatApplyHuman,
	type runApply,
	runNoArgumentApply,
} from './apply.js';

const provenPlan = {
	compareKind: 'changes',
	proveKind: 'proven',
	assessment: {
		decision: 'applicable',
		assurance: 'established',
		lifecycle: 'planned',
		continuation: 'none',
		reasons: [],
	},
	persisted: true,
	runId: 'run-1',
	planDigest: 'digest-1',
} as const;

describe('no-argument apply pipeline', () => {
	afterEach(() => vi.restoreAllMocks());

	it('presents a non-persistent dry run without requesting confirmation', async () => {
		runPlan.mockResolvedValue({
			...provenPlan,
			persisted: false,
			runId: null,
			planDigest: null,
		});
		const confirm = vi.fn();
		const result = await runNoArgumentApply(
			{ db: 'postgres://test', schemaFile: 'schema.ts', dryRun: true },
			confirm,
		);
		expect(result.outcome).toBe('dry-run');
		expect(runPlan).toHaveBeenCalledWith(
			expect.objectContaining({ dryRun: true }),
		);
		expect(confirm).not.toHaveBeenCalled();
	});

	it('fails closed before prompting when a persisted plan is run without a TTY', async () => {
		runPlan.mockResolvedValue(provenPlan);
		const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
		Object.defineProperty(process.stdin, 'isTTY', {
			configurable: true,
			value: false,
		});
		try {
			const confirm = vi.fn();
			const result = await runNoArgumentApply(
				{ db: 'postgres://test', schemaFile: 'schema.ts' },
				confirm,
			);
			expect(result.outcome).toBe('confirmation-required');
			expect(confirm).not.toHaveBeenCalled();
		} finally {
			if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
			else delete (process.stdin as { isTTY?: boolean }).isTTY;
		}
	});

	it('keeps a declined durable run and its presented digest retrievable', async () => {
		runPlan.mockResolvedValue(provenPlan);
		const execute = vi.fn(async () => ({
			outcome: 'completed' as const,
			runId: 'run-1',
			result: {} as never,
		}));
		const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
		Object.defineProperty(process.stdin, 'isTTY', {
			configurable: true,
			value: true,
		});
		try {
			const result = await runNoArgumentApply(
				{ db: 'postgres://test', schemaFile: 'schema.ts' },
				async () => false,
				execute,
			);
			expect(result).toMatchObject({
				outcome: 'confirmation-declined',
				runId: 'run-1',
				planDigest: 'digest-1',
			});
			expect(execute).not.toHaveBeenCalled();
		} finally {
			if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
			else delete (process.stdin as { isTTY?: boolean }).isTTY;
		}
	});

	it('presents the persisted plan before it asks the interactive attacker to confirm it', async () => {
		runPlan.mockResolvedValue(provenPlan);
		const order: string[] = [];
		const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
		Object.defineProperty(process.stdin, 'isTTY', {
			configurable: true,
			value: true,
		});
		try {
			await runNoArgumentApply(
				{ db: 'postgres://test', schemaFile: 'schema.ts' },
				async () => {
					order.push('confirm');
					return false;
				},
				undefined,
				() => order.push('present'),
			);
			expect(order).toEqual(['present', 'confirm']);
		} finally {
			if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
			else delete (process.stdin as { isTTY?: boolean }).isTTY;
		}
	});

	it('--yes executes only after the planner returned its durable run', async () => {
		runPlan.mockResolvedValue(provenPlan);
		const execute = vi.fn(async () => ({
			outcome: 'completed' as const,
			runId: 'run-1',
			result: {} as never,
		}));
		const result = await runNoArgumentApply(
			{ db: 'postgres://test', schemaFile: 'schema.ts', yes: true },
			async () => {
				throw new Error('confirmation must be bypassed by --yes');
			},
			execute,
		);
		expect(execute).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({ planDigest: 'digest-1' }),
		);
		expect(result.outcome).toBe('completed');
	});

	it.each([
		{
			outcome: 'recovery-required' as const,
			claimId: 'generator-open-claim',
			detail: 'generator sender disconnected',
		},
		{
			outcome: 'transport-ambiguous' as const,
			detail: 'generator commit acknowledgement lost',
		},
	] as const)(
		'keeps unresolved generator fields native through no-argument JSON and text output',
		async (execution) => {
			runPlan.mockResolvedValue(provenPlan);
			const execute: typeof runApply = async () => {
				switch (execution.outcome) {
					case 'recovery-required':
						return {
							outcome: execution.outcome,
							runId: 'run-1',
							result: execution,
						};
					case 'transport-ambiguous':
						return {
							outcome: execution.outcome,
							runId: 'run-1',
							result: execution,
						};
				}
			};
			const result = await runNoArgumentApply(
				{ db: 'postgres://test', schemaFile: 'schema.ts', yes: true },
				async () => true,
				execute,
			);
			if (!('result' in result)) throw new Error('expected apply result');
			const document = JSON.parse(
				serializeCliJson({
					outcome: result.outcome,
					runId: result.runId,
					planDigest: result.planDigest,
					apply: result.result,
				}),
			) as { readonly apply: { readonly result: Record<string, unknown> } };
			expect(document.apply.result).toMatchObject(execution);
			expect(document.apply.result).not.toHaveProperty('assessment');
			expect(formatApplyHuman(result.result)).toContain(
				`detail: ${execution.detail}`,
			);
			expect(formatApplyHuman(result.result)).toContain(
				'resolving command: dbsp reconcile --db <database> run-1',
			);
			if (execution.outcome === 'recovery-required')
				expect(formatApplyHuman(result.result)).toContain(
					`claim: ${execution.claimId}`,
				);
		},
	);

	it('does not send a blocked capability refusal to the generator planner', async () => {
		const capabilityBlocked = {
			...provenPlan,
			compareKind: 'transitions' as const,
			proveKind: 'blocked' as const,
			persisted: false as const,
			runId: null,
			planDigest: null,
			assessment: {
				decision: 'blocked' as const,
				assurance: 'unproven' as const,
				lifecycle: 'planned' as const,
				continuation: 'replan-required' as const,
				reasons: [
					{
						code: 'unsupported-transition' as const,
						changes: [],
						scope: [],
						detail: 'dialect capability is unavailable',
					},
				],
			},
		};
		runPlan.mockResolvedValue(capabilityBlocked);
		const result = await runNoArgumentApply({
			db: 'postgres://test',
			schemaFile: 'schema.ts',
		});
		expect(result.outcome).toBe('not-executable');
		expect(runGeneratorPlan).not.toHaveBeenCalled();
	});
});
