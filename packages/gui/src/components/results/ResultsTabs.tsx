/**
 * Tab bar for Results panel: Results | SQL | Plan | Params
 */
import { Table, Code, Map, Settings2 } from 'lucide-react';
import { useResultsStore, type ResultsTab } from '@/stores/results-store';

const TABS: Array<{ id: ResultsTab; label: string; Icon: typeof Table }> = [
	{ id: 'results', label: 'Results', Icon: Table },
	{ id: 'sql', label: 'SQL', Icon: Code },
	{ id: 'plan', label: 'Plan', Icon: Map },
	{ id: 'params', label: 'Params', Icon: Settings2 },
];

export function ResultsTabs() {
	const activeTab = useResultsStore((s) => s.activeTab);
	const setActiveTab = useResultsStore((s) => s.setActiveTab);
	const result = useResultsStore((s) => s.result);

	return (
		<div className="flex items-center gap-1 border-b px-2">
			{TABS.map(({ id, label, Icon }) => {
				const isActive = activeTab === id;
				const isDisabled =
					(id === 'sql' && !result?.sql) ||
					(id === 'plan' && !result?.plan) ||
					(id === 'params' && !result?.params?.length);

				return (
					<button
						key={id}
						type="button"
						className={`flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors ${
							isActive
								? 'border-b-2 border-primary font-medium'
								: 'text-muted-foreground hover:text-foreground'
						} ${isDisabled ? 'opacity-40' : ''}`}
						onClick={() => setActiveTab(id)}
						disabled={isDisabled}
					>
						<Icon className="h-3.5 w-3.5" />
						{label}
					</button>
				);
			})}
		</div>
	);
}
