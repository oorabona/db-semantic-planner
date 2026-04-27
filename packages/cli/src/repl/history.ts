/**
 * DX-030 Block 5: Command History
 *
 * Manages command history with persistence to ~/.dbsp_history
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HISTORY_FILE = join(homedir(), '.dbsp_history');
const MAX_HISTORY_SIZE = 1000;

/**
 * Command history manager
 */
export class CommandHistory {
	private history: string[] = [];
	private index = -1;
	private currentInput = '';

	constructor() {
		this.load();
	}

	/**
	 * Load history from file
	 */
	private load(): void {
		try {
			if (existsSync(HISTORY_FILE)) {
				// SEC-5: Tighten permissions on load (fire-and-forget)
				try {
					chmodSync(HISTORY_FILE, 0o600);
				} catch {
					// Best-effort — ignore if we can't chmod (e.g., read-only FS)
				}
				const content = readFileSync(HISTORY_FILE, 'utf-8');
				this.history = content
					.split('\n')
					.filter((line) => line.trim().length > 0)
					// C8: Decode escape sequences written by save(). Reverse order:
					// unescape \\n → \n first, then \\\\ → \.
					.map((line) =>
						line.replace(/\\n/g, '\n').replace(/\\\\/g, '\\'),
					);
			}
		} catch {
			// Ignore load errors, start with empty history
		}
	}

	/**
	 * Save history to file
	 */
	private save(): void {
		try {
			const dir = dirname(HISTORY_FILE);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			// C8: Escape embedded newlines so multiline queries survive the \n-based
			// line separator. Each entry has its \ → \\, then \n → \n-literal before
			// join so load() can reverse the escaping.
			const encoded = this.history
				.map((entry) =>
					entry.replace(/\\/g, '\\\\').replace(/\n/g, '\\n'),
				)
				.join('\n');
			// SEC-5: Write with mode 0600 (user-only read/write)
			writeFileSync(HISTORY_FILE, encoded, {
				encoding: 'utf-8',
				mode: 0o600,
			});
			// Best-effort: chmod after write in case the file pre-existed at a broader
			// permission (e.g., created by another tool at 0644). May throw on
			// non-POSIX filesystems.
			try {
				chmodSync(HISTORY_FILE, 0o600);
			} catch {
				// Best-effort: may throw on non-POSIX filesystems
			}
		} catch {
			// Ignore save errors
		}
	}

	/**
	 * Add a command to history.
	 *
	 * @param command - Command string to record
	 * @param persist - Whether to persist to disk (default: true). Pass false for
	 *   batch-mode queries that should not be saved to ~/.dbsp_history (SEC-13).
	 */
	add(command: string, persist = true): void {
		const trimmed = command.trim();
		if (!trimmed) return;

		// Don't add duplicates of the last command
		if (this.history[this.history.length - 1] === trimmed) return;

		this.history.push(trimmed);

		// Trim history if too large
		if (this.history.length > MAX_HISTORY_SIZE) {
			this.history = this.history.slice(-MAX_HISTORY_SIZE);
		}

		this.resetIndex();
		if (persist) {
			this.save();
		}
	}

	/**
	 * Reset the navigation index
	 */
	resetIndex(): void {
		this.index = -1;
		this.currentInput = '';
	}

	/**
	 * Navigate to previous command (up arrow)
	 * Returns the command to display, or undefined if at start of history
	 */
	previous(currentInput: string): string | undefined {
		// Save current input when starting navigation
		if (this.index === -1) {
			this.currentInput = currentInput;
		}

		if (this.history.length === 0) return undefined;

		// Move up in history
		if (this.index < this.history.length - 1) {
			this.index++;
		}

		return this.history[this.history.length - 1 - this.index];
	}

	/**
	 * Navigate to next command (down arrow)
	 * Returns the command to display, or the saved current input if past history
	 */
	next(): string | undefined {
		if (this.index <= 0) {
			this.index = -1;
			return this.currentInput;
		}

		this.index--;
		return this.history[this.history.length - 1 - this.index];
	}

	/**
	 * Search history for commands containing the query
	 */
	search(query: string): string[] {
		if (!query) return this.history.slice(-10);
		const lower = query.toLowerCase();
		return this.history.filter((cmd) => cmd.toLowerCase().includes(lower));
	}

	/**
	 * CLI-MUT: Reverse incremental search (Ctrl+R functionality)
	 * Returns matches from most recent to oldest
	 */
	reverseSearch(query: string): string[] {
		if (!query) return [];
		const lower = query.toLowerCase();
		// Return matches in reverse order (most recent first)
		return this.history
			.filter((cmd) => cmd.toLowerCase().includes(lower))
			.reverse();
	}

	/**
	 * Get all history entries
	 */
	getAll(): readonly string[] {
		return this.history;
	}

	/**
	 * Get recent history (last N entries)
	 */
	getRecent(count = 10): string[] {
		return this.history.slice(-count);
	}

	/**
	 * Clear all history
	 */
	clear(): void {
		this.history = [];
		this.resetIndex();
		this.save();
	}

	/**
	 * Get total count
	 */
	get length(): number {
		return this.history.length;
	}
}

/**
 * Create a singleton history instance
 */
let historyInstance: CommandHistory | null = null;

export function getHistory(): CommandHistory {
	if (!historyInstance) {
		historyInstance = new CommandHistory();
	}
	return historyInstance;
}
