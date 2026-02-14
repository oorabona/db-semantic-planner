/**
 * CTE extraction summary showing CTEs used in the query plan.
 */
import { Braces, RotateCw } from 'lucide-react';

interface CteItem {
	name: string;
	purpose: string;
	referencedBy: readonly string[];
	recursive?: boolean | undefined;
}

interface CteListProps {
	ctes: readonly CteItem[];
}

export function CteList({ ctes }: CteListProps) {
	if (ctes.length === 0) return null;

	return (
		<div className="space-y-1.5">
			<h4 className="text-xs font-medium text-muted-foreground">
				CTEs ({ctes.length})
			</h4>
			{ctes.map((cte) => (
				<div
					key={cte.name}
					className="flex items-start gap-2 rounded-md border px-3 py-2"
				>
					{cte.recursive ? (
						<RotateCw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-pink-500" />
					) : (
						<Braces className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500" />
					)}
					<div className="min-w-0 flex-1">
						<p className="text-xs font-medium font-mono">{cte.name}</p>
						<p className="text-xs text-muted-foreground">{cte.purpose}</p>
						{cte.referencedBy.length > 0 && (
							<p className="mt-0.5 text-[10px] text-muted-foreground/70">
								Referenced by: {cte.referencedBy.join(', ')}
							</p>
						)}
					</div>
					{cte.recursive && (
						<span className="shrink-0 rounded bg-pink-500/20 px-1.5 py-0.5 text-[10px] font-medium text-pink-700 dark:text-pink-400">
							RECURSIVE
						</span>
					)}
				</div>
			))}
		</div>
	);
}
