/**
 * Results status bar: row count, timing, truncation, CSV export.
 */
import { Download, ChevronDown } from 'lucide-react';
import { useResultsStore } from '@/stores/results-store';
import { toCsv, downloadCsv } from '@/lib/csv-export';

export function StatusBar() {
	const result = useResultsStore((s) => s.result);
	const executing = useResultsStore((s) => s.executing);
	const error = useResultsStore((s) => s.error);

	if (error) {
		return (
			<div className="flex items-center border-t px-3 py-1">
				<span className="text-xs text-destructive">{error}</span>
			</div>
		);
	}

	if (executing) {
		return (
			<div className="flex items-center border-t px-3 py-1">
				<span className="text-xs text-muted-foreground">Executing...</span>
			</div>
		);
	}

	if (!result) {
		return (
			<div className="flex items-center border-t px-3 py-1">
				<span className="text-xs text-muted-foreground">Ready</span>
			</div>
		);
	}

	const rowCount = result.rows.length;
	const timing = result.durationMs < 1000
		? `${result.durationMs.toFixed(1)}ms`
		: `${(result.durationMs / 1000).toFixed(2)}s`;

	const truncationText = result.truncated
		? ` of ${result.totalRows?.toLocaleString() ?? '?'}+ rows (truncated)`
		: '';

	const handleExport = () => {
		const csv = toCsv(result.columns, result.rows);
		downloadCsv(csv, `results-${Date.now()}.csv`);
	};

	return (
		<div className="flex items-center justify-between border-t px-3 py-1">
			<span className="text-xs text-muted-foreground">
				{rowCount.toLocaleString()} rows{truncationText} · {timing}
			</span>
			<div className="flex items-center gap-2">
				{result.truncated && result.cursorId && (
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
				<button
					type="button"
					className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
					onClick={handleExport}
					title="Export CSV"
				>
					<Download className="h-3 w-3" />
					CSV
				</button>
			</div>
		</div>
	);
}
