/**
 * Summary bar showing assertion pass/fail/skipped counts.
 */
import { CheckCircle, CircleSlash, TriangleAlert, XCircle } from 'lucide-react';
import type { RunAssertionsSummary } from '@/lib/ipc';

interface AssertionSummaryBarProps {
	summary: RunAssertionsSummary;
}

export function AssertionSummaryBar({ summary }: AssertionSummaryBarProps) {
	const allPassed = summary.failed === 0 && summary.total > 0;

	return (
		<div
			className={`flex items-center gap-4 border-b px-3 py-1.5 text-xs ${
				allPassed
					? 'border-green-500/20 bg-green-500/5'
					: summary.failed > 0
						? 'border-red-500/20 bg-red-500/5'
						: 'border-border'
			}`}
			data-testid="assertion-summary"
		>
			<span className="font-medium">
				{summary.total} assertion{summary.total !== 1 ? 's' : ''}
			</span>
			<span className="flex items-center gap-1 text-green-600 dark:text-green-400">
				<CheckCircle className="h-3 w-3" />
				{summary.passed} passed
			</span>
			{summary.failed > 0 && (
				<span className="flex items-center gap-1 text-red-600 dark:text-red-400">
					<XCircle className="h-3 w-3" />
					{summary.failed} failed
				</span>
			)}
			{summary.skipped > 0 && (
				<span className="flex items-center gap-1 text-yellow-600 dark:text-yellow-400">
					<CircleSlash className="h-3 w-3" />
					{summary.skipped} skipped
				</span>
			)}
			{allPassed && (
				<span className="ml-auto flex items-center gap-1 font-medium text-green-600 dark:text-green-400">
					<CheckCircle className="h-3.5 w-3.5" />
					All passed
				</span>
			)}
			{summary.failed > 0 && (
				<span className="ml-auto flex items-center gap-1 font-medium text-red-600 dark:text-red-400">
					<TriangleAlert className="h-3.5 w-3.5" />
					{summary.failed} failure{summary.failed !== 1 ? 's' : ''}
				</span>
			)}
		</div>
	);
}
