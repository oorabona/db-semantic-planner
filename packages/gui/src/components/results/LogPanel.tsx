/**
 * Application log panel — displays sidecar stderr, IPC, and app logs.
 * Features: level/source filters, text search, export, timestamps.
 * Auto-scrolls to bottom on new entries.
 */
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { Download, Search, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogEntry, LogLevel, LogState } from '@/stores/log-store';
import { useLogStore } from '@/stores/log-store';

// ── Constants ─────────────────────────────────────────────────

const ALL_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const ALL_SOURCES: LogEntry['source'][] = ['sidecar', 'ipc', 'app'];

const LEVEL_COLORS: Record<LogLevel, string> = {
	info: 'text-blue-500',
	warn: 'text-yellow-500',
	error: 'text-red-500',
	debug: 'text-muted-foreground',
};

const SOURCE_LABELS: Record<LogEntry['source'], string> = {
	sidecar: 'sidecar',
	ipc: 'ipc',
	app: 'app',
};

// ── Helpers ───────────────────────────────────────────────────

function formatTime(ts: number): string {
	const d = new Date(ts);
	const h = String(d.getHours()).padStart(2, '0');
	const m = String(d.getMinutes()).padStart(2, '0');
	const s = String(d.getSeconds()).padStart(2, '0');
	return `${h}:${m}:${s}`;
}

function durationColor(ms: number): string {
	if (ms < 100) return 'text-green-600 dark:text-green-400';
	if (ms < 1000) return 'text-yellow-600 dark:text-yellow-400';
	return 'text-red-600 dark:text-red-400';
}

// ── Filter bar ────────────────────────────────────────────────

function FilterBar() {
	const filter = useLogStore((s) => s.filter);
	const setFilter = useLogStore((s) => s.setFilter);
	const [searchInput, setSearchInput] = useState(filter.search ?? '');
	const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const handleLevelChange = useCallback(
		(e: React.ChangeEvent<HTMLSelectElement>) => {
			const value = e.target.value;
			setFilter({
				levels: value === '' ? undefined : [value as LogLevel],
			});
		},
		[setFilter],
	);

	const handleSourceChange = useCallback(
		(e: React.ChangeEvent<HTMLSelectElement>) => {
			const value = e.target.value;
			setFilter({
				sources: value === '' ? undefined : [value as LogEntry['source']],
			});
		},
		[setFilter],
	);

	const handleSearchChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const value = e.target.value;
			setSearchInput(value);
			// Debounce search by 300ms
			if (searchTimer.current) clearTimeout(searchTimer.current);
			searchTimer.current = setTimeout(() => {
				setFilter({ search: value || undefined });
			}, 300);
		},
		[setFilter],
	);

	const clearSearch = useCallback(() => {
		setSearchInput('');
		setFilter({ search: undefined });
	}, [setFilter]);

	return (
		<div className="flex items-center gap-2">
			{/* Level filter */}
			<select
				className="h-6 rounded border border-input bg-transparent px-1 text-xs"
				value={filter.levels?.[0] ?? ''}
				onChange={handleLevelChange}
				title="Filter by level"
			>
				<option value="">All levels</option>
				{ALL_LEVELS.map((l) => (
					<option key={l} value={l}>
						{l}
					</option>
				))}
			</select>

			{/* Source filter */}
			<select
				className="h-6 rounded border border-input bg-transparent px-1 text-xs"
				value={filter.sources?.[0] ?? ''}
				onChange={handleSourceChange}
				title="Filter by source"
			>
				<option value="">All sources</option>
				{ALL_SOURCES.map((s) => (
					<option key={s} value={s}>
						{SOURCE_LABELS[s]}
					</option>
				))}
			</select>

			{/* Text search */}
			<div className="relative flex items-center">
				<Search className="absolute left-1 h-3 w-3 text-muted-foreground" />
				<input
					type="text"
					className="h-6 w-36 rounded border border-input bg-transparent pl-5 pr-5 text-xs placeholder:text-muted-foreground"
					placeholder="Search..."
					value={searchInput}
					onChange={handleSearchChange}
				/>
				{searchInput && (
					<button
						type="button"
						className="absolute right-1 text-muted-foreground hover:text-foreground"
						onClick={clearSearch}
						title="Clear search"
					>
						<X className="h-3 w-3" />
					</button>
				)}
			</div>
		</div>
	);
}

// ── Export handler ─────────────────────────────────────────────

async function handleExport(exportLogs: LogState['exportLogs']) {
	const entries = await exportLogs();
	if (entries.length === 0) return;

	const path = await save({
		title: 'Export Logs',
		defaultPath: `logs-${new Date().toISOString().slice(0, 10)}.json`,
		filters: [
			{ name: 'JSON', extensions: ['json'] },
			{ name: 'CSV', extensions: ['csv'] },
		],
	});
	if (!path) return;

	let content: string;
	if (path.endsWith('.csv')) {
		const header = 'id,timestamp,level,source,message,durationMs';
		const rows = entries.map(
			(e) =>
				`${e.id},${new Date(e.timestamp).toISOString()},${e.level},${e.source},"${e.message.replace(/"/g, '""')}",${e.durationMs ?? ''}`,
		);
		content = [header, ...rows].join('\n');
	} else {
		content = JSON.stringify(entries, null, 2);
	}

	await writeTextFile(path, content);
}

// ── Main panel ────────────────────────────────────────────────

export function LogPanel() {
	const entries = useLogStore((s) => s.entries);
	const stats = useLogStore((s) => s.stats);
	const clear = useLogStore((s) => s.clear);
	const exportLogsFn = useLogStore((s) => s.exportLogs);
	const bottomRef = useRef<HTMLDivElement>(null);

	// Auto-scroll to bottom on new entries
	useEffect(() => {
		if (typeof bottomRef.current?.scrollIntoView === 'function') {
			bottomRef.current.scrollIntoView({ behavior: 'smooth' });
		}
	}, [entries.length]);

	const filteredCount = entries.length;
	const totalCount = stats.total;

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="flex items-center justify-between border-b px-3 py-1">
				<div className="flex items-center gap-3">
					<span className="text-xs text-muted-foreground">
						{filteredCount === totalCount
							? `${totalCount} entries`
							: `${filteredCount} / ${totalCount} entries`}
					</span>
					<FilterBar />
				</div>
				<div className="flex items-center gap-2">
					<button
						type="button"
						className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
						onClick={() => handleExport(exportLogsFn)}
						title="Export logs"
					>
						<Download className="h-3 w-3" />
						Export
					</button>
					<button
						type="button"
						className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
						onClick={() => clear()}
						title="Clear logs"
					>
						<Trash2 className="h-3 w-3" />
						Clear
					</button>
				</div>
			</div>

			{/* Log entries */}
			<div className="flex-1 overflow-auto p-1 font-mono text-xs">
				{entries.length === 0 && (
					<div className="flex h-full items-center justify-center">
						<span className="text-sm text-muted-foreground">
							No log entries yet
						</span>
					</div>
				)}
				{entries.map((entry) => (
					<div
						key={entry.id}
						className="flex gap-2 px-2 py-0.5 hover:bg-muted/50"
					>
						<span className="shrink-0 text-muted-foreground">
							{formatTime(entry.timestamp)}
						</span>
						<span className={`shrink-0 w-12 ${LEVEL_COLORS[entry.level]}`}>
							[{entry.level}]
						</span>
						<span className="shrink-0 w-16 text-muted-foreground">
							{SOURCE_LABELS[entry.source]}
						</span>
						<span className="whitespace-pre-wrap break-all">
							{entry.message}
						</span>
						{entry.durationMs != null && (
							<span
								className={`shrink-0 tabular-nums ${durationColor(entry.durationMs)}`}
							>
								{entry.durationMs}ms
							</span>
						)}
					</div>
				))}
				<div ref={bottomRef} />
			</div>
		</div>
	);
}
