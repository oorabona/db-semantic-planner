/**
 * Placeholder shown when no query has been executed.
 */
import { Play } from 'lucide-react';

export function EmptyState() {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
			<Play className="h-8 w-8 opacity-30" />
			<p className="text-sm">Run a query to see results</p>
			<p className="text-xs opacity-60">Cmd/Ctrl + Enter to execute</p>
		</div>
	);
}
