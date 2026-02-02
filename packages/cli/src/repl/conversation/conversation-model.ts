/**
 * Conversation Model — manages the scrollable history of REPL entries.
 *
 * Each entry captures user input and all engine events that resulted from it.
 * The conversation stacks entries (like Claude Code's terminal) rather than
 * replacing the previous result.
 */

import type { EngineEvent } from '../engine/engine-types.js';

/** Maximum number of entries kept in memory. */
const MAX_ENTRIES = 100;

export interface ConversationEntry {
	id: number;
	timestamp: Date;
	input: string;
	events: EngineEvent[];
}

export class ConversationManager {
	private entries: ConversationEntry[] = [];
	private nextId = 1;

	/** Create a new entry for user input. Returns the entry for event appending. */
	addEntry(input: string): ConversationEntry {
		const entry: ConversationEntry = {
			id: this.nextId++,
			timestamp: new Date(),
			input,
			events: [],
		};
		this.entries.push(entry);

		// Cap history
		if (this.entries.length > MAX_ENTRIES) {
			this.entries.splice(0, this.entries.length - MAX_ENTRIES);
		}

		return entry;
	}

	/** Append an event to an existing entry. */
	appendEvent(entryId: number, event: EngineEvent): void {
		const entry = this.entries.find((e) => e.id === entryId);
		if (entry) {
			entry.events.push(event);
		}
	}

	/** Get all entries (readonly). */
	getEntries(): readonly ConversationEntry[] {
		return this.entries;
	}

	/** Clear all entries. */
	clear(): void {
		this.entries = [];
	}
}
