import { useEffect } from "react";
import { useEditorStore } from "@/stores/editor-store";
import { EditorTabs } from "@/components/editor/EditorTabs";
import { SqlEditor } from "@/components/editor/SqlEditor";

interface EditorPanelProps {
	onQueryResult?: (result: unknown) => void;
	onError?: (error: string) => void;
}

export function EditorPanel({ onQueryResult, onError }: EditorPanelProps) {
	const tabs = useEditorStore((s) => s.tabs);
	const addTab = useEditorStore((s) => s.addTab);

	// Auto-create first tab if none exist
	useEffect(() => {
		if (tabs.length === 0) {
			addTab("sql");
		}
	}, [tabs.length, addTab]);

	return (
		<div className="flex h-full flex-col bg-background">
			<EditorTabs />
			<SqlEditor onQueryResult={onQueryResult} onError={onError} />
		</div>
	);
}
