import { Table } from "lucide-react";

export function ResultsPanel() {
	return (
		<div className="flex h-full flex-col bg-[var(--background)]">
			{/* Results tab bar */}
			<div className="flex items-center gap-1 border-b border-[var(--border)] px-2">
				<div className="flex items-center gap-1.5 border-b-2 border-[var(--primary)] px-3 py-1.5">
					<Table className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
					<span className="text-xs font-medium">Results</span>
				</div>
				<div className="px-3 py-1.5">
					<span className="text-xs text-[var(--muted-foreground)]">SQL</span>
				</div>
				<div className="px-3 py-1.5">
					<span className="text-xs text-[var(--muted-foreground)]">Plan</span>
				</div>
			</div>

			{/* Empty state */}
			<div className="flex flex-1 items-center justify-center">
				<p className="text-sm text-[var(--muted-foreground)]">
					Run a query to see results
				</p>
			</div>

			{/* Status bar */}
			<div className="flex items-center border-t border-[var(--border)] px-3 py-1">
				<span className="text-xs text-[var(--muted-foreground)]">Ready</span>
			</div>
		</div>
	);
}
