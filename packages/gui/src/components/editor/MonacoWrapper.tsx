import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { type MutableRefObject, useCallback, useEffect, useRef } from 'react';
import { useMonacoTheme } from '@/hooks/useEffectiveTheme';
import { NQL_LANGUAGE_ID } from '@/lib/nql-monarch';

interface MonacoWrapperProps {
	value: string;
	language: string;
	onChange: (value: string) => void;
	onRun: () => void;
	onRunSelection?: (text: string) => void;
	/** Optional ref to expose the Monaco editor instance to the parent */
	editorInstanceRef?: MutableRefObject<MonacoEditor.IStandaloneCodeEditor | null>;
}

export function MonacoWrapper({
	value,
	language,
	onChange,
	onRun,
	onRunSelection,
	editorInstanceRef,
}: MonacoWrapperProps) {
	const monacoTheme = useMonacoTheme();
	const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);

	// Stable refs so Monaco actions always call the latest callbacks
	const onRunRef = useRef(onRun);
	useEffect(() => {
		onRunRef.current = onRun;
	}, [onRun]);

	const onRunSelectionRef = useRef(onRunSelection);
	useEffect(() => {
		onRunSelectionRef.current = onRunSelection;
	}, [onRunSelection]);

	const handleMount: OnMount = useCallback(
		(editor, monaco) => {
			editorRef.current = editor;
			if (editorInstanceRef) {
				editorInstanceRef.current = editor;
			}

			// Cmd/Ctrl+Enter → Run all
			editor.addAction({
				id: 'run-query',
				label: 'Run Query',
				keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
				run: () => onRunRef.current(),
			});

			// Shift+Cmd/Ctrl+Enter → Run selection
			editor.addAction({
				id: 'run-selection',
				label: 'Run Selection',
				keybindings: [
					monaco.KeyMod.Shift | monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
				],
				run: (ed) => {
					const selection = ed.getSelection();
					const model = ed.getModel();
					if (selection && !selection.isEmpty() && model) {
						const text = model.getValueInRange(selection).trim();
						if (text) {
							onRunSelectionRef.current?.(text);
						}
					}
				},
			});

			// Focus editor on mount
			editor.focus();
		},
		[editorInstanceRef],
	);

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
