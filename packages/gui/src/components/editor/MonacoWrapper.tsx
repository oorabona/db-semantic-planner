import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { useCallback, useEffect, useRef } from 'react';
import { useMonacoTheme } from '@/hooks/useEffectiveTheme';
import { NQL_LANGUAGE_ID } from '@/lib/nql-monarch';

interface MonacoWrapperProps {
	value: string;
	language: string;
	onChange: (value: string) => void;
	onRun: () => void;
}

export function MonacoWrapper({
	value,
	language,
	onChange,
	onRun,
}: MonacoWrapperProps) {
	const monacoTheme = useMonacoTheme();
	const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);

	// Stable ref so the Monaco action always calls the latest onRun
	const onRunRef = useRef(onRun);
	useEffect(() => {
		onRunRef.current = onRun;
	}, [onRun]);

	const handleMount: OnMount = useCallback((editor, monaco) => {
		editorRef.current = editor;

		// Add Cmd/Ctrl+Enter keybinding for Run
		editor.addAction({
			id: 'run-query',
			label: 'Run Query',
			keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
			run: () => onRunRef.current(),
		});

		// Focus editor on mount
		editor.focus();
	}, []);

	return (
		<div className="flex-1 overflow-hidden">
			<Editor
				height="100%"
				language={
					language === 'nql' || language === 'assert'
						? NQL_LANGUAGE_ID
						: language
				}
				value={value}
				onChange={(v) => onChange(v ?? '')}
				onMount={handleMount}
				theme={monacoTheme}
				options={{
					minimap: { enabled: false },
					fontSize: 13,
					lineNumbers: 'on',
					scrollBeyondLastLine: false,
					wordWrap: 'on',
					tabSize: 2,
					automaticLayout: true,
					suggestOnTriggerCharacters: true,
					quickSuggestions: true,
					padding: { top: 8 },
				}}
			/>
		</div>
	);
}
