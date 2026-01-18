/**
 * DX-030: REPL Main Entry Point
 *
 * Interactive REPL for exploring schema and executing queries.
 */

import { Box, render, Text, useApp, useInput } from 'ink';
import React, {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { CompletionProvider, type CompletionSuggestion } from './completion.js';
import {
	CompletionDisplay,
	Header,
	HelpDisplay,
	InputPrompt,
	OutputDisplay,
	SchemaSidebar,
} from './components/index.js';
import {
	createDbConnection,
	type DbConnection,
	type ExecutionResult,
	getDatabaseName,
} from './db-connection.js';
import { getHistory } from './history.js';
import { getModeWarning, parseInputMode } from './mode-escape.js';
import { ParseError, parseNaturalQuery } from './parser.js';
import { executeQuery } from './query-executor.js';
import { ExecutionResultDisplay } from './result-formatter.js';
import type {
	AliasingMode,
	DialectMode,
	IncludeStrategyMode,
	QueryMode,
	QueryResult,
	ReplConfig,
} from './types.js';

/**
 * Strategy information for user feedback (CLI-011)
 */
const STRATEGY_INFO: Record<
	IncludeStrategyMode,
	{
		name: string;
		description: string;
		pros: string[];
		cons: string[];
		dialects: DialectMode[];
	}
> = {
	auto: {
		name: 'AUTO',
		description:
			'Let the planner choose based on relation type and cardinality',
		pros: [
			'Optimal for mixed relations',
			'JOIN for belongsTo, SEPARATE for hasMany',
			'No manual tuning needed',
		],
		cons: [
			'Less predictable SQL output',
			'May not match specific performance needs',
		],
		dialects: ['postgresql', 'mysql', 'sqlite', 'mssql', 'duckdb'],
	},
	join: {
		name: 'JOIN',
		description: 'LEFT JOIN to fetch relations in a single query',
		pros: [
			'Single round-trip',
			'Database optimizer handles it',
			'Best for small/medium relations',
		],
		cons: [
			'May cause row duplication with hasMany',
			'Memory usage scales with result size',
		],
		dialects: ['postgresql', 'mysql', 'sqlite', 'mssql', 'duckdb'],
	},
	separate: {
		name: 'SEPARATE',
		description: 'Fetch relations in separate batched queries (IN clause)',
		pros: [
			'No row duplication',
			'Better for large hasMany relations',
			'Cleaner hydration',
		],
		cons: ['Multiple round-trips (N+1 batched)', 'More network overhead'],
		dialects: ['postgresql', 'mysql', 'sqlite', 'mssql', 'duckdb'],
	},
	cte: {
		name: 'CTE',
		description: 'WITH clause to materialize base query before joining',
		pros: [
			'Materializes complex filters once',
			'Good for repeated subqueries',
			'Can improve performance',
		],
		cons: ['Extra query planning overhead', 'Not always faster'],
		dialects: ['postgresql', 'mysql', 'sqlite', 'mssql', 'duckdb'],
	},
	lateral: {
		name: 'LATERAL',
		description: 'LATERAL JOIN for correlated subquery per parent',
		pros: [
			'Limit N children per parent',
			'Efficient for top-N queries',
			'No row explosion',
		],
		cons: ['PostgreSQL only', 'More complex query plan'],
		dialects: ['postgresql'],
	},
	json_agg: {
		name: 'JSON_AGG',
		description: 'Aggregate children as JSON array in single query',
		pros: ['No row duplication', 'Single query', 'Children embedded in result'],
		cons: ['Requires JSON parsing', 'Limited to PostgreSQL/MySQL 8+'],
		dialects: ['postgresql', 'mysql', 'duckdb'],
	},
};

/**
 * Dialect information for user feedback (CLI-011)
 */
const DIALECT_INFO: Record<
	DialectMode,
	{
		name: string;
		description: string;
		strategies: IncludeStrategyMode[];
	}
> = {
	postgresql: {
		name: 'PostgreSQL',
		description: 'Full-featured dialect with all strategies available',
		strategies: ['auto', 'join', 'separate', 'cte', 'lateral', 'json_agg'],
	},
	mysql: {
		name: 'MySQL',
		description: 'MySQL 8.0+ with CTE and JSON support',
		strategies: ['auto', 'join', 'separate', 'cte', 'json_agg'],
	},
	sqlite: {
		name: 'SQLite',
		description: 'Embedded database with basic strategy support',
		strategies: ['auto', 'join', 'separate', 'cte'],
	},
	mssql: {
		name: 'SQL Server',
		description: 'Microsoft SQL Server with CTE support',
		strategies: ['auto', 'join', 'separate', 'cte'],
	},
	duckdb: {
		name: 'DuckDB',
		description: 'Analytical database with PostgreSQL-like syntax',
		strategies: ['auto', 'join', 'separate', 'cte', 'json_agg'],
	},
};

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
	const [aliasingMode, setAliasingMode] = useState<AliasingMode>('always');
	const [includeStrategy, setIncludeStrategy] =
		useState<IncludeStrategyMode>('auto');
	const [dialect, setDialect] = useState<DialectMode>('postgresql');
	const [showHelp, setShowHelp] = useState(false);
	const [output, setOutput] = useState<React.ReactNode | null>(null);
	const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
	const [inputKey, setInputKey] = useState(0);
	const [splitView, setSplitView] = useState(false);

	// CLI-020: Execution mode state
	const [execMode, setExecMode] = useState(false);
	const [connected, setConnected] = useState(false);
	const [schemaName, setSchemaName] = useState<string | undefined>(undefined);
	const dbConnectionRef = useRef<DbConnection | null>(null);
	const [executionResult, setExecutionResult] =
		useState<ExecutionResult | null>(null);

	// CLI-020: Initialize database connection if URL provided
	useEffect(() => {
		if (!config.databaseUrl) return;
		const databaseUrl = config.databaseUrl; // Narrowed after guard

		let isMounted = true;

		const initConnection = async () => {
			try {
				const connection = await createDbConnection(databaseUrl);
				if (isMounted) {
					dbConnectionRef.current = connection;
					setConnected(true);
					const dbName = getDatabaseName(databaseUrl);
					setOutput(
						<Text color="green">✓ Connected to database: {dbName}</Text>,
					);
				}
			} catch (error) {
				if (isMounted) {
					const message =
						error instanceof Error ? error.message : String(error);
					setOutput(<Text color="red">❌ Connection failed: {message}</Text>);
				}
			}
		};

		initConnection();

		// Cleanup on unmount
		return () => {
			isMounted = false;
			if (dbConnectionRef.current) {
				dbConnectionRef.current.close();
				dbConnectionRef.current = null;
			}
		};
	}, [config.databaseUrl]);

	// Get command history singleton
	const history = useMemo(() => getHistory(), []);

	// Create completion provider
	const completionProvider = useMemo(
		() => new CompletionProvider(config.schema),
		[config.schema],
	);
	const [completions, setCompletions] = useState<CompletionSuggestion[]>([]);
	const [selectedCompletionIndex, setSelectedCompletionIndex] = useState(-1);

	// Handle special keys (Ctrl+C to exit, Tab for completion navigation)
	useInput((inputChar, key) => {
		if (key.ctrl && inputChar === 'c') {
			exit();
		}
		// Tab: cycle through completions
		if (key.tab && completions.length > 0 && mode === 'natural') {
			const nextIndex =
				selectedCompletionIndex < 0
					? 0
					: (selectedCompletionIndex + 1) % completions.length;
			setSelectedCompletionIndex(nextIndex);
		}
	});

	// Handle input changes for completions
	const handleInputChange = useCallback(
		(value: string) => {
			setSelectedCompletionIndex(-1); // Reset selection on input change
			if (mode === 'natural') {
				const suggestions = completionProvider.complete(value);
				setCompletions(suggestions);
			} else {
				setCompletions([]);
			}
		},
		[completionProvider, mode],
	);

	// Handle completion acceptance (Enter with selected completion)
	const handleCompletionAccepted = useCallback(() => {
		setSelectedCompletionIndex(-1);
		setCompletions([]);
	}, []);

	// Get the currently selected completion text
	const selectedCompletion =
		selectedCompletionIndex >= 0
			? completions[selectedCompletionIndex]?.text
			: undefined;

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
							<Box flexDirection="column">
								<Text color="yellow">
									Switched to SQL mode. Input is raw SQL by default.
								</Text>
								<Text color="gray">
									Use ! prefix for natural queries. .natural to switch back.
								</Text>
							</Box>,
						);
						setQueryResult(null);
						setShowHelp(false);
						return;

					case '.natural':
						setMode('natural');
						setOutput(
							<Box flexDirection="column">
								<Text color="green">
									Switched to natural query mode. Input is parsed as natural
									query.
								</Text>
								<Text color="gray">
									Use ! prefix for raw SQL. .sql to switch modes.
								</Text>
							</Box>,
						);
						setQueryResult(null);
						setShowHelp(false);
						return;

					case '.use': {
						const schema = args[0];
						if (!schema) {
							// Show current schema or clear it
							if (schemaName) {
								setSchemaName(undefined);
								setOutput(
									<Box flexDirection="column">
										<Text color="yellow">
											Cleared schema. Queries now use default schema.
										</Text>
									</Box>,
								);
							} else {
								setOutput(
									<Text color="gray">
										No schema set. Usage: .use &lt;schema_name&gt;
									</Text>,
								);
							}
						} else {
							setSchemaName(schema);
							setOutput(
								<Box flexDirection="column">
									<Text color="cyan">
										Using schema: <Text bold>{schema}</Text>
									</Text>
									<Text color="gray">
										All queries will be scoped to this schema. .use to clear.
									</Text>
								</Box>,
							);
						}
						setQueryResult(null);
						setShowHelp(false);
						return;
					}

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

					case '.aliasing': {
						// Toggle between 'always' and 'onCollision' modes (CLI-010)
						const newMode: AliasingMode =
							aliasingMode === 'always' ? 'onCollision' : 'always';
						setAliasingMode(newMode);
						setOutput(
							<Text color="cyan">
								🏷️ Column aliasing mode: {newMode}
								{newMode === 'always'
									? ' (all included columns prefixed)'
									: ' (only colliding columns prefixed)'}
							</Text>,
						);
						setQueryResult(null);
						setShowHelp(false);
						return;
					}

					case '.strategy': {
						// CLI-011: Include strategy selection with informative feedback
						const strategyArg = args[0]?.toLowerCase() as
							| IncludeStrategyMode
							| undefined;
						const dialectInfo = DIALECT_INFO[dialect];
						const availableStrategies = dialectInfo.strategies;

						if (!strategyArg) {
							// Show current strategy and all options with dialect info
							setOutput(
								<Box flexDirection="column" marginY={1}>
									<Text bold color="cyan">
										🔗 Include Strategy: {includeStrategy.toUpperCase()}
									</Text>
									<Text color="gray">
										Dialect: {dialectInfo.name} ({dialect})
									</Text>
									<Text> </Text>
									<Text color="gray">
										Available strategies for {dialectInfo.name}:
									</Text>
									{availableStrategies.map((strat) => {
										const info = STRATEGY_INFO[strat];
										const isCurrent = includeStrategy === strat;
										return (
											<Box key={strat} flexDirection="column" marginTop={1}>
												<Text color={isCurrent ? 'green' : 'white'}>
													• {strat} {isCurrent ? '(current)' : ''}
												</Text>
												<Text color="gray" dimColor>
													{' '}
													{info.description}
												</Text>
												{info.pros.slice(0, 2).map((pro, i) => (
													<Text key={i} color="gray" dimColor>
														{' '}
														✓ {pro}
													</Text>
												))}
												{info.cons.slice(0, 1).map((con, i) => (
													<Text key={i} color="gray" dimColor>
														{' '}
														⚠ {con}
													</Text>
												))}
											</Box>
										);
									})}
									<Box marginTop={1}>
										<Text color="gray">
											Usage: .strategy {availableStrategies.join(' | ')}
										</Text>
									</Box>
								</Box>,
							);
						} else if (availableStrategies.includes(strategyArg)) {
							const info = STRATEGY_INFO[strategyArg];
							setIncludeStrategy(strategyArg);
							setOutput(
								<Box flexDirection="column" marginY={1}>
									<Text color="green">✓ Include strategy: {info.name}</Text>
									<Text color="gray">{info.description}</Text>
									<Text color="gray" dimColor>
										Pros: {info.pros.join(', ')}
									</Text>
								</Box>,
							);
						} else if (Object.keys(STRATEGY_INFO).includes(strategyArg)) {
							// Valid strategy but not available for current dialect
							const info = STRATEGY_INFO[strategyArg];
							setOutput(
								<Box flexDirection="column" marginY={1}>
									<Text color="red">
										❌ Strategy '{strategyArg}' not available for{' '}
										{dialectInfo.name}
									</Text>
									<Text color="gray">
										This strategy requires: {info.dialects.join(', ')}
									</Text>
									<Text color="gray">
										Available strategies: {availableStrategies.join(', ')}
									</Text>
								</Box>,
							);
						} else {
							setOutput(
								<Text color="red">
									❌ Unknown strategy: {strategyArg}. Available:{' '}
									{availableStrategies.join(', ')}
								</Text>,
							);
						}
						setQueryResult(null);
						setShowHelp(false);
						return;
					}

					case '.dialect': {
						// CLI-011: SQL dialect selection
						const dialectArg = args[0]?.toLowerCase() as
							| DialectMode
							| undefined;

						if (!dialectArg) {
							// Show current dialect and available options
							setOutput(
								<Box flexDirection="column" marginY={1}>
									<Text bold color="cyan">
										🗄️ SQL Dialect: {DIALECT_INFO[dialect].name}
									</Text>
									<Text> </Text>
									<Text color="gray">Available dialects:</Text>
									{(
										Object.entries(DIALECT_INFO) as [
											DialectMode,
											(typeof DIALECT_INFO)[DialectMode],
										][]
									).map(([key, info]) => {
										const isCurrent = dialect === key;
										return (
											<Box key={key} flexDirection="column" marginTop={1}>
												<Text color={isCurrent ? 'green' : 'white'}>
													• {key} {isCurrent ? '(current)' : ''}
												</Text>
												<Text color="gray" dimColor>
													{' '}
													{info.description}
												</Text>
												<Text color="gray" dimColor>
													{' '}
													Strategies: {info.strategies.join(', ')}
												</Text>
											</Box>
										);
									})}
									<Box marginTop={1}>
										<Text color="gray">
											Usage: .dialect postgresql | mysql | sqlite | mssql |
											duckdb
										</Text>
									</Box>
								</Box>,
							);
						} else if (Object.keys(DIALECT_INFO).includes(dialectArg)) {
							const info = DIALECT_INFO[dialectArg];
							setDialect(dialectArg);

							// Check if current strategy is compatible with new dialect
							if (!info.strategies.includes(includeStrategy)) {
								setIncludeStrategy('join'); // Reset to default
								setOutput(
									<Box flexDirection="column" marginY={1}>
										<Text color="green">✓ Dialect: {info.name}</Text>
										<Text color="gray">{info.description}</Text>
										<Text color="yellow">
											⚠ Strategy reset to 'join' ('{includeStrategy}' not
											available for {info.name})
										</Text>
										<Text color="gray">
											Available strategies: {info.strategies.join(', ')}
										</Text>
									</Box>,
								);
							} else {
								setOutput(
									<Box flexDirection="column" marginY={1}>
										<Text color="green">✓ Dialect: {info.name}</Text>
										<Text color="gray">{info.description}</Text>
										<Text color="gray">
											Available strategies: {info.strategies.join(', ')}
										</Text>
									</Box>,
								);
							}
						} else {
							setOutput(
								<Text color="red">
									❌ Unknown dialect: {dialectArg}. Available:{' '}
									{Object.keys(DIALECT_INFO).join(', ')}
								</Text>,
							);
						}
						setQueryResult(null);
						setShowHelp(false);
						return;
					}

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

					case '.exec': {
						// CLI-020: Toggle execution mode
						const arg = args[0]?.toLowerCase();

						if (!connected) {
							setOutput(
								<Box flexDirection="column" marginY={1}>
									<Text color="red">❌ No database connected</Text>
									<Text color="gray">
										Start REPL with --db option to enable execution mode:
									</Text>
									<Text color="gray">
										dbsp repl --schema schema.ts --db postgres://localhost/mydb
									</Text>
								</Box>,
							);
							setQueryResult(null);
							setShowHelp(false);
							return;
						}

						if (arg === 'on') {
							setExecMode(true);
							setOutput(
								<Text color="green">
									✓ Execution mode: ON - queries will be executed against the
									database
								</Text>,
							);
						} else if (arg === 'off') {
							setExecMode(false);
							setOutput(
								<Text color="yellow">
									✓ Execution mode: OFF - compile-only mode
								</Text>,
							);
						} else {
							// Show current status
							setOutput(
								<Box flexDirection="column" marginY={1}>
									<Text bold color="cyan">
										🔌 Execution Mode: {execMode ? 'ON' : 'OFF'}
									</Text>
									<Text color="gray">
										Database:{' '}
										{config.databaseUrl
											? getDatabaseName(config.databaseUrl)
											: 'N/A'}
									</Text>
									<Text> </Text>
									<Text color="gray">Usage:</Text>
									<Text color="gray">
										{' '}
										.exec on - Execute queries against database
									</Text>
									<Text color="gray">
										{' '}
										.exec off - Compile-only mode (show SQL)
									</Text>
								</Box>,
							);
						}
						setQueryResult(null);
						setExecutionResult(null);
						setShowHelp(false);
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
			setExecutionResult(null);

			// CLI-020: Helper to execute SQL and update result
			const executeOnDb = async (sql: string, params: readonly unknown[]) => {
				if (!dbConnectionRef.current) return;
				const result = await dbConnectionRef.current.executeRaw(sql, params);
				setExecutionResult(result);
			};

			// CLI-020: Mode escape with ! prefix (see mode-escape.ts)
			const { content, isRawSql, escaped } = parseInputMode(trimmed, mode);

			if (!content) {
				setOutput(
					<Text color="red">
						❌ Empty query.{' '}
						{mode === 'sql'
							? 'Enter SQL or use ! for natural query'
							: 'Enter query or use ! for raw SQL'}
					</Text>,
				);
				setQueryResult(null);
				return;
			}

			if (isRawSql) {
				// Raw SQL handling
				setQueryResult({
					sql: content,
					params: [],
					plan: {
						strategy: 'RAW_SQL',
						tables: [],
						warnings: [
							getModeWarning(mode, escaped),
							...(execMode && connected
								? []
								: ['(compile-only, use .exec on to execute)']),
						],
					},
				});

				// Execute if in exec mode and connected
				if (execMode && connected && dbConnectionRef.current) {
					executeOnDb(content, []);
				}
			} else {
				// Natural query handling
				try {
					const parsed = parseNaturalQuery(content, config.schema);
					const result = executeQuery(parsed, config.schema, {
						aliasingMode,
						includeStrategy,
						dialect,
						...(schemaName && { schemaName }),
					});

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
							...(result.separateQueries && {
								separateQueries: result.separateQueries,
							}),
							plan: result.plan,
						});

						// Execute if in exec mode and connected
						if (execMode && connected && dbConnectionRef.current) {
							executeOnDb(result.sql, result.params);
						}
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
			}
		},
		[
			config.schema,
			config.databaseUrl,
			exit,
			mode,
			aliasingMode,
			includeStrategy,
			dialect,
			splitView,
			history,
			execMode,
			connected,
		],
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

			{/* CLI-020: Execution result display */}
			{executionResult && <ExecutionResultDisplay result={executionResult} />}

			{/* Completions (only in natural mode) */}
			{mode === 'natural' && completions.length > 0 && !showHelp && (
				<CompletionDisplay
					suggestions={completions}
					selectedIndex={selectedCompletionIndex}
				/>
			)}

			{/* Input area */}
			<InputPrompt
				onSubmit={handleSubmit}
				mode={mode}
				resetKey={inputKey}
				history={history}
				onInputChange={handleInputChange}
				{...(selectedCompletion !== undefined && { selectedCompletion })}
				onCompletionAccepted={handleCompletionAccepted}
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
				dialect={dialect}
				includeStrategy={includeStrategy}
				aliasingMode={aliasingMode}
				connected={connected}
				execMode={execMode}
				{...(schemaName && { schemaName })}
				{...(config.databaseUrl && {
					databaseName: getDatabaseName(config.databaseUrl),
				})}
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
							<CompletionDisplay
								suggestions={completions}
								selectedIndex={selectedCompletionIndex}
							/>
						)}

						{/* Input area */}
						<InputPrompt
							onSubmit={handleSubmit}
							mode={mode}
							resetKey={inputKey}
							history={history}
							onInputChange={handleInputChange}
							{...(selectedCompletion !== undefined && { selectedCompletion })}
							onCompletionAccepted={handleCompletionAccepted}
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
