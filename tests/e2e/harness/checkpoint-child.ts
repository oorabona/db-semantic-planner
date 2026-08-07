/**
 * IPC endpoint used by an e2e child process.
 *
 * A checkpoint deliberately has no timeout. Once it has announced itself, the
 * child cannot make further progress until its parent acknowledges that exact
 * checkpoint (or sends SIGKILL).
 */

export const CHECKPOINT_REACHED = 'checkpoint-reached' as const;
export const CHECKPOINT_ACK = 'checkpoint-ack' as const;

export interface CheckpointReachedMessage {
	readonly type: typeof CHECKPOINT_REACHED;
	readonly checkpoint: string;
}

export interface CheckpointAckMessage {
	readonly type: typeof CHECKPOINT_ACK;
	readonly checkpoint: string;
}

export type CheckpointMessage = CheckpointReachedMessage | CheckpointAckMessage;

export function isCheckpointReachedMessage(
	message: unknown,
): message is CheckpointReachedMessage {
	return (
		typeof message === 'object' &&
		message !== null &&
		(message as { type?: unknown }).type === CHECKPOINT_REACHED &&
		typeof (message as { checkpoint?: unknown }).checkpoint === 'string'
	);
}

export function isCheckpointAckMessage(
	message: unknown,
): message is CheckpointAckMessage {
	return (
		typeof message === 'object' &&
		message !== null &&
		(message as { type?: unknown }).type === CHECKPOINT_ACK &&
		typeof (message as { checkpoint?: unknown }).checkpoint === 'string'
	);
}

/**
 * Report a named protocol point and wait for the parent to acknowledge it.
 *
 * This function is intentionally only valid in a process spawned with
 * `child_process.fork`: a direct invocation would make the acknowledgement
 * guarantee meaningless.
 */
export async function checkpoint(name: string): Promise<void> {
	if (name.length === 0) {
		throw new Error('E2E checkpoint names must not be empty');
	}
	const send = process.send;
	if (typeof send !== 'function' || !process.connected) {
		throw new Error(
			`E2E checkpoint "${name}" requires a child_process.fork IPC channel`,
		);
	}

	await new Promise<void>((resolve, reject) => {
		const onMessage = (message: unknown): void => {
			if (!isCheckpointAckMessage(message) || message.checkpoint !== name) {
				return;
			}
			cleanup();
			resolve();
		};
		const onDisconnect = (): void => {
			cleanup();
			reject(
				new Error(
					`E2E checkpoint "${name}" lost its parent before acknowledgement`,
				),
			);
		};
		const cleanup = (): void => {
			process.off('message', onMessage);
			process.off('disconnect', onDisconnect);
		};

		process.on('message', onMessage);
		process.once('disconnect', onDisconnect);
		try {
			send.call(
				process,
				{ type: CHECKPOINT_REACHED, checkpoint: name },
				(error) => {
					if (error === null || error === undefined) return;
					cleanup();
					reject(error);
				},
			);
		} catch (error) {
			cleanup();
			reject(error);
		}
	});
}
