import { loader } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';
import { createNqlCompletionProvider } from '@/lib/nql-completions';
import {
	NQL_LANGUAGE_ID,
	nqlLanguageConfiguration,
	nqlMonarchTokensProvider,
} from '@/lib/nql-monarch';
import { createSqlCompletionProvider } from '@/lib/sql-completions';

/**
 * One-time Monaco editor setup:
 * - Register NQL language with Monarch tokenizer
 * - Register SQL/NQL completion providers
 */
export function useMonacoSetup() {
	const initialized = useRef(false);

	useEffect(() => {
		if (initialized.current) return;
		initialized.current = true;

		loader.init().then((monaco) => {
			// Define a light theme that matches the app's design
			monaco.editor.defineTheme('dbsp-light', {
				base: 'vs',
				inherit: true,
				rules: [],
				colors: {
					'editor.background': '#fafafa',
					'editor.foreground': '#1a1a1a',
					'editorLineNumber.foreground': '#999999',
					'editorLineNumber.activeForeground': '#444444',
					'editor.lineHighlightBackground': '#f0f0f0',
					'editor.selectionBackground': '#d0d0d0',
					'editorCursor.foreground': '#1a1a1a',
				},
			});

			monaco.editor.defineTheme('dbsp-dark', {
				base: 'vs-dark',
				inherit: true,
				rules: [],
				colors: {
					'editor.background': '#1a1a1a',
					'editor.foreground': '#fafafa',
					'editorLineNumber.foreground': '#666666',
					'editorLineNumber.activeForeground': '#bbbbbb',
					'editor.lineHighlightBackground': '#2a2a2a',
					'editor.selectionBackground': '#444444',
					'editorCursor.foreground': '#fafafa',
				},
			});

			// Register NQL language
			monaco.languages.register({ id: NQL_LANGUAGE_ID, extensions: ['.dbsp'] });
			monaco.languages.setMonarchTokensProvider(
				NQL_LANGUAGE_ID,
				nqlMonarchTokensProvider,
			);
			monaco.languages.setLanguageConfiguration(
				NQL_LANGUAGE_ID,
				nqlLanguageConfiguration,
			);

			// Register completion providers
			monaco.languages.registerCompletionItemProvider(
				'sql',
				createSqlCompletionProvider(),
			);
			monaco.languages.registerCompletionItemProvider(
				NQL_LANGUAGE_ID,
				createNqlCompletionProvider(),
			);
		});
	}, []);
}
