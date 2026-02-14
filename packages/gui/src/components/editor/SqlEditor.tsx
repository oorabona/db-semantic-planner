import { useCallback } from 'react';
import { sidecarApi } from '@/lib/ipc';
import { useConnectionStore } from '@/stores/connection-store';
import { getActiveTab, useEditorStore } from '@/stores/editor-store';
import { type QueryResult, useResultsStore } from '@/stores/results-store';
import { EditorToolbar } from './EditorToolbar';
import { MonacoWrapper } from './MonacoWrapper';

export function SqlEditor() {
	const activeTab = useEditorStore(getActiveTab);
	const updateContent = useEditorStore((s) => s.updateContent);
	const active = useConnectionStore((s) => s.active);
	const { setResult, setExecuting, setError } = useResultsStore.getState();

	const handleRun = useCallback(async () => {
		if (!activeTab || !active) return;

		const content = activeTab.content.trim();
		if (!content) return;

		setExecuting(true);
		try {
			let raw: unknown;
			if (activeTab.language === 'nql') {
				raw = await sidecarApi.executeNQL({
					connectionId: active.connectionId,
					nql: content,
				});
			} else {
				raw = await sidecarApi.executeSQL({
					connectionId: active.connectionId,
					sql: content,
				});
			}

			// Normalize sidecar response to QueryResult
			const response = raw as Record<string, unknown>;
			const rows = (response.rows ?? []) as Record<string, unknown>[];
			const columns =
				rows.length > 0
					? Object.keys(rows[0] ?? {})
					: ((response.columns ?? []) as string[]);

			const result: QueryResult = {
				columns,
				rows,
				durationMs: (response.durationMs as number) ?? 0,
				totalRows: response.totalRows as number | undefined,
				truncated: response.truncated as boolean | undefined,
				cursorId: response.cursorId as string | undefined,
				sql: response.sql as string | undefined,
				params: response.params as unknown[] | undefined,
				plan: response.plan,
			};
			setResult(result);
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Query failed';
			setError(message);
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
