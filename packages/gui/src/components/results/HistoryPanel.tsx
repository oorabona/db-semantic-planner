import {
	AlertCircle,
	CheckCircle2,
	Clock,
	Play,
	Search,
	Trash2,
} from 'lucide-react';
import { useCallback } from 'react';
import { cn } from '@/lib/utils';
import { useConnectionStore } from '@/stores/connection-store';
import { useEditorStore } from '@/stores/editor-store';
import { type HistoryEntry, useHistoryStore } from '@/stores/history-store';
import { useResultsStore } from '@/stores/results-store';

// ── Helpers ──────────────────────────────────────────────────────

function formatRelativeTime(timestamp: number): string {
	const diff = Date.now() - timestamp;
	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) return 'just now';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function truncateQuery(query: string, maxLength = 120): string {
	const single = query.replace(/\s+/g, ' ').trim();
	if (single.length <= maxLength) return single;
	return `${single.slice(0, maxLength)}...`;
}

// ── Component ────────────────────────────────────────────────────

export function HistoryPanel() {
	const search = useHistoryStore((s) => s.search);
	const setSearch = useHistoryStore((s) => s.setSearch);
	const clearHistory = useHistoryStore((s) => s.clearHistory);
	const entries = useHistoryStore((s) => s.getFiltered());
	const active = useConnectionStore((s) => s.active);

	const loadInEditor = useCallback((entry: HistoryEntry) => {
		const lang = entry.language === 'nql' ? 'nql' : 'sql';
		useEditorStore.getState().addTab(lang, entry.query);
		useResultsStore.getState().setActiveTab('results');
	}, []);

	return (
		<div className="flex h-full flex-col">
			{/* Search bar */}
			<div className="flex items-center gap-2 border-b px-3 py-2">
				<Search className="h-3.5 w-3.5 text-muted-foreground" />
				<input
					type="text"
					placeholder="Search history..."
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
				/>
				{entries.length > 0 && (
					<button
						type="button"
						onClick={clearHistory}
						className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
						title="Clear all history"
					>
						<Trash2 className="h-3 w-3" />
						Clear
					</button>
				)}
			</div>

			{/* Entries list */}
			<div className="flex-1 overflow-auto">
				{entries.length === 0 && (
					<div className="flex flex-1 items-center justify-center p-8">
						<span className="text-sm text-muted-foreground">
							{search ? 'No matching queries.' : 'No queries in history.'}
						</span>
					</div>
				)}

				{entries.map((entry) => (
					<div
						key={entry.id}
						className="group flex items-start gap-2 border-b px-3 py-2 hover:bg-muted/50"
					>
						{/* Status icon */}
						{entry.success ? (
							<CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" />
						) : (
							<AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
						)}

						{/* Content */}
						<button
							type="button"
							className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
							onClick={() => loadInEditor(entry)}
							title="Click to open in new editor tab"
						>
							<span className="truncate font-mono text-xs">
								{truncateQuery(entry.query)}
							</span>
							<div className="flex items-center gap-2 text-[10px] text-muted-foreground">
								<span
									className={cn(
										'rounded px-1 py-0.5 font-medium uppercase',
										entry.language === 'nql'
											? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
											: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
									)}
								>
									{entry.language}
								</span>
								<span className="flex items-center gap-0.5">
									<Clock className="h-2.5 w-2.5" />
									{formatDuration(entry.durationMs)}
								</span>
								{entry.success && entry.rowCount != null && (
									<span>
										{entry.rowCount} row{entry.rowCount !== 1 ? 's' : ''}
									</span>
								)}
								{!entry.success && entry.error && (
									<span className="truncate text-red-500" title={entry.error}>
										{entry.error}
									</span>
								)}
								<span className="ml-auto">{entry.database}</span>
								<span>{formatRelativeTime(entry.timestamp)}</span>
							</div>
						</button>

						{/* Re-run button (visible on hover) */}
						{active && (
							<button
								type="button"
								className="mt-0.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
								onClick={(e) => {
									e.stopPropagation();
									loadInEditor(entry);
								}}
								title="Open in new tab"
							>
								<Play className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
							</button>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
