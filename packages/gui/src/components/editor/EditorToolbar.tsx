import { Loader2, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { TabLanguage } from '@/stores/editor-store';

interface EditorToolbarProps {
	onRun: () => void;
	running: boolean;
	language: TabLanguage;
}

export function EditorToolbar({
	onRun,
	running,
	language,
}: EditorToolbarProps) {
	return (
		<div className="flex items-center gap-2 border-b px-2 py-1">
			<Button
				variant="ghost"
				size="sm"
				className="h-6 gap-1 px-2 text-xs"
				onClick={onRun}
				disabled={running}
				title="Run query (Cmd/Ctrl+Enter)"
			>
				{running ? (
					<Loader2 className="h-3.5 w-3.5 animate-spin" />
				) : (
					<Play className="h-3.5 w-3.5" />
				)}
				Run
			</Button>
			<span className="text-xs text-muted-foreground">
				{language === 'sql' ? 'SQL' : language === 'assert' ? 'Assert' : 'NQL'}{' '}
				· Cmd+Enter
			</span>
		</div>
	);
}
