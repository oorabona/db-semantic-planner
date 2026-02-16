/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { useLogStore } from './log-store';

describe('useLogStore', () => {
	afterEach(() => {
		useLogStore.getState().clear();
	});

	it('should start with empty entries', () => {
		expect(useLogStore.getState().entries).toEqual([]);
	});

	it('should add an entry with timestamp, level, source, message', () => {
		useLogStore.getState().addEntry('info', 'sidecar', 'hello');
		const entries = useLogStore.getState().entries;
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			level: 'info',
			source: 'sidecar',
			message: 'hello',
		});
		expect(entries[0]!.id).toBeGreaterThan(0);
		expect(entries[0]!.timestamp).toBeGreaterThan(0);
	});

	it('should preserve insertion order', () => {
		const { addEntry } = useLogStore.getState();
		addEntry('info', 'sidecar', 'first');
		addEntry('warn', 'ipc', 'second');
		addEntry('error', 'app', 'third');

		const entries = useLogStore.getState().entries;
		expect(entries).toHaveLength(3);
		expect(entries.map((e) => e.message)).toEqual(['first', 'second', 'third']);
	});

	it('should evict oldest entries when exceeding 500', () => {
		const { addEntry } = useLogStore.getState();
		for (let i = 0; i < 510; i++) {
			addEntry('info', 'sidecar', `msg-${i}`);
		}

		const entries = useLogStore.getState().entries;
		expect(entries).toHaveLength(500);
		// Oldest (msg-0 through msg-9) should be evicted
		expect(entries[0]!.message).toBe('msg-10');
		expect(entries[499]!.message).toBe('msg-509');
	});

	it('should clear all entries', () => {
		useLogStore.getState().addEntry('info', 'sidecar', 'hello');
		expect(useLogStore.getState().entries).toHaveLength(1);

		useLogStore.getState().clear();
		expect(useLogStore.getState().entries).toEqual([]);
	});
});
