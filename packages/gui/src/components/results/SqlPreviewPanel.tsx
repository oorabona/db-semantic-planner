/**
 * SQL preview panel with UP/DOWN tabs for schema diff.
 */
import { useState } from 'react';

interface SqlPreviewPanelProps {
	plan: {
		readonly autocommit: readonly string[];
		readonly main: readonly string[];
	};
	downSQL: readonly string[];
}

export function SqlPreviewPanel({ plan, downSQL }: SqlPreviewPanelProps) {
	const [tab, setTab] = useState<'up' | 'down'>('up');
	const statements = plan.autocommit.length + plan.main.length;
	const selectedStatements =
		tab === 'down' ? downSQL : [...plan.autocommit, ...plan.main];

	return (
		<div
			className="flex flex-col border-t border-border"
			data-testid="sql-preview-panel"
		>
			<div className="flex gap-1 border-b border-border bg-muted/30 px-2 py-1">
				<TabButton
					active={tab === 'up'}
					onClick={() => setTab('up')}
					label={`UP (${statements})`}
					testId="sql-tab-up"
				/>
				<TabButton
					active={tab === 'down'}
					onClick={() => setTab('down')}
					label={`DOWN (${downSQL.length})`}
					testId="sql-tab-down"
				/>
			</div>
			<div
				className="max-h-48 overflow-auto bg-muted/10 p-2"
				data-testid="sql-preview-content"
			>
				{selectedStatements.length === 0 ? (
					<p className="text-xs text-muted-foreground italic">
						No SQL statements
					</p>
				) : (
					<pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
						{tab === 'down'
							? downSQL.join('\n\n')
							: `${plan.autocommit.length > 0 ? `-- AUTOCOMMIT (durable before the main transaction)\n${plan.autocommit.join('\n\n')}\n\n` : ''}-- MAIN TRANSACTION\n${plan.main.join('\n\n')}`}
					</pre>
				)}
			</div>
		</div>
	);
}

function TabButton({
	active,
	onClick,
	label,
	testId,
}: {
	active: boolean;
	onClick: () => void;
	label: string;
	testId: string;
}) {
	return (
		<button
			type="button"
			className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
				active
					? 'bg-background text-foreground shadow-sm'
					: 'text-muted-foreground hover:text-foreground'
			}`}
			onClick={onClick}
			data-testid={testId}
		>
			{label}
		</button>
	);
}
