/**
 * Tab bar for Results panel: Results | SQL | Plan | Params | Assertions
 */
import {
	CheckCircle,
	Code,
	GitCompareArrows,
	History,
	Map as MapIcon,
	ScrollText,
	Settings2,
	Table,
} from 'lucide-react';
import { useAssertionStore } from '@/stores/assertion-store';
import { useConnectionStore } from '@/stores/connection-store';
import { type ResultsTab, useResultsStore } from '@/stores/results-store';
import { useSchemaDiffStore } from '@/stores/schema-diff-store';

const TABS: Array<{ id: ResultsTab; label: string; Icon: typeof Table }> = [
	{ id: 'results', label: 'Results', Icon: Table },
	{ id: 'sql', label: 'SQL', Icon: Code },
	{ id: 'plan', label: 'Plan', Icon: MapIcon },
	{ id: 'params', label: 'Params', Icon: Settings2 },
	{ id: 'assertions', label: 'Assertions', Icon: CheckCircle },
	{ id: 'schema-diff', label: 'Schema Diff', Icon: GitCompareArrows },
	{ id: 'history', label: 'History', Icon: History },
	{ id: 'logs', label: 'Logs', Icon: ScrollText },
];

export function ResultsTabs() {
	const activeTab = useResultsStore((s) => s.activeTab);
	const setActiveTab = useResultsStore((s) => s.setActiveTab);
	const result = useResultsStore((s) => s.result);
	const assertionResult = useAssertionStore((s) => s.result);
	const schemaDiff = useSchemaDiffStore((s) => s.diff);
	const hasProfiles = useConnectionStore((s) => s.profiles.length > 0);
	const isConnected = useConnectionStore((s) => s.status === 'connected');

	return (
		<div className="flex items-center gap-1 border-b px-2">
			{TABS.map(({ id, label, Icon }) => {
				const isActive = activeTab === id;
				const isDisabled =
					(id === 'results' && !hasProfiles && !isConnected && !result) ||
					(id === 'sql' && !result?.sql) ||
					(id === 'plan' && !result?.plan) ||
					(id === 'params' && !result?.params?.length) ||
					(id === 'assertions' && !assertionResult) ||
					(id === 'schema-diff' && !schemaDiff);

				const tooltip =
					id === 'results' && !hasProfiles && !isConnected && !result
						? 'No connection — plan-only mode'
						: undefined;

				return (
					<button
						key={id}
						type="button"
						title={tooltip}
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
