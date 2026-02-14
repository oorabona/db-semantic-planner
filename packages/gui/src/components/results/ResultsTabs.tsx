/**
 * Tab bar for Results panel: Results | SQL | Plan | Params | Assertions
 */
import {
	CheckCircle,
	Code,
	Map as MapIcon,
	Settings2,
	Table,
} from 'lucide-react';
import { useAssertionStore } from '@/stores/assertion-store';
import { type ResultsTab, useResultsStore } from '@/stores/results-store';

const TABS: Array<{ id: ResultsTab; label: string; Icon: typeof Table }> = [
	{ id: 'results', label: 'Results', Icon: Table },
	{ id: 'sql', label: 'SQL', Icon: Code },
	{ id: 'plan', label: 'Plan', Icon: MapIcon },
	{ id: 'params', label: 'Params', Icon: Settings2 },
	{ id: 'assertions', label: 'Assertions', Icon: CheckCircle },
];

export function ResultsTabs() {
	const activeTab = useResultsStore((s) => s.activeTab);
	const setActiveTab = useResultsStore((s) => s.setActiveTab);
	const result = useResultsStore((s) => s.result);
	const assertionResult = useAssertionStore((s) => s.result);

	return (
		<div className="flex items-center gap-1 border-b px-2">
			{TABS.map(({ id, label, Icon }) => {
				const isActive = activeTab === id;
				const isDisabled =
					(id === 'sql' && !result?.sql) ||
					(id === 'plan' && !result?.plan) ||
					(id === 'params' && !result?.params?.length) ||
					(id === 'assertions' && !assertionResult);

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
