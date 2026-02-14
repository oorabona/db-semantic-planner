/**
 * Schema diff view — groups changes by category with expand/collapse.
 * Shows summary bar at top, change groups below.
 */
import {
	ChevronDown,
	ChevronRight,
	Minus,
	Plus,
	RefreshCw,
} from 'lucide-react';
import { useState } from 'react';
import type { SchemaDiffChange } from '@/lib/ipc';
import { useSchemaDiffStore } from '@/stores/schema-diff-store';
import { SchemaDiffSummary } from './SchemaDiffSummary';

export function SchemaDiffView() {
	const diff = useSchemaDiffStore((s) => s.diff);
	const loading = useSchemaDiffStore((s) => s.loading);
	const error = useSchemaDiffStore((s) => s.error);

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

	const groups = groupChanges(diff.changes);

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<SchemaDiffSummary
				summary={diff.summary}
				hasDestructive={diff.hasDestructive}
				totalChanges={diff.changes.length}
			/>
			<div className="flex-1 overflow-auto">
				{groups.map((group) => (
					<ChangeGroup key={group.label} group={group} />
				))}
			</div>
		</div>
	);
}

// ── Change Group ────────────────────────────────────────────────

interface ChangeGroupData {
	label: string;
	changes: readonly SchemaDiffChange[];
}

function ChangeGroup({ group }: { group: ChangeGroupData }) {
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
						/>
					))}
				</div>
			)}
		</div>
	);
}

// ── Change Row ──────────────────────────────────────────────────

function ChangeRow({ change }: { change: SchemaDiffChange }) {
	const changeType = getChangeType(change.kind);
	const entityName = change.column
		? `${change.table}.${change.column}`
		: change.table;

	return (
		<div className="flex items-start gap-2 py-0.5 text-xs">
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

function getGroupLabel(kind: string): string {
	if (kind === 'create_table' || kind === 'drop_table') return 'Tables';
	if (kind.includes('column')) return 'Columns';
	if (kind.includes('index')) return 'Indexes';
	if (kind.includes('primary_key') || kind.includes('foreign_key'))
		return 'Constraints';
	return 'Other';
}

function groupChanges(changes: readonly SchemaDiffChange[]): ChangeGroupData[] {
	const groupOrder = ['Tables', 'Columns', 'Indexes', 'Constraints', 'Other'];
	const map = new Map<string, SchemaDiffChange[]>();

	for (const change of changes) {
		const label = getGroupLabel(change.kind);
		const list = map.get(label);
		if (list) {
			list.push(change);
		} else {
			map.set(label, [change]);
		}
	}

	return groupOrder
		.filter((label) => map.has(label))
		.map((label) => ({
			label,
			changes: map.get(label) ?? [],
		}));
}
