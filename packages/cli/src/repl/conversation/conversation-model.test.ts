import { describe, expect, it } from 'vitest';
import { ConversationManager } from './conversation-model.js';

describe('ConversationManager', () => {
	it('starts with no entries', () => {
		const manager = new ConversationManager();
		expect(manager.getEntries()).toHaveLength(0);
	});

	it('adds entries with auto-incrementing IDs', () => {
		const manager = new ConversationManager();
		const e1 = manager.addEntry('query 1');
		const e2 = manager.addEntry('query 2');

		expect(e1.id).toBe(1);
		expect(e2.id).toBe(2);
		expect(manager.getEntries()).toHaveLength(2);
	});

	it('entries have timestamp and empty events', () => {
		const manager = new ConversationManager();
		const entry = manager.addEntry('test');

		expect(entry.input).toBe('test');
		expect(entry.timestamp).toBeInstanceOf(Date);
		expect(entry.events).toEqual([]);
	});

	it('appends events to existing entries', () => {
		const manager = new ConversationManager();
		const entry = manager.addEntry('test');

		manager.appendEvent(entry.id, { type: 'info', message: 'hello' });
		manager.appendEvent(entry.id, { type: 'error', message: 'oops' });

		expect(entry.events).toHaveLength(2);
		expect(entry.events[0]).toEqual({ type: 'info', message: 'hello' });
		expect(entry.events[1]).toEqual({ type: 'error', message: 'oops' });
	});

	it('ignores appending to non-existent entry', () => {
		const manager = new ConversationManager();
		manager.appendEvent(999, { type: 'info', message: 'orphan' });
		expect(manager.getEntries()).toHaveLength(0);
	});

	it('clears all entries', () => {
		const manager = new ConversationManager();
		manager.addEntry('a');
		manager.addEntry('b');
		expect(manager.getEntries()).toHaveLength(2);

		manager.clear();
		expect(manager.getEntries()).toHaveLength(0);
	});

	it('caps entries at MAX_ENTRIES (100)', () => {
		const manager = new ConversationManager();

		for (let i = 0; i < 110; i++) {
			manager.addEntry(`query ${i}`);
		}

		expect(manager.getEntries()).toHaveLength(100);
		// Oldest entries removed
		expect(manager.getEntries()[0]!.input).toBe('query 10');
		expect(manager.getEntries()[99]!.input).toBe('query 109');
	});
});
