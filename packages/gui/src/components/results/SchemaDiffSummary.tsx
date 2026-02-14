/**
 * Summary bar showing schema diff change counts by category.
 * Green badges for additions, red for drops, yellow for alterations.
 */
import {
	CheckCircle,
	Minus,
	Plus,
	RefreshCw,
	TriangleAlert,
} from 'lucide-react';
import type { DiffSummary } from '@/lib/ipc';

interface SchemaDiffSummaryProps {
	summary: DiffSummary;
	hasDestructive: boolean;
	totalChanges: number;
}

export function SchemaDiffSummary({
	summary,
	hasDestructive,
	totalChanges,
}: SchemaDiffSummaryProps) {
	if (totalChanges === 0) {
		return (
			<div
				className="flex items-center gap-2 border-b border-green-500/20 bg-green-500/5 px-3 py-1.5 text-xs"
				data-testid="schema-diff-summary"
			>
				<CheckCircle className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
				<span className="font-medium text-green-600 dark:text-green-400">
					Schemas are in sync
				</span>
			</div>
		);
	}

	const additions = collectAdditions(summary);
	const drops = collectDrops(summary);
	const alterations = collectAlterations(summary);

	return (
		<div
			className={`flex flex-wrap items-center gap-3 border-b px-3 py-1.5 text-xs ${
				hasDestructive ? 'border-red-500/20 bg-red-500/5' : 'border-border'
			}`}
			data-testid="schema-diff-summary"
		>
			<span className="font-medium">
				{totalChanges} change{totalChanges !== 1 ? 's' : ''}
			</span>

			{additions.map(({ label, count }) => (
				<span
					key={label}
					className="flex items-center gap-1 text-green-600 dark:text-green-400"
				>
					<Plus className="h-3 w-3" />+{count} {label}
				</span>
			))}

			{drops.map(({ label, count }) => (
				<span
					key={label}
					className="flex items-center gap-1 text-red-600 dark:text-red-400"
				>
					<Minus className="h-3 w-3" />-{count} {label}
				</span>
			))}

			{alterations.map(({ label, count }) => (
				<span
					key={label}
					className="flex items-center gap-1 text-yellow-600 dark:text-yellow-400"
				>
					<RefreshCw className="h-3 w-3" />~{count} {label}
				</span>
			))}

			{hasDestructive && (
				<span className="ml-auto flex items-center gap-1 font-medium text-red-600 dark:text-red-400">
					<TriangleAlert className="h-3.5 w-3.5" />
					Destructive changes
				</span>
			)}
		</div>
	);
}

// ── Helpers ─────────────────────────────────────────────────────

interface Badge {
	label: string;
	count: number;
}

function collectAdditions(summary: DiffSummary): Badge[] {
	const badges: Badge[] = [];
	if (summary.tables.added > 0)
		badges.push({ label: 'tables', count: summary.tables.added });
	if (summary.columns.added > 0)
		badges.push({ label: 'columns', count: summary.columns.added });
	if (summary.indexes.added > 0)
		badges.push({ label: 'indexes', count: summary.indexes.added });
	if (summary.constraints.added > 0)
		badges.push({ label: 'constraints', count: summary.constraints.added });
	return badges;
}

function collectDrops(summary: DiffSummary): Badge[] {
	const badges: Badge[] = [];
	if (summary.tables.dropped > 0)
		badges.push({ label: 'tables', count: summary.tables.dropped });
	if (summary.columns.dropped > 0)
		badges.push({ label: 'columns', count: summary.columns.dropped });
	if (summary.indexes.dropped > 0)
		badges.push({ label: 'indexes', count: summary.indexes.dropped });
	if (summary.constraints.dropped > 0)
		badges.push({
			label: 'constraints',
			count: summary.constraints.dropped,
		});
	return badges;
}

function collectAlterations(summary: DiffSummary): Badge[] {
	const badges: Badge[] = [];
	if (summary.columns.altered > 0)
		badges.push({ label: 'columns', count: summary.columns.altered });
	if (summary.constraints.altered > 0)
		badges.push({
			label: 'constraints',
			count: summary.constraints.altered,
		});
	return badges;
}
