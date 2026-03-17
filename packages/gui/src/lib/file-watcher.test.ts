import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebouncedBatcher, createSelfWriteFilter } from './file-watcher';

// ── createDebouncedBatcher ───────────────────────────────────────

describe('createDebouncedBatcher', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('batches events within delay window', () => {
		const callback = vi.fn();
		const batcher = createDebouncedBatcher(callback, 300);

		batcher.push({ type: 'create', paths: ['/a.dbsp'] });
		batcher.push({ type: 'modify', paths: ['/b.dbsp'] });

		expect(callback).not.toHaveBeenCalled();

		vi.advanceTimersByTime(300);

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith([
			{ type: 'create', paths: ['/a.dbsp'] },
			{ type: 'modify', paths: ['/b.dbsp'] },
		]);
	});

	it('flushes immediately on flush()', () => {
		const callback = vi.fn();
		const batcher = createDebouncedBatcher(callback, 300);

		batcher.push({ type: 'create', paths: ['/a.dbsp'] });
		batcher.flush();

		expect(callback).toHaveBeenCalledTimes(1);
	});

	it('does not call callback when flushing empty buffer', () => {
		const callback = vi.fn();
		const batcher = createDebouncedBatcher(callback, 300);

		batcher.flush();
		expect(callback).not.toHaveBeenCalled();
	});

	it('resets timer on new events', () => {
		const callback = vi.fn();
		const batcher = createDebouncedBatcher(callback, 300);

		batcher.push({ type: 'create', paths: ['/a.dbsp'] });
		vi.advanceTimersByTime(200);

		batcher.push({ type: 'modify', paths: ['/b.dbsp'] });
		vi.advanceTimersByTime(200);

		// 400ms total but timer was reset, so not fired yet
		expect(callback).not.toHaveBeenCalled();

		vi.advanceTimersByTime(100);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback.mock.calls[0]![0]).toHaveLength(2);
	});

	it('clears buffer after flush', () => {
		const callback = vi.fn();
		const batcher = createDebouncedBatcher(callback, 300);

		batcher.push({ type: 'create', paths: ['/a.dbsp'] });
		vi.advanceTimersByTime(300);

		// Second batch
		batcher.push({ type: 'modify', paths: ['/c.dbsp'] });
		vi.advanceTimersByTime(300);

		expect(callback).toHaveBeenCalledTimes(2);
		expect(callback.mock.calls[1]![0]).toEqual([
			{ type: 'modify', paths: ['/c.dbsp'] },
		]);
	});

	it('uses default 300ms delay', () => {
		const callback = vi.fn();
		const batcher = createDebouncedBatcher(callback);

		batcher.push({ type: 'create', paths: ['/a.dbsp'] });
		vi.advanceTimersByTime(299);
		expect(callback).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(callback).toHaveBeenCalledTimes(1);
	});
});

// ── createSelfWriteFilter ────────────────────────────────────────

describe('createSelfWriteFilter', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns false for unknown paths', () => {
		const filter = createSelfWriteFilter();
		expect(filter.isSelfWrite('/some/path')).toBe(false);
	});

	it('returns true immediately after markWritten', () => {
		const filter = createSelfWriteFilter(1000);
		filter.markWritten('/a.dbsp');
		expect(filter.isSelfWrite('/a.dbsp')).toBe(true);
	});

	it('returns false after TTL expires', () => {
		const filter = createSelfWriteFilter(1000);
		filter.markWritten('/a.dbsp');

		vi.advanceTimersByTime(1001);
		expect(filter.isSelfWrite('/a.dbsp')).toBe(false);
	});

	it('returns true within TTL window', () => {
		const filter = createSelfWriteFilter(1000);
		filter.markWritten('/a.dbsp');

		vi.advanceTimersByTime(999);
		expect(filter.isSelfWrite('/a.dbsp')).toBe(true);
	});

	it('tracks multiple paths independently', () => {
		const filter = createSelfWriteFilter(1000);
		filter.markWritten('/a.dbsp');
		vi.advanceTimersByTime(500);
		filter.markWritten('/b.dbsp');

		vi.advanceTimersByTime(501);
		// /a expired, /b still valid
		expect(filter.isSelfWrite('/a.dbsp')).toBe(false);
		expect(filter.isSelfWrite('/b.dbsp')).toBe(true);
	});
});
