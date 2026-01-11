/**
 * DX-030: REPL Main Entry Point
 *
 * Interactive REPL for exploring schema and executing queries.
 */

import { Box, render, Text, useApp, useInput } from 'ink';
import React, { useCallback, useMemo, useState } from 'react';
import { CompletionProvider, type CompletionSuggestion } from './completion.js';
import {
	CompletionDisplay,
	Header,
	HelpDisplay,
	InputPrompt,
	OutputDisplay,
	SchemaSidebar,
} from './components/index.js';
import { getHistory } from './history.js';
import { ParseError, parseNaturalQuery } from './parser.js';
import { executeQuery } from './query-executor.js';
import type { QueryMode, QueryResult, ReplConfig } from './types.js';

interface ReplAppProps {
	config: ReplConfig;
}

/**
 * Get relation description for display
 */
function getRelationDescription(rel: { kind: string; target: string }): string {
	return `${rel.kind} → ${rel.target}`;
}

function ReplApp({ config }: ReplAppProps) {
	const { exit } = useApp();
	const [mode, setMode] = useState<QueryMode>('natural');
	const [showHelp, setShowHelp] = useState(false);
	const [output, setOutput] = useState<React.ReactNode | null>(null);
	const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
	const [inputKey, setInputKey] = useState(0);
	const [splitView, setSplitView] = useState(false);

	// Get command history singleton
	const history = useMemo(() => getHistory(), []);

	// Create completion provider
	const completionProvider = useMemo(
		() => new CompletionProvider(config.schema),
		[config.schema],
	);
	const [completions, setCompletions] = useState<CompletionSuggestion[]>([]);

	// Handle special keys
	useInput((inputChar, key) => {
		if (key.ctrl && inputChar === 'c') {
			exit();
		}
	});

	// Handle input changes for completions
	const handleInputChange = useCallback(
		(value: string) => {
			if (mode === 'natural') {
				const suggestions = completionProvider.complete(value);
				setCompletions(suggestions);
			} else {
				setCompletions([]);
			}
		},
		[completionProvider, mode],
	);

	const handleSubmit = useCallback(
		(value: string) => {
			const trimmed = value.trim();
			if (!trimmed) return;

			// Increment key to reset input and clear completions
			setInputKey((k) => k + 1);
			setCompletions([]);

			// Handle dot commands
			if (trimmed.startsWith('.')) {
				const [cmd, ...args] = trimmed.split(' ');

				switch (cmd) {
					case '.help':
						setShowHelp(true);
						setOutput(null);
						setQueryResult(null);
						return;

					case '.exit':
				case '.quit':
					exit();
					return;

					case '.clear':
						setShowHelp(false);
						setOutput(null);
						setQueryResult(null);
						return;

					case '.sql':
						setMode('sql');
						setOutput(
							<Text color="yellow">
								Switched to SQL mode. Use .natural to return.
							</Text>,
						);
						setQueryResult(null);
						setShowHelp(false);
						return;

					case '.natural':
						setMode('natural');
						setOutput(
							<Text color="green">
								Switched to natural query mode. Use .sql for raw SQL.
							</Text>,
						);
						setQueryResult(null);
						setShowHelp(false);
						return;

					case '.tables': {
						const tables = Object.keys(config.schema.tables);
						setShowHelp(false);
						setQueryResult(null);
						setOutput(
							<Box flexDirection="column" marginY={1}>
								<Text bold color="cyan">
									📋 Tables ({tables.length}):
								</Text>
								{tables.map((table) => (
									<Text key={table}> • {table}</Text>
								))}
							</Box>,
						);
						return;
					}

					case '.relations': {
						const relations = Object.entries(config.schema.relations);
						setShowHelp(false);
						setQueryResult(null);
						setOutput(
							<Box flexDirection="column" marginY={1}>
								<Text bold color="cyan">
									🔗 Relations ({relations.length}):
								</Text>
								{relations.map(([name, rel]) => (
									<Text key={name}>
										{' '}
										• {name}: {getRelationDescription(rel)}
									</Text>
								))}
							</Box>,
						);
						return;
					}

					case '.schema': {
						const tableName = args[0];
						if (tableName) {
							const table = config.schema.tables[tableName];
							if (!table) {
								setOutput(
									<Text color="red">❌ Table not found: {tableName}</Text>,
								);
								setQueryResult(null);
								setShowHelp(false);
								return;
							}
							// TableDefinition IS the columns map (Record<string, ColumnDefinition>)
							const columns = Object.entries(table);
							setOutput(
								<Box flexDirection="column" marginY={1}>
									<Text bold color="cyan">
										📊 Table: {tableName}
									</Text>
									<Text bold color="gray" dimColor>
										Columns:
									</Text>
									{columns.map(([col, def]) => {
										if (!def) return null;
										return (
											<Text key={col}>
												{' '}
												• {col}: {def.type}
												{def.nullable ? '' : ' (NOT NULL)'}
											</Text>
										);
									})}
								</Box>,
							);
						} else {
							// Show full schema summary
							const tableCount = Object.keys(config.schema.tables).length;
							const relationCount = Object.keys(config.schema.relations).length;
							setOutput(
								<Box flexDirection="column" marginY={1}>
									<Text bold color="cyan">
										📊 Schema Summary:
									</Text>
									<Text> • Tables: {tableCount}</Text>
									<Text> • Relations: {relationCount}</Text>
									<Text color="gray">
										Use .schema &lt;table&gt; for details
									</Text>
								</Box>,
							);
						}
						setQueryResult(null);
						setShowHelp(false);
						return;
					}

					case '.split':
						setSplitView((prev) => !prev);
						setOutput(
							<Text color="cyan">
								{splitView
									? '📋 Single view mode'
									: '📊 Split view mode (schema | query)'}
							</Text>,
						);
						setQueryResult(null);
						setShowHelp(false);
						return;

					case '.history': {
						const recent = history.getRecent(20);
						setShowHelp(false);
						setQueryResult(null);
						if (recent.length === 0) {
							setOutput(<Text color="gray">No command history yet.</Text>);
						} else {
							setOutput(
								<Box flexDirection="column" marginY={1}>
									<Text bold color="cyan">
										📜 Recent Commands ({recent.length}):
									</Text>
									{recent.map((cmd, idx) => (
										<Text key={idx} color="gray">
											{' '}
											{idx + 1}. {cmd}
										</Text>
									))}
								</Box>,
							);
						}
						return;
					}

					default:
						setOutput(
							<Text color="red">
								❌ Unknown command: {cmd}. Type .help for available commands.
							</Text>,
						);
						setQueryResult(null);
						setShowHelp(false);
						return;
				}
			}

			// Handle query execution
			setShowHelp(false);
			setOutput(null);

			if (mode === 'natural') {
				try {
					const parsed = parseNaturalQuery(trimmed, config.schema);
					const result = executeQuery(parsed, config.schema);

					if (result.error) {
						setQueryResult({
							sql: '',
							params: [],
							error: result.error,
						});
					} else {
						setQueryResult({
							sql: result.sql,
							params: result.params,
							plan: result.plan,
						});
					}
				} catch (err) {
					if (err instanceof ParseError) {
						setQueryResult({
							sql: '',
							params: [],
							error: err.message,
						});
					} else {
						setQueryResult({
							sql: '',
							params: [],
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
			} else {
				// SQL mode - pass through (compile-only, no execution)
				setQueryResult({
					sql: trimmed,
					params: [],
					plan: {
						strategy: 'RAW_SQL',
						tables: [],
						warnings: ['SQL mode: query displayed as-is (no execution)'],
					},
				});
			}
		},
		[config.schema, exit, mode],
	);

	const tableCount = Object.keys(config.schema.tables).length;
	const relationCount = Object.keys(config.schema.relations).length;

	// Content area (output, completions, input)
	const contentArea = (
		<Box flexDirection="column">
			{/* Output area */}
			{showHelp && <HelpDisplay />}
			{output}
			<OutputDisplay result={queryResult} />

			{/* Completions (only in natural mode) */}
			{mode === 'natural' && completions.length > 0 && !showHelp && (
				<CompletionDisplay suggestions={completions} />
			)}

			{/* Input area */}
			<InputPrompt
				onSubmit={handleSubmit}
				mode={mode}
				resetKey={inputKey}
				history={history}
				onInputChange={handleInputChange}
			/>
		</Box>
	);

	return (
		<Box flexDirection="column" padding={1}>
			<Header
				schemaPath={config.schemaPath}
				mode={mode}
				tableCount={tableCount}
				relationCount={relationCount}
			/>

			{/* Main content - either split or single view */}
			{splitView ? (
				<Box flexDirection="row">
					{/* Schema sidebar */}
					<Box marginRight={1}>
						<SchemaSidebar schema={config.schema} />
					</Box>
					{/* Query area - takes remaining space */}
					<Box flexDirection="column" flexGrow={1}>
						{/* Output area */}
						{showHelp && <HelpDisplay />}
						{output}
						<OutputDisplay result={queryResult} />

						{/* Completions (only in natural mode) */}
						{mode === 'natural' && completions.length > 0 && !showHelp && (
							<CompletionDisplay suggestions={completions} />
						)}

						{/* Input area */}
						<InputPrompt
							onSubmit={handleSubmit}
							mode={mode}
							resetKey={inputKey}
							history={history}
							onInputChange={handleInputChange}
						/>
					</Box>
				</Box>
			) : (
				contentArea
			)}
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
