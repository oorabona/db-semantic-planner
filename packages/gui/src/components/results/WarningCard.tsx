/**
 * Warning card showing a planner warning with message and suggestion.
 */
import { AlertTriangle } from 'lucide-react';

interface WarningCardProps {
	code: string;
	message: string;
	suggestion?: string | undefined;
}

export function WarningCard({ code, message, suggestion }: WarningCardProps) {
	return (
		<div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2">
			<div className="flex items-start gap-2">
				<AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yellow-600 dark:text-yellow-400" />
				<div className="min-w-0 flex-1">
					<p className="text-xs font-medium">
						<span className="text-yellow-700 dark:text-yellow-400">
							{code}
						</span>{' '}
						— {message}
					</p>
					{suggestion && (
						<p className="mt-0.5 text-xs text-muted-foreground">
							Suggestion: {suggestion}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}
