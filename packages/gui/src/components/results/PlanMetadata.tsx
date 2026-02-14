/**
 * Plan metadata: root table, planning time, relations analyzed.
 */
import { Clock, GitBranch, Table } from 'lucide-react';

interface PlanMetadataProps {
	rootTable: string;
	planningTimeMs: number;
	relationsAnalyzed: number;
	isAmbiguous?: boolean | undefined;
}

export function PlanMetadata({
	rootTable,
	planningTimeMs,
	relationsAnalyzed,
	isAmbiguous,
}: PlanMetadataProps) {
	return (
		<div className="flex flex-wrap items-center gap-4 rounded-md bg-muted/50 px-3 py-2">
			<span className="flex items-center gap-1.5 text-xs">
				<Table className="h-3.5 w-3.5 text-muted-foreground" />
				<span className="font-medium">Plan for:</span> {rootTable}
			</span>
			<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<Clock className="h-3.5 w-3.5" />
				{planningTimeMs.toFixed(1)}ms
			</span>
			<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<GitBranch className="h-3.5 w-3.5" />
				{relationsAnalyzed} relations analyzed
			</span>
			{isAmbiguous && (
				<span className="rounded bg-yellow-500/20 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700 dark:text-yellow-400">
					AMBIGUOUS
				</span>
			)}
		</div>
	);
}
