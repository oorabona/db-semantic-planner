/**
 * Schema diff view — groups changes by table with expand/collapse.
 * Shows summary bar at top, change groups, SQL preview toggle, and Apply button.
 */
import {
	ChevronDown,
	ChevronRight,
	Code,
	Columns,
	Minus,
	Play,
	Plus,
	RefreshCw,
	TriangleAlert,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import type {
	SchemaDiffChange,
	SchemaDiffComparisonWarning,
	SchemaDiffRawComparisonWarning,
	SchemaDiffUnpairedColumnDefaultWarning,
} from '@/lib/ipc';
import { sidecarApi } from '@/lib/ipc';
import { useSchemaDiffStore } from '@/stores/schema-diff-store';
import { ApplyConfirmDialog } from './ApplyConfirmDialog';
import { SchemaDiffSummary } from './SchemaDiffSummary';
import { SideBySideChange } from './SideBySideChange';
import { SqlPreviewPanel } from './SqlPreviewPanel';

export function SchemaDiffView() {
	const diff = useSchemaDiffStore((s) => s.diff);
	const loading = useSchemaDiffStore((s) => s.loading);
	const error = useSchemaDiffStore((s) => s.error);
	const applying = useSchemaDiffStore((s) => s.applying);
	const applyError = useSchemaDiffStore((s) => s.applyError);
	const setApplying = useSchemaDiffStore((s) => s.setApplying);
	const setApplyDone = useSchemaDiffStore((s) => s.setApplyDone);
	const setApplyError = useSchemaDiffStore((s) => s.setApplyError);

	const [showSql, setShowSql] = useState(false);
	const [showConfirm, setShowConfirm] = useState(false);
	const [showSideBySide, setShowSideBySide] = useState(false);

	const handleApply = useCallback(async () => {
		if (!diff || diff.upSQL.length === 0) return;
		setApplying();
		try {
			const connectionId = (window as unknown as Record<string, unknown>)
				.__dbsp_connectionId as string;
			if (!connectionId) {
				setApplyError('No active connection');
				setShowConfirm(false);
				return;
			}
			const result = await sidecarApi.schemaApply(connectionId, [
				...diff.upSQL,
			]);
			if (result.success) {
				setApplyDone(result.applied);
				setShowConfirm(false);
			} else {
				setApplyError(result.error ?? 'Apply failed');
				setShowConfirm(false);
			}
		} catch (err) {
			setApplyError(err instanceof Error ? err.message : String(err));
			setShowConfirm(false);
		}
	}, [diff, setApplying, setApplyDone, setApplyError]);

	if (loading) {
		return (
			<div className="flex flex-1 items-center justify-center p-8">
				<span className="text-sm text-muted-foreground">
					Computing schema diff...
				</span>
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-3 text-sm text-red-600 dark:text-red-400">{error}</div>
		);
	}

	if (!diff) {
		return (
			<div
				className="flex flex-1 items-center justify-center p-8"
				data-testid="schema-diff-empty"
			>
				<span className="text-sm text-muted-foreground">
					No schema diff available. Use Compare Schema with Database.
				</span>
			</div>
		);
	}

	const warnings = diff.warnings;
	const rawWarnings = warnings.filter(
		(warning): warning is SchemaDiffRawComparisonWarning =>
			warning.comparison === 'raw',
	);
	const degradedWarnings = rawWarnings;
	const unpairedWarnings = warnings.filter(
		(warning): warning is SchemaDiffUnpairedColumnDefaultWarning =>
			warning.comparison === 'unpaired',
	);
	const groups = groupChangesByTable(diff.changes);
	const hasChanges = diff.changes.length > 0;

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<SchemaDiffSummary
				summary={diff.summary}
				hasDestructive={diff.hasDestructive}
				totalChanges={diff.changes.length}
			/>
			{degradedWarnings.length > 0 && (
				<ComparisonDegradedNotice warnings={degradedWarnings} />
			)}
			{unpairedWarnings.length > 0 && (
				<ComparisonPairingNotice warnings={unpairedWarnings} />
			)}

			{/* Toolbar: SQL preview toggle + Side-by-side toggle + Apply button */}
			{hasChanges && (
				<div
					className="flex items-center gap-2 border-b border-border px-3 py-1.5"
					data-testid="diff-toolbar"
				>
					<button
						type="button"
						className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
							showSql
								? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
								: 'text-muted-foreground hover:text-foreground hover:bg-muted'
						}`}
						onClick={() => setShowSql(!showSql)}
						data-testid="toggle-sql-preview"
					>
						<Code className="h-3 w-3" />
						SQL
					</button>
					<button
						type="button"
						className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors ${
							showSideBySide
								? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
								: 'text-muted-foreground hover:text-foreground hover:bg-muted'
						}`}
						onClick={() => setShowSideBySide(!showSideBySide)}
						data-testid="toggle-side-by-side"
					>
						<Columns className="h-3 w-3" />
						Diff
					</button>
					<div className="flex-1" />
					<button
						type="button"
						className="flex items-center gap-1 rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
						onClick={() => setShowConfirm(true)}
						disabled={applying}
						data-testid="apply-btn"
					>
						<Play className="h-3 w-3" />
						{applying ? 'Applying...' : 'Apply'}
					</button>
				</div>
			)}

			{/* Apply error */}
			{applyError && (
				<div
					className="border-b border-border bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/20 dark:text-red-400"
					data-testid="apply-error"
				>
					Apply failed: {applyError}
				</div>
			)}

			{/* SQL Preview */}
			{showSql && <SqlPreviewPanel upSQL={diff.upSQL} downSQL={diff.downSQL} />}

			{/* Change list grouped by table */}
			<div className="flex-1 overflow-auto">
				{groups.map((group) => (
					<ChangeGroup
						key={group.label}
						group={group}
						showSideBySide={showSideBySide}
					/>
				))}
			</div>

			{/* Apply confirmation dialog */}
			<ApplyConfirmDialog
				open={showConfirm}
				onConfirm={handleApply}
				onCancel={() => setShowConfirm(false)}
				statements={diff.upSQL}
				hasDestructive={diff.hasDestructive}
				applying={applying}
			/>
		</div>
	);
}

function ComparisonDegradedNotice({
	warnings,
}: {
	warnings: readonly SchemaDiffRawComparisonWarning[];
}) {
	return (
		<section
			className="border-b border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs"
			aria-label="Comparison degraded"
			data-testid="comparison-degraded-notice"
		>
			<div className="flex items-start gap-2">
				<TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600 dark:text-yellow-400" />
				<div className="min-w-0">
					<p className="font-medium text-yellow-800 dark:text-yellow-300">
						Comparison degraded
					</p>
					<p className="mt-0.5 text-yellow-800/90 dark:text-yellow-200/90">
						{warnings.length} expression surface
						{warnings.length === 1 ? '' : 's'} could not be compared reliably.
						This preview may show a migration that does not exist, or hide one
						that does. Review the affected surfaces before applying this
						preview.
					</p>
					<details className="mt-1.5">
						<summary className="cursor-pointer font-medium text-yellow-800 dark:text-yellow-200">
							View affected surfaces
						</summary>
						<ul className="mt-1 space-y-1 text-yellow-900 dark:text-yellow-100">
							{warnings.map((warning, index) => (
								<li
									key={`${warning.kind}-${warning.table}-${warning.name}-${index}`}
								>
									<span className="font-mono">
										{warning.kind === 'column_default'
											? 'column default'
											: warning.kind === 'index_predicate'
												? 'partial-index predicate'
												: 'CHECK constraint'}{' '}
										{warning.table}.{warning.name}
									</span>
									{warning.outcome !== undefined && ` (${warning.outcome})`}:{' '}
									{warning.message}
								</li>
							))}
						</ul>
					</details>
				</div>
			</div>
		</section>
	);
}

function ComparisonPairingNotice({
	warnings,
}: {
	warnings: readonly SchemaDiffUnpairedColumnDefaultWarning[];
}) {
	return (
		<section
			className="border-b border-border bg-muted/30 px-3 py-2 text-xs"
			aria-label="Comparison notes"
			data-testid="comparison-pairing-notice"
		>
			<p className="font-medium text-foreground">Comparison note</p>
			<p className="mt-0.5 text-muted-foreground">
				{warnings.length} column default{warnings.length === 1 ? '' : 's'} had
				no counterpart to compare against.
			</p>
			<details className="mt-1.5">
				<summary className="cursor-pointer font-medium text-foreground">
					View unpaired defaults
				</summary>
				<ul className="mt-1 space-y-1 text-muted-foreground">
					{warnings.map((warning, index) => (
						<li
							key={`${warning.kind}-${warning.table}-${warning.name}-${index}`}
						>
							<span className="font-mono">
								column default {warning.table}.{warning.name}
							</span>
							: {warning.message}
						</li>
					))}
				</ul>
			</details>
		</section>
	);
}

// ── Change Group ────────────────────────────────────────────────

interface ChangeGroupData {
	label: string;
	changes: readonly SchemaDiffChange[];
}

function ChangeGroup({
	group,
	showSideBySide,
}: {
	group: ChangeGroupData;
	showSideBySide: boolean;
}) {
	const [expanded, setExpanded] = useState(true);

	return (
		<div className="border-b border-border">
			<button
				type="button"
				className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium hover:bg-muted/50"
				onClick={() => setExpanded(!expanded)}
				data-testid={`diff-group-${group.label.toLowerCase()}`}
			>
				{expanded ? (
					<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				) : (
					<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				)}
				{group.label}
				<span className="ml-1 text-muted-foreground">
					({group.changes.length})
				</span>
			</button>

			{expanded && (
				<div className="space-y-0.5 px-3 pb-2 pl-10">
					{group.changes.map((change, i) => (
						<ChangeRow
							key={`${change.kind}-${change.table}-${change.column ?? ''}-${i}`}
							change={change}
							showSideBySide={showSideBySide}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// ── Change Row ──────────────────────────────────────────────────

function ChangeRow({
	change,
	showSideBySide,
}: {
	change: SchemaDiffChange;
	showSideBySide: boolean;
}) {
	const changeType = getChangeType(change.kind);
	const entityName = change.column
		? `${change.table}.${change.column}`
		: change.table;
	const isAlter = change.kind.startsWith('alter_');

	return (
		<div className="py-0.5 text-xs">
			<div className="flex items-start gap-2">
				<ChangeIcon type={changeType} />
				<div className="min-w-0">
					<span className={`font-mono ${changeTypeColor(changeType)}`}>
						{entityName}
					</span>
					<p className="text-muted-foreground">{change.details}</p>
					{change.destructive && (
						<span className="text-[11px] font-medium text-red-600 dark:text-red-400">
							destructive
						</span>
					)}
				</div>
			</div>
			{showSideBySide && isAlter && <SideBySideChange change={change} />}
		</div>
	);
}

// ── Icons & Colors ──────────────────────────────────────────────

type ChangeType = 'addition' | 'drop' | 'alteration';

function ChangeIcon({ type }: { type: ChangeType }) {
	switch (type) {
		case 'addition':
			return (
				<Plus className="mt-0.5 h-3 w-3 shrink-0 text-green-600 dark:text-green-400" />
			);
		case 'drop':
			return (
				<Minus className="mt-0.5 h-3 w-3 shrink-0 text-red-600 dark:text-red-400" />
			);
		case 'alteration':
			return (
				<RefreshCw className="mt-0.5 h-3 w-3 shrink-0 text-yellow-600 dark:text-yellow-400" />
			);
	}
}

function changeTypeColor(type: ChangeType): string {
	switch (type) {
		case 'addition':
			return 'text-green-600 dark:text-green-400';
		case 'drop':
			return 'text-red-600 dark:text-red-400';
		case 'alteration':
			return 'text-yellow-600 dark:text-yellow-400';
	}
}

// ── Grouping Logic ──────────────────────────────────────────────

function getChangeType(kind: string): ChangeType {
	if (kind.startsWith('create_') || kind.startsWith('add_')) return 'addition';
	if (kind.startsWith('drop_')) return 'drop';
	return 'alteration';
}

/** Groups changes by table name, maintaining insertion order. */
function groupChangesByTable(
	changes: readonly SchemaDiffChange[],
): ChangeGroupData[] {
	const map = new Map<string, SchemaDiffChange[]>();

	for (const change of changes) {
		const list = map.get(change.table);
		if (list) {
			list.push(change);
		} else {
			map.set(change.table, [change]);
		}
	}

	return Array.from(map.entries()).map(([table, tableChanges]) => ({
		label: table,
		changes: tableChanges,
	}));
}
