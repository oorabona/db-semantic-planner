/**
 * Results panel with tabbed views: Results, SQL, Plan, Params.
 */

import { DataTable } from '@/components/results/DataTable';
import { EmptyState } from '@/components/results/EmptyState';
import { PlanInspector } from '@/components/results/PlanInspector';
import { ResultsTabs } from '@/components/results/ResultsTabs';
import { StatusBar } from '@/components/results/StatusBar';
import { useResultsStore } from '@/stores/results-store';

export function ResultsPanel() {
	const result = useResultsStore((s) => s.result);
	const activeTab = useResultsStore((s) => s.activeTab);
	const executing = useResultsStore((s) => s.executing);

	return (
		<div className="flex h-full flex-col bg-background">
			<ResultsTabs />

			<div className="flex flex-1 overflow-hidden">
				{activeTab === 'results' && (
					<>
						{executing && (
							<div className="flex flex-1 items-center justify-center">
								<span className="text-sm text-muted-foreground">
									Executing query...
								</span>
							</div>
						)}
						{!executing && !result && <EmptyState />}
						{!executing && result && (
							<DataTable columns={result.columns} rows={result.rows} />
						)}
					</>
				)}

				{activeTab === 'sql' && result?.sql && (
					<div className="flex-1 overflow-auto p-3">
						<pre className="whitespace-pre-wrap font-mono text-xs">
							{result.sql}
						</pre>
					</div>
				)}

				{activeTab === 'plan' && result?.plan != null && (
					<div className="flex-1 overflow-auto p-3">
						<PlanInspector plan={result.plan} />
					</div>
				)}

				{activeTab === 'params' && result?.params && (
					<div className="flex-1 overflow-auto p-3">
						<pre className="whitespace-pre-wrap font-mono text-xs">
							{JSON.stringify(result.params, null, 2)}
						</pre>
					</div>
				)}
			</div>

			<StatusBar />
		</div>
	);
}
