import { afterEach, describe, expect, it, vi } from 'vitest';

const { runPlan } = vi.hoisted(() => ({ runPlan: vi.fn() }));
vi.mock('./plan.js', () => ({
	runPlan,
	exitCodeForPlanResult: () => 0,
	formatPlanHuman: () => '',
	formatPlanJson: () => ({}),
}));

import { runNoArgumentApply } from './apply.js';

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
});
