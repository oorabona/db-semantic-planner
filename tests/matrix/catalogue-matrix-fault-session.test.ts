import { describe, expect, it, vi } from 'vitest';
import { sessionWithPresentNull } from './catalogue-matrix-fault-session.js';
import { destroyMatrixClientOnAbort } from './catalogue-matrix-timeout.js';

describe('catalogue matrix fault-injection session', () => {
	it('forwards the release error so unsafe failures evict the physical client', async () => {
		const release = vi.fn();
		const session = sessionWithPresentNull(
			{
				connect: async () => ({
					query: async () => ({ rows: [] }),
					release,
				}),
			},
			'key_count',
			() => true,
		);
		const client = await session.connect();
		const failure = new Error('unsafe verification failure');
		await client.release(failure);
		expect(release).toHaveBeenCalledWith(failure);
	});

	it('destroys a checked-out client when Vitest aborts a timed-out test', async () => {
		const controller = new AbortController();
		const release = vi.fn();
		const executor = destroyMatrixClientOnAbort(
			{
				connect: async () => ({
					query: async () => ({ rows: [] }),
					release,
				}),
			},
			controller.signal,
		);
		await executor.connect();

		controller.abort();

		expect(release).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledWith(expect.any(Error));
	});
});
