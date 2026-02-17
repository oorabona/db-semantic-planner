import { useCallback } from 'react';
import { toast } from 'sonner';
import { sidecarApi } from '@/lib/ipc';
import { useConnectionStore } from '@/stores/connection-store';
import { getActiveTab, useEditorStore } from '@/stores/editor-store';
import { useHistoryStore } from '@/stores/history-store';
import { type QueryResult, useResultsStore } from '@/stores/results-store';
import { useUserSettingsStore } from '@/stores/user-settings-store';
import { EditorToolbar } from './EditorToolbar';
import { MonacoWrapper } from './MonacoWrapper';

export function SqlEditor() {
	const activeTab = useEditorStore(getActiveTab);
	const updateContent = useEditorStore((s) => s.updateContent);
	const active = useConnectionStore((s) => s.active);
	const { setResult, setExecuting, setError } = useResultsStore.getState();

	const handleRun = useCallback(async () => {
		if (!activeTab) return;
		if (!active) {
			toast.warning(
				'No connection — plan-only mode. Connect to a database to execute queries.',
			);
			return;
		}

		const content = activeTab.content.trim();
		if (!content) return;

		const maxRows = useUserSettingsStore.getState().maxResults;
		const startTime = Date.now();
		setExecuting(true);
		try {
			let raw: unknown;
			if (activeTab.language === 'nql') {
				raw = await sidecarApi.executeNQL({
					connectionId: active.connectionId,
					nql: content,
					maxRows,
				});
			} else {
				raw = await sidecarApi.executeSQL({
					connectionId: active.connectionId,
					sql: content,
					maxRows,
				});
			}

			// Normalize sidecar response to QueryResult
			const response = raw as Record<string, unknown>;
			const rows = (response.rows ?? []) as Record<string, unknown>[];
			const columns =
				rows.length > 0
					? Object.keys(rows[0] ?? {})
					: ((response.columns ?? []) as string[]);

			const durationMs = (response.durationMs as number) ?? 0;
			const result: QueryResult = {
				columns,
				rows,
				durationMs,
				totalRows: response.totalRows as number | undefined,
				truncated: response.truncated as boolean | undefined,
				cursorId: response.cursorId as string | undefined,
				sql: response.sql as string | undefined,
				params: response.params as unknown[] | undefined,
				plan: response.plan,
			};
			setResult(result);

			useHistoryStore.getState().addEntry({
				query: content,
				language: activeTab.language === 'nql' ? 'nql' : 'sql',
				database: active.database,
				timestamp: startTime,
				durationMs,
				rowCount: rows.length,
				success: true,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Query failed';
			setError(message);

			useHistoryStore.getState().addEntry({
				query: content,
				language: activeTab.language === 'nql' ? 'nql' : 'sql',
				database: active.database,
				timestamp: startTime,
				durationMs: Date.now() - startTime,
				rowCount: null,
				success: false,
				error: message,
			});
		}
	}, [activeTab, active, setResult, setExecuting, setError]);

	const handleChange = useCallback(
		(value: string) => {
			if (activeTab) {
				updateContent(activeTab.id, value);
			}
		},
		[activeTab, updateContent],
	);

	if (!activeTab) {
		return (
			<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
				Open a tab to start writing queries
			</div>
		);
	}

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<EditorToolbar
				onRun={handleRun}
				running={false}
				language={activeTab.language}
			/>
			<MonacoWrapper
				value={activeTab.content}
				language={activeTab.language}
				onChange={handleChange}
				onRun={handleRun}
			/>
		</div>
	);
}
