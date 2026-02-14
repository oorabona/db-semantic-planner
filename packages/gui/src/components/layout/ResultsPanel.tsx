/**
 * Results panel with tabbed views: Results, SQL, Plan, Params, Assertions.
 */

import { AssertionResults } from '@/components/results/AssertionResults';
import { DataTable } from '@/components/results/DataTable';
import { EmptyState } from '@/components/results/EmptyState';
import { PlanInspector } from '@/components/results/PlanInspector';
import { ResultsTabs } from '@/components/results/ResultsTabs';
import { StatusBar } from '@/components/results/StatusBar';
import { useAssertionStore } from '@/stores/assertion-store';
import { useResultsStore } from '@/stores/results-store';

export function ResultsPanel() {
	const result = useResultsStore((s) => s.result);
	const activeTab = useResultsStore((s) => s.activeTab);
	const executing = useResultsStore((s) => s.executing);
	const assertionResult = useAssertionStore((s) => s.result);
	const assertionRunning = useAssertionStore((s) => s.running);
	const assertionError = useAssertionStore((s) => s.error);

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

				{activeTab === 'assertions' && (
					<div className="flex-1 overflow-auto">
						{assertionRunning && (
							<div className="flex flex-1 items-center justify-center p-8">
								<span className="text-sm text-muted-foreground">
									Running assertions...
								</span>
							</div>
						)}
						{assertionError && (
							<div className="p-3 text-sm text-red-600 dark:text-red-400">
								{assertionError}
							</div>
						)}
						{!assertionRunning && !assertionError && assertionResult && (
							<AssertionResults result={assertionResult} />
						)}
						{!assertionRunning && !assertionError && !assertionResult && (
							<div className="flex flex-1 items-center justify-center p-8">
								<span className="text-sm text-muted-foreground">
									Open an .assert.dbsp file and run assertions to see results
								</span>
							</div>
						)}
					</div>
				)}
			</div>

			<StatusBar />
		</div>
	);
}
