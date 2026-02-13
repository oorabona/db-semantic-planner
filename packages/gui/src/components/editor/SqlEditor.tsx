import { useCallback, useState } from "react";
import { useEditorStore, getActiveTab } from "@/stores/editor-store";
import { useConnectionStore } from "@/stores/connection-store";
import { sidecarApi } from "@/lib/ipc";
import { MonacoWrapper } from "./MonacoWrapper";
import { EditorToolbar } from "./EditorToolbar";

interface SqlEditorProps {
	onQueryResult?: (result: unknown) => void;
	onError?: (error: string) => void;
}

export function SqlEditor({ onQueryResult, onError }: SqlEditorProps) {
	const activeTab = useEditorStore(getActiveTab);
	const updateContent = useEditorStore((s) => s.updateContent);
	const active = useConnectionStore((s) => s.active);
	const [running, setRunning] = useState(false);

	const handleRun = useCallback(async () => {
		if (!activeTab || !active) return;

		const content = activeTab.content.trim();
		if (!content) return;

		setRunning(true);
		try {
			if (activeTab.language === "nql") {
				const result = await sidecarApi.executeNQL({
					connectionId: active.connectionId,
					nql: content,
				});
				onQueryResult?.(result);
			} else {
				const result = await sidecarApi.executeSQL({
					connectionId: active.connectionId,
					sql: content,
				});
				onQueryResult?.(result);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : "Query failed";
			onError?.(message);
		} finally {
			setRunning(false);
		}
	}, [activeTab, active, onQueryResult, onError]);

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
				running={running}
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
