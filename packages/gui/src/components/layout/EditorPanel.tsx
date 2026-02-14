import { EditorTabs } from '@/components/editor/EditorTabs';
import { SqlEditor } from '@/components/editor/SqlEditor';
import { WelcomeScreen } from '@/components/layout/WelcomeScreen';
import { useEditorStore } from '@/stores/editor-store';

interface EditorPanelProps {
	onConnect: () => void;
}

export function EditorPanel({ onConnect }: EditorPanelProps) {
	const hasTabs = useEditorStore((s) => s.tabs.length > 0);

	if (!hasTabs) {
		return <WelcomeScreen onConnect={onConnect} />;
	}

	return (
		<div className="flex h-full flex-col bg-background">
			<EditorTabs />
			<SqlEditor />
		</div>
	);
}
