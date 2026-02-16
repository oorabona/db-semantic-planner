/**
 * Application log panel — displays sidecar stderr, IPC, and app logs.
 * Auto-scrolls to bottom on new entries. Clear button to flush.
 */
import { Trash2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { type LogEntry, useLogStore } from '@/stores/log-store';

const LEVEL_COLORS: Record<LogEntry['level'], string> = {
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

function formatTime(ts: number): string {
	const d = new Date(ts);
	return d.toLocaleTimeString('en-GB', {
		hour12: false,
		fractionalSecondDigits: 3,
	});
}

export function LogPanel() {
	const entries = useLogStore((s) => s.entries);
	const clear = useLogStore((s) => s.clear);
	const bottomRef = useRef<HTMLDivElement>(null);

	// Auto-scroll to bottom on new entries
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [entries.length]);

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="flex items-center justify-between border-b px-3 py-1">
				<span className="text-xs text-muted-foreground">
					{entries.length} log entries
				</span>
				<button
					type="button"
					className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
					onClick={clear}
					title="Clear logs"
				>
					<Trash2 className="h-3 w-3" />
					Clear
				</button>
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
					</div>
				))}
				<div ref={bottomRef} />
			</div>
		</div>
	);
}
