/**
 * DX-030: REPL Main Entry Point
 *
 * Thin Ink UI wrapper around ReplEngine + ConversationView.
 * Business logic lives in engine/repl-engine.ts.
 * History is displayed as a scrollable conversation.
 */

import { Box, render, useApp, useInput } from 'ink';
import React, {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import type { CompletionSuggestion } from './completion.js';
import {
	CompletionDisplay,
	Header,
	HelpDisplay,
	InputPrompt,
} from './components/index.js';
import { ConversationManager, ConversationView } from './conversation/index.js';
import { getDatabaseName } from './db-connection.js';
import {
	type EngineEvent,
	type EngineState,
	ReplEngine,
} from './engine/index.js';
import { getHistory } from './history.js';
import type { ReplConfig } from './types.js';

interface ReplAppProps {
	config: ReplConfig;
}

function ReplApp({ config }: ReplAppProps) {
	const { exit } = useApp();

	// --- Engine (owns all business state) ---
	const engineRef = useRef<ReplEngine | null>(null);
	if (!engineRef.current) {
		engineRef.current = new ReplEngine({
			schema: config.schema,
			schemaPath: config.schemaPath,
			...(config.databaseUrl !== undefined && {
				databaseUrl: config.databaseUrl,
			}),
			...(config.initialSchemaName !== undefined && {
				initialSchemaName: config.initialSchemaName,
			}),
			...(config.initialParseMode !== undefined && {
				initialParseMode: config.initialParseMode,
			}),
			...(config.initialExecMode !== undefined && {
				initialExecMode: config.initialExecMode,
			}),
			...(config.dbCasing !== undefined && { dbCasing: config.dbCasing }),
		});
	}
	const engine = engineRef.current;

	// --- Conversation model (stacked entries) ---
	const conversationRef = useRef<ConversationManager | null>(null);
	if (!conversationRef.current) {
		conversationRef.current = new ConversationManager();
	}
	const conversation = conversationRef.current;

	// --- UI-only state ---
	const [engineState, setEngineState] = useState<EngineState>(
		engine.getState(),
	);
	const [entries, setEntries] = useState(conversation.getEntries());
	const [showHelp, setShowHelp] = useState(false);
	const [inputKey, setInputKey] = useState(0);
	// Re-render trigger (incremented when conversation changes)
	const [, setRenderTick] = useState(0);

	// --- Completions ---
	const completionProvider = useMemo(
		() => engine.getCompletionProvider(),
		[engine],
	);
	const [completions, setCompletions] = useState<CompletionSuggestion[]>([]);
	const [selectedCompletionIndex, setSelectedCompletionIndex] = useState(-1);

	// Get command history singleton
	const history = useMemo(() => getHistory(), []);

	// --- Engine initialization (DB connection) ---
	useEffect(() => {
		engine.init();
		return () => {
			engine.destroy();
		};
	}, [engine]);

	// --- Engine event subscription ---
	// Track the current entry being built
	const currentEntryIdRef = useRef<number | null>(null);

	useEffect(() => {
		const refreshEntries = () => setEntries([...conversation.getEntries()]);

		/** Append event to current entry, or create synthetic entry if orphan. */
		const appendToCurrentOrCreate = (event: EngineEvent) => {
			if (currentEntryIdRef.current !== null) {
				conversation.appendEvent(currentEntryIdRef.current, event);
			} else {
				const entry = conversation.addEntry('');
				conversation.appendEvent(entry.id, event);
			}
			refreshEntries();
		};

		const unsub = engine.on((event: EngineEvent) => {
			switch (event.type) {
				case 'state-change':
					setEngineState(event.state);
					break;

				case 'exit':
					exit();
					break;

				case 'clear':
					conversation.clear();
					setShowHelp(false);
					refreshEntries();
					break;

				case 'info':
					if (event.message === 'SHOW_HELP') {
						setShowHelp(true);
						break;
					}
					appendToCurrentOrCreate(event);
					break;

				case 'error':
					appendToCurrentOrCreate(event);
					break;

				case 'query-result':
				case 'execution-result':
					if (currentEntryIdRef.current !== null) {
						conversation.appendEvent(currentEntryIdRef.current, event);
						refreshEntries();
					}
					break;

				case 'show-history': {
					const recent = history.getRecent(20);
					const msg =
						recent.length === 0
							? 'No command history yet.'
							: `📜 Recent Commands (${recent.length}):\n${recent.map((cmd, i) => `  ${i + 1}. ${cmd}`).join('\n')}`;
					appendToCurrentOrCreate({ type: 'info', message: msg });
					break;
				}
			}
		});
		return unsub;
	}, [engine, conversation, exit]);

	// --- Input handling ---
	useInput((inputChar, key) => {
		if (key.ctrl && inputChar === 'c') {
			exit();
		}
		// Tab: cycle through completions
		if (key.tab && completions.length > 0 && engineState.mode === 'natural') {
			const nextIndex =
				selectedCompletionIndex < 0
					? 0
					: (selectedCompletionIndex + 1) % completions.length;
			setSelectedCompletionIndex(nextIndex);
		}
	});

	const handleInputChange = useCallback(
		(value: string) => {
			setSelectedCompletionIndex(-1);
			if (engineState.mode === 'natural') {
				const suggestions = completionProvider.complete(value);
				setCompletions(suggestions);
			} else {
				setCompletions([]);
			}
		},
		[completionProvider, engineState.mode],
	);

	const handleCompletionAccepted = useCallback(() => {
		setSelectedCompletionIndex(-1);
		setCompletions([]);
	}, []);

	const handleApplyCompletion = useCallback(
		(currentInput: string, completionText: string) => {
			return completionProvider.applyCompletion(currentInput, completionText);
		},
		[completionProvider],
	);

	const selectedCompletion =
		selectedCompletionIndex >= 0
			? completions[selectedCompletionIndex]?.text
			: undefined;

	const handleSubmit = useCallback(
		async (value: string) => {
			const trimmed = value.trim();
			if (!trimmed) return;

			// Reset UI
			setInputKey((k) => k + 1);
			setCompletions([]);
			setShowHelp(false);

			// Create conversation entry BEFORE submitting to engine
			const entry = conversation.addEntry(trimmed);
			currentEntryIdRef.current = entry.id;
			setEntries([...conversation.getEntries()]);

			// Submit to engine (events flow back via subscription)
			await engine.submit(trimmed);

			// Clear current entry ref
			currentEntryIdRef.current = null;
		},
		[engine, conversation],
	);

	// --- Derived values for Header ---
	const tableCount = config.schema.tableNames.length;
	const relationCount = config.schema.model.relations.size;

	// --- Render ---
	const contentArea = (
		<Box flexDirection="column">
			{showHelp && <HelpDisplay />}

			{/* Conversation history */}
			<ConversationView entries={entries} />

			{/* Completions (only in natural mode) */}
			{engineState.mode === 'natural' &&
				completions.length > 0 &&
				!showHelp && (
					<CompletionDisplay
						suggestions={completions}
						selectedIndex={selectedCompletionIndex}
					/>
				)}

			{/* Input area */}
			<InputPrompt
				onSubmit={handleSubmit}
				mode={engineState.mode}
				resetKey={inputKey}
				history={history}
				onInputChange={handleInputChange}
				{...(selectedCompletion !== undefined && { selectedCompletion })}
				onCompletionAccepted={handleCompletionAccepted}
				applyCompletion={handleApplyCompletion}
			/>
		</Box>
	);

	return (
		<Box flexDirection="column" padding={1}>
			<Header
				schemaPath={config.schemaPath}
				mode={engineState.mode}
				tableCount={tableCount}
				relationCount={relationCount}
				dialect={engineState.dialect}
				includeStrategy={engineState.includeStrategy}
				aliasingMode={engineState.aliasingMode}
				connected={engineState.connected}
				execMode={engineState.execMode}
				parseMode={engineState.parseMode}
				explainMode={engineState.explainMode}
				{...(engineState.schemaName && { schemaName: engineState.schemaName })}
				{...(config.databaseUrl && {
					databaseName: getDatabaseName(config.databaseUrl),
				})}
			/>

			{contentArea}
		</Box>
	);
}

/**
 * Start the REPL with the given configuration
 */
export async function startRepl(config: ReplConfig): Promise<void> {
	console.log('Starting REPL...\n');

	const instance = render(<ReplApp config={config} />);
	await instance.waitUntilExit();
}
