/**
 * Results status bar: row count, timing, truncation, CSV export,
 * and app-level log popover (sidecar/boot events from app.sqlite).
 */

import { ChevronDown, Download, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { downloadCsv, toCsv } from '@/lib/csv-export';
import type { LogEntry, LogLevel } from '@/stores/log-store';
import { useLogStore } from '@/stores/log-store';
import { useResultsStore } from '@/stores/results-store';

const LEVEL_COLORS: Record<LogLevel, string> = {
	info: 'text-blue-500',
	warn: 'text-yellow-500',
	error: 'text-red-500',
	debug: 'text-muted-foreground',
};

function formatTime(ts: number): string {
	const d = new Date(ts);
	return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

// ── App Log Popover ──────────────────────────────────────────────

function AppLogPopover({
	entries,
	onClose,
}: {
	entries: readonly LogEntry[];
	onClose: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);

	// Close on click outside
	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				onClose();
			}
		}
		document.addEventListener('mousedown', handleClick);
		return () => document.removeEventListener('mousedown', handleClick);
	}, [onClose]);

	return (
		<div
			ref={ref}
			className="absolute bottom-full right-0 mb-1 w-96 max-h-64 overflow-y-auto rounded border bg-background shadow-lg z-50"
		>
			<div className="flex items-center justify-between border-b px-3 py-1.5">
				<span className="text-xs font-medium">App Logs</span>
				<button
					type="button"
					onClick={onClose}
					className="text-muted-foreground hover:text-foreground"
				>
					<X className="h-3 w-3" />
				</button>
			</div>
			{entries.length === 0 ? (
				<div className="px-3 py-4 text-center text-xs text-muted-foreground">
					No app logs yet
				</div>
			) : (
				<div className="divide-y">
					{entries.map((entry) => (
						<div
							key={entry.id}
							className="flex gap-2 px-3 py-1 text-xs font-mono"
						>
							<span className="shrink-0 text-muted-foreground">
								{formatTime(entry.timestamp)}
							</span>
							<span className={`shrink-0 w-12 ${LEVEL_COLORS[entry.level]}`}>
								[{entry.level}]
							</span>
							<span className="truncate">{entry.message}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// ── StatusBar ────────────────────────────────────────────────────

export function StatusBar() {
	const result = useResultsStore((s) => s.result);
	const executing = useResultsStore((s) => s.executing);
	const error = useResultsStore((s) => s.error);
	const appEntries = useLogStore((s) => s.appEntries);
	const [showAppLogs, setShowAppLogs] = useState(false);

	// Count errors/warnings for badge
	const errorCount = appEntries.filter(
		(e) => e.level === 'error' || e.level === 'warn',
	).length;

	const statusContent = (() => {
		if (error) {
			return <span className="text-xs text-destructive">{error}</span>;
		}
		if (executing) {
			return (
				<span className="text-xs text-muted-foreground">Executing...</span>
			);
		}
		if (!result) {
			return <span className="text-xs text-muted-foreground">Ready</span>;
		}

		const rowCount = result.rows.length;
		const timing =
			result.durationMs < 1000
				? `${result.durationMs.toFixed(1)}ms`
				: `${(result.durationMs / 1000).toFixed(2)}s`;
		const truncationText = result.truncated
			? ` of ${result.totalRows?.toLocaleString() ?? '?'}+ rows (truncated)`
			: '';

		return (
			<span className="text-xs text-muted-foreground">
				{rowCount.toLocaleString()} rows{truncationText} · {timing}
			</span>
		);
	})();

	const handleExport = () => {
		if (!result) return;
		const csv = toCsv(result.columns, result.rows);
		downloadCsv(csv, `results-${Date.now()}.csv`);
	};

	return (
		<div className="relative flex items-center justify-between border-t px-3 py-1">
			{statusContent}
			<div className="flex items-center gap-2">
				{result?.truncated && result.cursorId && (
					<button
						type="button"
						className="flex items-center gap-1 text-xs text-primary hover:underline"
						onClick={() => {
							// fetchMore will be wired when sidecar supports it
						}}
					>
						<ChevronDown className="h-3 w-3" />
						Fetch more
					</button>
				)}
				{result && (
					<button
						type="button"
						className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
						onClick={handleExport}
						title="Export CSV"
					>
						<Download className="h-3 w-3" />
						CSV
					</button>
				)}
				<button
					type="button"
					className="relative flex items-center text-xs text-muted-foreground hover:text-foreground"
					onClick={() => setShowAppLogs((prev) => !prev)}
					title="App logs (sidecar, boot events)"
				>
					<Plus className="h-3.5 w-3.5" />
					{errorCount > 0 && (
						<span className="absolute -top-1 -right-1 flex h-3 w-3 items-center justify-center rounded-full bg-destructive text-[8px] text-destructive-foreground">
							{errorCount > 9 ? '9+' : errorCount}
						</span>
					)}
				</button>
			</div>
			{showAppLogs && (
				<AppLogPopover
					entries={appEntries}
					onClose={() => setShowAppLogs(false)}
				/>
			)}
		</div>
	);
}
