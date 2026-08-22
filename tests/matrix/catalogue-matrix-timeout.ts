type MatrixClient = {
	release(error?: unknown): void | Promise<void>;
};

/**
 * Vitest aborts a timed-out test but cannot cancel its promise. Destroy the
 * checked-out client synchronously when that signal fires, so a stuck query
 * cannot retain a lock while Vitest proceeds to the next test or teardown.
 */
export function destroyMatrixClientOnAbort<T extends MatrixClient>(
	executor: { connect(): Promise<T> },
	signal: AbortSignal,
): { connect(): Promise<T> } {
	return {
		async connect() {
			const client = await executor.connect();
			let released = false;
			let releasePromise: Promise<void> | undefined;
			const timeoutError = new Error(
				'catalogue matrix Vitest deadline elapsed; destroying checked-out client',
			);
			const release = (error?: unknown): Promise<void> => {
				if (releasePromise !== undefined) return releasePromise;
				released = true;
				signal.removeEventListener('abort', abort);
				releasePromise = Promise.resolve(client.release(error));
				return releasePromise;
			};
			const abort = () => {
				if (!released) void release(timeoutError);
			};
			signal.addEventListener('abort', abort, { once: true });
			if (signal.aborted) abort();
			return new Proxy(client, {
				get(target, property, receiver) {
					if (property === 'release') return release;
					const value = Reflect.get(target, property, receiver);
					return typeof value === 'function' ? value.bind(target) : value;
				},
			});
		},
	};
}
