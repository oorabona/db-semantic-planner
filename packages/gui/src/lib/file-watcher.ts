/**
 * File watcher abstraction — testable interface + Tauri implementation.
 *
 * Features: 300ms debounce, self-write filter, event batching.
 */

// ── Types ────────────────────────────────────────────────────────

export type WatchEventType = 'create' | 'modify' | 'remove';

export interface WatchEvent {
	readonly type: WatchEventType;
	readonly paths: readonly string[];
}

export type WatchCallback = (events: readonly WatchEvent[]) => void;

/** Abstraction over file system watchers for testability. */
export interface FileWatcher {
	start(paths: readonly string[], callback: WatchCallback): Promise<void>;
	stop(): Promise<void>;
}

// ── Debounced batcher ────────────────────────────────────────────

export function createDebouncedBatcher(
	callback: WatchCallback,
	delayMs = 300,
): { push: (event: WatchEvent) => void; flush: () => void } {
	let buffer: WatchEvent[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;

	function flush() {
		if (buffer.length === 0) return;
		const batch = [...buffer];
		buffer = [];
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		callback(batch);
	}

	function push(event: WatchEvent) {
		buffer.push(event);
		if (timer) clearTimeout(timer);
		timer = setTimeout(flush, delayMs);
	}

	return { push, flush };
}

// ── Self-write filter ────────────────────────────────────────────

/**
 * Tracks paths we recently wrote to, so we can ignore the watcher
 * events triggered by our own saves.
 */
export function createSelfWriteFilter(ttlMs = 1000) {
	const recentWrites = new Map<string, number>();

	function markWritten(path: string) {
		recentWrites.set(path, Date.now());
	}

	function isSelfWrite(path: string): boolean {
		const ts = recentWrites.get(path);
		if (!ts) return false;
		if (Date.now() - ts > ttlMs) {
			recentWrites.delete(path);
			return false;
		}
		return true;
	}

	return { markWritten, isSelfWrite };
}

// ── Tauri implementation ─────────────────────────────────────────

/** Map Tauri v2 watch event type objects to our enum. */
function mapEventType(raw: unknown): WatchEventType | null {
	if (typeof raw === 'object' && raw !== null) {
		const key = Object.keys(raw)[0];
		if (key === 'create') return 'create';
		if (key === 'modify') return 'modify';
		if (key === 'remove') return 'remove';
	}
	if (typeof raw === 'string') {
		if (raw === 'create') return 'create';
		if (raw === 'modify') return 'modify';
		if (raw === 'remove') return 'remove';
	}
	return null;
}

export class TauriFileWatcher implements FileWatcher {
	private unlisten: (() => void) | null = null;
	private batcher: ReturnType<typeof createDebouncedBatcher> | null = null;

	async start(
		paths: readonly string[],
		callback: WatchCallback,
	): Promise<void> {
		await this.stop();

		const { watch } = await import('@tauri-apps/plugin-fs');

		this.batcher = createDebouncedBatcher(callback);
		const batcher = this.batcher;

		this.unlisten = await watch(
			[...paths],
			(event) => {
				const raw = event as unknown as Record<string, unknown>;
				const type = mapEventType(raw.type);
				const rawPaths = raw.paths as string[] | undefined;
				if (type && rawPaths && rawPaths.length > 0) {
					batcher.push({ type, paths: rawPaths });
				}
			},
			{ recursive: true },
		);
	}

	async stop(): Promise<void> {
		this.batcher?.flush();
		this.unlisten?.();
		this.unlisten = null;
		this.batcher = null;
	}
}
