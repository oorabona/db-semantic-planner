/**
 * Full-screen modal for app logs — level filter, text search, virtualized list.
 * Opened via the expand icon in the AppLogPopover.
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatLogTime, LEVEL_COLORS } from '@/lib/log-utils';
import type { LogEntry, LogLevel } from '@/stores/log-store';

// ── Constants ─────────────────────────────────────────────────

const ALL_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

// ── Component ─────────────────────────────────────────────────

export function AppLogModal({
	entries,
	onClose,
	onClear,
}: {
	entries: readonly LogEntry[];
	onClose: () => void;
	onClear?: () => void;
}) {
	const [levelFilter, setLevelFilter] = useState<LogLevel | ''>('');
	const [searchInput, setSearchInput] = useState('');
	const [searchQuery, setSearchQuery] = useState('');
	const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const parentRef = useRef<HTMLDivElement>(null);
	const prevCountRef = useRef(0);

	// Close on Escape
	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === 'Escape') onClose();
		}
		document.addEventListener('keydown', handleKey);
		return () => document.removeEventListener('keydown', handleKey);
	}, [onClose]);

	// Clear debounce timer on unmount
	useEffect(() => {
		return () => {
			if (searchTimer.current) clearTimeout(searchTimer.current);
		};
	}, []);

	// Debounced search
	const handleSearchChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const value = e.target.value;
			setSearchInput(value);
			if (searchTimer.current) clearTimeout(searchTimer.current);
			searchTimer.current = setTimeout(() => {
				setSearchQuery(value);
			}, 300);
		},
		[],
	);

	const clearSearch = useCallback(() => {
		if (searchTimer.current) {
			clearTimeout(searchTimer.current);
			searchTimer.current = null;
		}
		setSearchInput('');
		setSearchQuery('');
	}, []);

	// Filter entries client-side
	const filtered = entries.filter((e) => {
		if (levelFilter && e.level !== levelFilter) return false;
		if (
			searchQuery &&
			!e.message.toLowerCase().includes(searchQuery.toLowerCase())
		)
			return false;
		return true;
	});

	const virtualizer = useVirtualizer({
		count: filtered.length,
		getScrollElement: () => parentRef.current,
		estimateSize: () => 24,
		overscan: 20,
	});

	// Auto-scroll to bottom on new entries
	useEffect(() => {
		if (filtered.length > prevCountRef.current && filtered.length > 0) {
			virtualizer.scrollToIndex(filtered.length - 1, { align: 'end' });
		}
		prevCountRef.current = filtered.length;
	}, [filtered.length, virtualizer]);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled via document keydown listener
		<div
			role="dialog"
			aria-modal="true"
			aria-label="App Logs"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div className="flex h-[80vh] w-[80vw] max-w-4xl flex-col rounded-lg border bg-background shadow-xl">
				{/* Header */}
				<div className="flex items-center justify-between border-b px-4 py-2">
					<span className="text-sm font-medium">App Logs</span>
					<div className="flex items-center gap-3">
						{/* Stats */}
						<span className="text-xs text-muted-foreground">
							{filtered.length === entries.length
								? `${entries.length} entries`
								: `${filtered.length} / ${entries.length} entries`}
						</span>
						{onClear && (
							<button
								type="button"
								onClick={onClear}
								className="text-muted-foreground hover:text-foreground"
								title="Clear all app logs"
							>
								<Trash2 className="h-4 w-4" />
							</button>
						)}
						<button
							type="button"
							onClick={onClose}
							className="text-muted-foreground hover:text-foreground"
							title="Close (Escape)"
						>
							<X className="h-4 w-4" />
						</button>
					</div>
				</div>

				{/* Filter bar */}
				<div className="flex items-center gap-2 border-b px-4 py-1.5">
					{/* Level filter */}
					<select
						className="h-6 rounded border border-input bg-transparent px-1 text-xs"
						value={levelFilter}
						onChange={(e) => setLevelFilter(e.target.value as LogLevel | '')}
						title="Filter by level"
					>
						<option value="">All levels</option>
						{ALL_LEVELS.map((l) => (
							<option key={l} value={l}>
								{l}
							</option>
						))}
					</select>

					{/* Text search */}
					<div className="relative flex items-center">
						<Search className="absolute left-1 h-3 w-3 text-muted-foreground" />
						<input
							type="text"
							className="h-6 w-48 rounded border border-input bg-transparent pl-5 pr-5 text-xs placeholder:text-muted-foreground"
							placeholder="Search logs..."
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

				{/* Virtualized log entries */}
				<div
					ref={parentRef}
					className="flex-1 overflow-auto p-1 font-mono text-xs"
				>
					{filtered.length === 0 ? (
						<div className="flex h-full items-center justify-center">
							<span className="text-sm text-muted-foreground">
								{entries.length === 0
									? 'No app logs yet'
									: 'No matching entries'}
							</span>
						</div>
					) : (
						<div
							style={{
								height: `${virtualizer.getTotalSize()}px`,
								width: '100%',
								position: 'relative',
							}}
						>
							{virtualizer.getVirtualItems().map((virtualRow) => {
								const entry = filtered[virtualRow.index];
								if (!entry) return null;
								return (
									<div
										key={entry.id}
										className="flex gap-2 px-2 py-0.5 hover:bg-muted/50"
										style={{
											position: 'absolute',
											top: 0,
											left: 0,
											width: '100%',
											height: `${virtualRow.size}px`,
											transform: `translateY(${virtualRow.start}px)`,
										}}
									>
										<span className="shrink-0 text-muted-foreground">
											{formatLogTime(entry.timestamp)}
										</span>
										<span
											className={`shrink-0 w-12 ${LEVEL_COLORS[entry.level]}`}
										>
											[{entry.level}]
										</span>
										<span className="whitespace-pre-wrap break-all">
											{entry.message}
										</span>
									</div>
								);
							})}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
