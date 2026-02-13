import { useEffect, useRef } from "react";
import { loader } from "@monaco-editor/react";
import {
	NQL_LANGUAGE_ID,
	nqlMonarchTokensProvider,
	nqlLanguageConfiguration,
} from "@/lib/nql-monarch";
import { createSqlCompletionProvider } from "@/lib/sql-completions";
import { createNqlCompletionProvider } from "@/lib/nql-completions";

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
			// Register NQL language
			monaco.languages.register({ id: NQL_LANGUAGE_ID, extensions: [".dbsp"] });
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
				"sql",
				createSqlCompletionProvider(),
			);
			monaco.languages.registerCompletionItemProvider(
				NQL_LANGUAGE_ID,
				createNqlCompletionProvider(),
			);
		});
	}, []);
}
