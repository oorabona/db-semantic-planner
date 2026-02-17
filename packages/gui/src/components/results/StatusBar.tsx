/**
 * Results status bar: row count, timing, truncation, CSV export, fetch more.
 */

import { ChevronDown, Download, Loader2 } from 'lucide-react';
import { downloadCsv, toCsv } from '@/lib/csv-export';
import { triggerFetchMore, useResultsStore } from '@/stores/results-store';

// ── StatusBar ────────────────────────────────────────────────────

export function StatusBar() {
	const result = useResultsStore((s) => s.result);
	const executing = useResultsStore((s) => s.executing);
	const fetchingMore = useResultsStore((s) => s.fetchingMore);
	const error = useResultsStore((s) => s.error);

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
						className="flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
						onClick={triggerFetchMore}
						disabled={fetchingMore}
					>
						{fetchingMore ? (
							<Loader2 className="h-3 w-3 animate-spin" />
						) : (
							<ChevronDown className="h-3 w-3" />
						)}
						{fetchingMore ? 'Loading...' : 'Fetch more'}
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
			</div>
		</div>
	);
}
