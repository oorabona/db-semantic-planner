/**
 * Decision card showing a single planner decision with strategy, reasoning, and alternatives.
 */
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

interface DecisionCardProps {
	type: string;
	choice: string;
	reasoning: string;
	alternatives: readonly string[];
	context: {
		sourceTable: string;
		target?: string | undefined;
		relation?: string | undefined;
	};
}

const TYPE_COLORS: Record<string, string> = {
	'filter-strategy': 'bg-blue-500/20 text-blue-700 dark:text-blue-400',
	'join-type': 'bg-green-500/20 text-green-700 dark:text-green-400',
	'include-strategy': 'bg-purple-500/20 text-purple-700 dark:text-purple-400',
	'cte-extraction': 'bg-orange-500/20 text-orange-700 dark:text-orange-400',
	ambiguity: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-400',
	'recursive-cte': 'bg-pink-500/20 text-pink-700 dark:text-pink-400',
};

export function DecisionCard({
	type,
	choice,
	reasoning,
	alternatives,
	context,
}: DecisionCardProps) {
	const [expanded, setExpanded] = useState(false);
	const colorClass = TYPE_COLORS[type] ?? 'bg-muted text-muted-foreground';

	return (
		<div className="rounded-md border px-3 py-2">
			<div className="flex items-start gap-2">
				<span
					className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${colorClass}`}
				>
					{type}
				</span>
				<div className="min-w-0 flex-1">
					<p className="text-xs font-medium">{choice}</p>
					<p className="text-xs text-muted-foreground">
						{context.sourceTable}
						{context.target ? ` → ${context.target}` : ''}
						{context.relation ? ` (${context.relation})` : ''}
					</p>
					<p className="mt-1 text-xs text-muted-foreground/80">{reasoning}</p>
				</div>
			</div>

			{alternatives.length > 0 && (
				<button
					type="button"
					className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
					onClick={() => setExpanded(!expanded)}
				>
					{expanded ? (
						<ChevronDown className="h-3 w-3" />
					) : (
						<ChevronRight className="h-3 w-3" />
					)}
					Also considered: {alternatives.join(', ')}
				</button>
			)}
		</div>
	);
}
