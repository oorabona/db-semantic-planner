import { type ChildProcess, type ForkOptions, fork } from 'node:child_process';
import { resolve } from 'node:path';
import {
	CHECKPOINT_ACK,
	type CheckpointAckMessage,
	isCheckpointReachedMessage,
} from './checkpoint-child.js';

export interface CheckpointChildOptions {
	readonly args?: readonly string[];
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	/**
	 * The e2e sources are TypeScript. `tsx` is already a root development tool,
	 * so this loader adds no harness dependency.
	 */
	readonly execArgv?: readonly string[];
	/** Start a separate process group when the scenario needs that isolation. */
	readonly detached?: boolean;
}

export interface CheckpointChildExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

/** A live forked child, stopped at at most one acknowledged checkpoint. */
export interface CheckpointChild {
	readonly process: ChildProcess;
	readonly exited: Promise<CheckpointChildExit>;
	/** Wait for the currently-blocked checkpoint; no timeout or polling is used. */
	waitForCheckpoint(expected: string): Promise<void>;
	/** Allow the child to continue from the currently-blocked named checkpoint. */
	acknowledge(checkpoint: string): Promise<void>;
	/**
	 * Wait until the child has reported this exact checkpoint, then send SIGKILL.
	 * The signal is sent only after the IPC receipt, never on a timer.
	 */
	killAtCheckpoint(checkpoint: string): Promise<CheckpointChildExit>;
	/** Kill a child already known to be stopped at a checkpoint. */
	kill(signal?: NodeJS.Signals): Promise<CheckpointChildExit>;
	/** Stop this owned child during cleanup, unless its exit was already observed. */
	terminate(signal?: NodeJS.Signals): Promise<CheckpointChildExit>;
}

function checkpointProtocolError(message: string): Error {
	return new Error(`E2E checkpoint protocol: ${message}`);
}

/**
 * Fork a TypeScript/JavaScript e2e child that imports `checkpoint()` from
 * `checkpoint-child.ts`. The returned control surface makes acknowledgement
 * explicit, so a test cannot accidentally kill before the named receipt.
 */
export function spawnCheckpointChild(
	entrypoint: string,
	options: CheckpointChildOptions = {},
): CheckpointChild {
	const child = fork(resolve(entrypoint), [...(options.args ?? [])], {
		cwd: options.cwd,
		env: options.env,
		execArgv: [...(options.execArgv ?? ['--import', 'tsx'])],
		detached: options.detached,
		stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
	} satisfies ForkOptions);

	let activeCheckpoint: string | undefined;
	let exitState: CheckpointChildExit | undefined;
	let childError: Error | undefined;
	let checkpointWaiter:
		| {
				readonly expected: string;
				readonly resolve: () => void;
				readonly reject: (error: Error) => void;
		  }
		| undefined;
	let exitResolve: ((exit: CheckpointChildExit) => void) | undefined;
	const exited = new Promise<CheckpointChildExit>((resolveExit) => {
		exitResolve = resolveExit;
	});
	const settleExit = (exit: CheckpointChildExit, reason?: Error): void => {
		if (exitState !== undefined) return;
		exitState = exit;
		if (checkpointWaiter !== undefined) {
			checkpointWaiter.reject(
				reason ??
					checkpointProtocolError(
						`child exited before reaching "${checkpointWaiter.expected}" (exit code ${exit.code}, signal ${exit.signal})`,
					),
			);
			checkpointWaiter = undefined;
		}
		exitResolve?.(exit);
	};

	child.on('message', (message: unknown) => {
		if (!isCheckpointReachedMessage(message)) return;
		if (activeCheckpoint !== undefined) {
			checkpointWaiter?.reject(
				checkpointProtocolError(
					`child reached "${message.checkpoint}" while still blocked at "${activeCheckpoint}"`,
				),
			);
			return;
		}
		activeCheckpoint = message.checkpoint;
		if (checkpointWaiter === undefined) return;
		if (checkpointWaiter.expected === activeCheckpoint) {
			checkpointWaiter.resolve();
		} else {
			checkpointWaiter.reject(
				checkpointProtocolError(
					`expected "${checkpointWaiter.expected}" but child reached "${activeCheckpoint}"`,
				),
			);
		}
		checkpointWaiter = undefined;
	});
	child.once('exit', (code, signal) => {
		settleExit({ code, signal });
	});
	child.once('error', (error) => {
		childError = error;
		if (checkpointWaiter !== undefined) {
			checkpointWaiter.reject(error);
			checkpointWaiter = undefined;
		}
	});

	const waitForCheckpoint = async (expected: string): Promise<void> => {
		if (childError !== undefined) throw childError;
		if (activeCheckpoint === expected) return;
		if (activeCheckpoint !== undefined) {
			throw checkpointProtocolError(
				`expected "${expected}" but child is blocked at "${activeCheckpoint}"`,
			);
		}
		if (checkpointWaiter !== undefined) {
			throw checkpointProtocolError(
				`already waiting for "${checkpointWaiter.expected}"`,
			);
		}
		if (exitState !== undefined) {
			throw checkpointProtocolError(
				`child exited before reaching "${expected}" (exit code ${exitState.code}, signal ${exitState.signal})`,
			);
		}
		await new Promise<void>((resolveWait, rejectWait) => {
			checkpointWaiter = {
				expected,
				resolve: resolveWait,
				reject: rejectWait,
			};
		});
	};

	const acknowledge = async (checkpoint: string): Promise<void> => {
		if (childError !== undefined) throw childError;
		if (activeCheckpoint !== checkpoint) {
			throw checkpointProtocolError(
				`cannot acknowledge "${checkpoint}" while child is at "${activeCheckpoint ?? 'no checkpoint'}"`,
			);
		}
		const message: CheckpointAckMessage = {
			type: CHECKPOINT_ACK,
			checkpoint,
		};
		// The child can reach its next checkpoint as soon as it receives this
		// message. Queueing is the acknowledgement boundary; no send callback is
		// involved in checkpoint state, so the next receipt cannot overwrite it.
		activeCheckpoint = undefined;
		try {
			child.send(message);
		} catch (error) {
			if (activeCheckpoint === undefined) activeCheckpoint = checkpoint;
			throw error;
		}
	};

	const kill = async (
		signal: NodeJS.Signals = 'SIGKILL',
	): Promise<CheckpointChildExit> => {
		if (exitState !== undefined) return exitState;
		if (activeCheckpoint === undefined) {
			throw checkpointProtocolError(
				'cannot kill before a checkpoint is acknowledged',
			);
		}
		child.kill(signal);
		return exited;
	};

	const terminate = async (
		signal: NodeJS.Signals = 'SIGTERM',
	): Promise<CheckpointChildExit> => {
		if (exitState !== undefined) return exitState;
		child.kill(signal);
		return exited;
	};

	return {
		process: child,
		exited,
		waitForCheckpoint,
		acknowledge,
		async killAtCheckpoint(checkpoint: string): Promise<CheckpointChildExit> {
			await waitForCheckpoint(checkpoint);
			return kill();
		},
		kill,
		terminate,
	};
}
