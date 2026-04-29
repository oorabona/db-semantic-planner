/**
 * ReplEngine — Pure business logic for the REPL.
 *
 * Owns all REPL state and logic, emits events for UI consumption.
 * No React/Ink dependency — usable by interactive REPL, batch mode, tests.
 */

import type { ModelIR } from '@dbsp/core';
import {
	config as appConfig,
	isValidTableOption,
	TABLE_OPTIONS,
} from '../../config.js';
import {
	CompletionProvider,
	enhanceErrorWithSuggestion,
} from '../completion.js';
import {
	createDbConnection,
	type DbConnection,
	getDatabaseName,
} from '../db-connection.js';
import { type BatchState, processDotCommand } from '../dot-commands.js';
import { getModeWarning, parseInputMode } from '../mode-escape.js';
import { compileNqlToSql } from '../nql-executor.js';
import type { QueryResult } from '../types.js';
import type {
	EngineConfig,
	EngineEvent,
	EngineEventHandler,
	EngineState,
	OutputLayout,
	PanelView,
	PlanVerbosity,
} from './engine-types.js';

/**
 * Dialect → available include strategies mapping.
 * Compact version of the STRATEGY_INFO/DIALECT_INFO from the old index.tsx.
 */
const DIALECT_STRATEGIES: Record<string, readonly string[]> = {
	postgresql: ['auto', 'join', 'subquery', 'cte', 'lateral', 'json_agg'],
	mysql: ['auto', 'join', 'subquery', 'cte', 'json_agg'],
	sqlite: ['auto', 'join', 'subquery', 'cte'],
	mssql: ['auto', 'join', 'subquery', 'cte'],
	duckdb: ['auto', 'join', 'subquery', 'cte', 'json_agg'],
};

/**
 * Check if the last character of the input is inside a single-quoted string literal.
 * NQL uses SQL-style single quotes; escaped quotes are '' (doubled).
 */
export function isInsideStringLiteral(input: string): boolean {
	let inString = false;
	for (let i = 0; i < input.length - 1; i++) {
		if (input[i] === "'") {
			if (inString && i + 1 < input.length - 1 && input[i + 1] === "'") {
				i++; // skip escaped quote ''
			} else {
				inString = !inString;
			}
		}
	}
	return inString;
}

type TableConfigKey = keyof typeof TABLE_OPTIONS;

type TableOptionHandler = {
	/** The config field name passed to appConfig.updateTable / TABLE_OPTIONS / isValidTableOption. */
	field: TableConfigKey;
	/** Human-readable label printed in success/error messages. */
	label: string;
	/** Parses the raw string argument into the validated value type. */
	parse: (raw: string) => string | number;
};

// Keyed by every command word the user can type — aliases share the same handler instance.
const borderHandler: TableOptionHandler = {
	field: 'borderStyle',
	label: 'borders',
	// Border style values (none / outline / rounded / etc.) are all-lowercase —
	// normalize input so e.g. `.table borders NONE` matches.
	parse: (s) => s.toLowerCase(),
};

const headerHandler: TableOptionHandler = {
	field: 'headerFormatter',
	label: 'headers',
	// Header-formatter values include camelCase (capitalCase / snakeCase / camelCase) —
	// preserve original case so the user-typed value matches TABLE_OPTIONS exactly.
	parse: (s) => s,
};

// Keyed by every command word the user can type — aliases share the same handler instance.
const TABLE_OPTION_HANDLERS: Record<string, TableOptionHandler> = {
	borders: borderHandler,
	border: borderHandler,
	overflow: {
		field: 'overflow',
		label: 'overflow',
		// Overflow values (truncate / wrap) are all-lowercase — normalize input.
		parse: (s) => s.toLowerCase(),
	},
	headers: headerHandler,
	header: headerHandler,
	padding: {
		field: 'padding',
		label: 'padding',
		parse: (s) => Number.parseInt(s, 10),
	},
};

export class ReplEngine {
	private state: EngineState;
	private listeners: EngineEventHandler[] = [];
	private schema: EngineConfig['schema'];
	private schemaPath: string;
	private model: ModelIR;
	private dbConnection: DbConnection | null = null;
	private completionProvider: CompletionProvider;
	private databaseUrl: string | undefined;
	private continuationBuffer = '';

	constructor(config: EngineConfig) {
		this.schema = config.schema;
		this.schemaPath = config.schemaPath;
		this.model = config.schema.model;
		this.databaseUrl = config.databaseUrl;
		this.completionProvider = new CompletionProvider(config.schema);

		this.state = {
			mode: 'natural',
			execMode: config.initialExecMode ?? false,
			connected: false,
			explainMode: false,
			parseMode: config.initialParseMode ?? false,
			aliasingMode: 'always',
			includeStrategy: 'auto',
			dialect: 'postgresql',
			...(config.initialSchemaName !== undefined && {
				schemaName: config.initialSchemaName,
			}),
			...(config.dbCasing !== undefined && { dbCasing: config.dbCasing }),
			outputMode: 'json',
			outputLayout: 'full',
			planVerbosity: 'normal',
			inTransaction: false,
		};
	}

	/**
	 * Initialize database connection if configured.
	 * Must be called after construction for async init.
	 */
	async init(): Promise<void> {
		if (!this.databaseUrl) return;

		try {
			this.dbConnection = await createDbConnection(this.databaseUrl);
			this.state.connected = true;
			const dbName = getDatabaseName(this.databaseUrl);
			this.emit({
				type: 'info',
				message: `✓ Connected to database: ${dbName}`,
			});
			this.emitStateChange();
		} catch (error) {
			this.state.connected = false;
			const message = error instanceof Error ? error.message : String(error);
			this.emit({
				type: 'init-error',
				message: `Connection failed: ${message}`,
			});
			this.emitStateChange();
		}
	}

	/** Subscribe to engine events. Returns unsubscribe function. */
	on(handler: EngineEventHandler): () => void {
		this.listeners.push(handler);
		return () => {
			const idx = this.listeners.indexOf(handler);
			if (idx >= 0) this.listeners.splice(idx, 1);
		};
	}

	/** Get current state (readonly snapshot). */
	getState(): Readonly<EngineState> {
		return { ...this.state };
	}

	/** Get the completion provider for the UI. */
	getCompletionProvider(): CompletionProvider {
		return this.completionProvider;
	}

	/** Get schema for UI display. */
	getSchema(): EngineConfig['schema'] {
		return this.schema;
	}

	/** Get schema path for header display. */
	getSchemaPath(): string {
		return this.schemaPath;
	}

	/** Get database name for header display. */
	getDatabaseName(): string | undefined {
		return this.databaseUrl ? getDatabaseName(this.databaseUrl) : undefined;
	}

	/**
	 * Main entry point: process user input.
	 * Handles dot commands, raw SQL, and NQL queries.
	 */
	async submit(input: string): Promise<void> {
		const trimmed = input.trim();

		// Blank line or comment — flush continuation buffer (separator) and skip
		if (!trimmed || trimmed.startsWith('#')) {
			this.continuationBuffer = '';
			return;
		}

		// Backslash continuation: accumulate and wait for next line
		if (trimmed.endsWith('\\')) {
			this.continuationBuffer +=
				(this.continuationBuffer ? '\n' : '') + trimmed.slice(0, -1);
			return;
		}

		// Merge continuation buffer with current line
		const merged = this.continuationBuffer
			? `${this.continuationBuffer}\n${trimmed}`
			: trimmed;
		this.continuationBuffer = '';

		// --- Dot commands ---
		if (merged.startsWith('.')) {
			await this.processDotCommand(merged);
			return;
		}

		// --- Query execution ---
		const { content, isRawSql, escaped } = parseInputMode(
			merged,
			this.state.mode,
		);

		if (!content) {
			this.emit({
				type: 'error',
				message:
					this.state.mode === 'sql'
						? 'Empty query. Enter SQL or use ! for natural query'
						: 'Empty query. Enter query or use ! for raw SQL',
			});
			return;
		}

		if (isRawSql) {
			await this.handleRawSql(content, escaped);
		} else {
			await this.handleNql(content);
		}
	}

	/** Cleanup resources. */
	async destroy(): Promise<void> {
		if (this.dbConnection) {
			await this.dbConnection.close();
			this.dbConnection = null;
			this.state.connected = false;
		}
	}

	// ========================================================================
	// Private: event emission
	// ========================================================================

	private emit(event: EngineEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	private emitStateChange(): void {
		this.emit({ type: 'state-change', state: { ...this.state } });
	}

	// ========================================================================
	// Private: dot command processing
	// ========================================================================

	private async processDotCommand(input: string): Promise<void> {
		const [cmd, ...args] = input.split(' ');
		const arg = args.join(' ').trim();

		// Commands handled by the engine (not delegated to dot-commands.ts)
		switch (cmd) {
			case '.exit':
			case '.quit':
				this.emit({ type: 'exit' });
				return;

			case '.clear':
				this.emit({ type: 'clear' });
				return;

			case '.help':
				this.emit({ type: 'info', message: 'SHOW_HELP' });
				return;

			case '.history':
				this.emit({ type: 'show-history' });
				return;

			case '.aliasing': {
				const newMode =
					this.state.aliasingMode === 'always' ? 'onCollision' : 'always';
				this.state.aliasingMode = newMode;
				this.emitStateChange();
				this.emit({
					type: 'info',
					message: `🏷️ Column aliasing mode: ${newMode}${newMode === 'always' ? ' (all included columns prefixed)' : ' (only colliding columns prefixed)'}`,
				});
				return;
			}

			case '.strategy': {
				const strategyArg = arg?.toLowerCase();
				const validStrategies = DIALECT_STRATEGIES[this.state.dialect] ?? [];

				if (!strategyArg) {
					const lines = [
						`🔗 Include Strategy: ${this.state.includeStrategy.toUpperCase()}`,
						`Dialect: ${this.state.dialect}`,
						`Available: ${validStrategies.join(', ')}`,
						`Usage: .strategy ${validStrategies.join(' | ')}`,
					];
					this.emit({ type: 'info', message: lines.join('\n') });
				} else if (
					validStrategies.includes(
						strategyArg as (typeof validStrategies)[number],
					)
				) {
					this.state.includeStrategy =
						strategyArg as typeof this.state.includeStrategy;
					this.emitStateChange();
					this.emit({
						type: 'info',
						message: `✓ Include strategy: ${strategyArg.toUpperCase()}`,
					});
				} else {
					this.emit({
						type: 'error',
						message: `❌ Unknown or unavailable strategy: ${strategyArg}. Available: ${validStrategies.join(', ')}`,
					});
				}
				return;
			}

			case '.dialect': {
				const dialectArg = arg?.toLowerCase();
				const validDialects = Object.keys(DIALECT_STRATEGIES);

				if (!dialectArg) {
					const lines = [
						`🗄️ SQL Dialect: ${this.state.dialect}`,
						`Available: ${validDialects.join(', ')}`,
						`Usage: .dialect ${validDialects.join(' | ')}`,
					];
					this.emit({ type: 'info', message: lines.join('\n') });
				} else if (validDialects.includes(dialectArg)) {
					const strategies =
						DIALECT_STRATEGIES[dialectArg as keyof typeof DIALECT_STRATEGIES];
					this.state.dialect = dialectArg as typeof this.state.dialect;
					// Reset strategy if incompatible with new dialect
					if (
						strategies &&
						!strategies.includes(this.state.includeStrategy as never)
					) {
						this.state.includeStrategy = 'join';
						this.emitStateChange();
						this.emit({
							type: 'info',
							message: `✓ Dialect: ${dialectArg}\n⚠ Strategy reset to 'join' (previous not available for ${dialectArg})`,
						});
					} else {
						this.emitStateChange();
						this.emit({ type: 'info', message: `✓ Dialect: ${dialectArg}` });
					}
				} else {
					this.emit({
						type: 'error',
						message: `❌ Unknown dialect: ${dialectArg}. Available: ${validDialects.join(', ')}`,
					});
				}
				return;
			}

			case '.table': {
				this.handleTableConfig(arg);
				return;
			}

			// Panel inspection commands — open anchored panel below input
			// Usage: .show sql | plan | results | params | dump
			case '.show': {
				const validViews: PanelView[] = [
					'sql',
					'plan',
					'results',
					'params',
					'dump',
				];
				const viewArg = arg?.toLowerCase();

				if (!viewArg) {
					this.emit({
						type: 'info',
						message: `📋 Inspection panel views: ${validViews.join(', ')}\nUsage: .show ${validViews.join(' | ')}`,
					});
				} else if (validViews.includes(viewArg as PanelView)) {
					this.emit({ type: 'show-panel', view: viewArg as PanelView });
				} else {
					this.emit({
						type: 'error',
						message: `❌ Unknown panel view: ${viewArg}. Available: ${validViews.join(', ')}`,
					});
				}
				return;
			}

			case '.close': {
				this.emit({ type: 'close-panel' });
				return;
			}

			case '.layout': {
				const validLayouts: OutputLayout[] = [
					'compact',
					'results',
					'sql',
					'full',
				];
				const layoutArg = arg?.toLowerCase();

				if (!layoutArg) {
					this.emit({
						type: 'info',
						message: `📐 Output layout: ${this.state.outputLayout}\nAvailable: ${validLayouts.join(', ')}\nUsage: .layout ${validLayouts.join(' | ')}`,
					});
				} else if (validLayouts.includes(layoutArg as OutputLayout)) {
					this.state.outputLayout = layoutArg as OutputLayout;
					this.emitStateChange();
					this.emit({
						type: 'layout-change',
						layout: this.state.outputLayout,
					});
					this.emit({
						type: 'info',
						message: `✓ Output layout: ${layoutArg}`,
					});
				} else {
					this.emit({
						type: 'error',
						message: `❌ Unknown layout: ${layoutArg}. Available: ${validLayouts.join(', ')}`,
					});
				}
				return;
			}

			case '.plan': {
				const validLevels: PlanVerbosity[] = ['compact', 'normal', 'verbose'];
				const level = arg?.toLowerCase();

				if (!level) {
					this.emit({
						type: 'info',
						message: `📋 Plan verbosity: ${this.state.planVerbosity}\nAvailable: ${validLevels.join(', ')}\nUsage: .plan ${validLevels.join(' | ')}`,
					});
				} else if (validLevels.includes(level as PlanVerbosity)) {
					this.state.planVerbosity = level as PlanVerbosity;
					this.emitStateChange();
					this.emit({
						type: 'info',
						message: `✓ Plan verbosity: ${level}`,
					});
				} else {
					this.emit({
						type: 'error',
						message: `❌ Invalid plan verbosity: ${level}. Use: ${validLevels.join(', ')}`,
					});
				}
				return;
			}
		}

		// Delegate to shared dot-command processor (used by batch mode too)
		// Build a BatchState-compatible object for the processor
		const batchState: BatchState = {
			mode: this.state.mode,
			execEnabled: this.state.execMode,
			schemaName: this.state.schemaName as string | undefined,
			dbConnection: this.dbConnection ?? undefined,
			explainMode: this.state.explainMode,
			parseMode: this.state.parseMode,
			model: this.model,
			outputMode: this.state.outputMode,
			inTransaction: this.state.inTransaction,
			...(this.state.dbCasing !== undefined && {
				dbCasing: this.state.dbCasing,
			}),
		};

		const result = await processDotCommand(input, this.schema, batchState);

		// Apply state changes from dot command
		if (result.stateChange) {
			if (result.stateChange.mode !== undefined) {
				this.state.mode = result.stateChange.mode;
			}
			if (result.stateChange.execEnabled !== undefined) {
				this.state.execMode = result.stateChange.execEnabled;
			}
			if ('schemaName' in result.stateChange) {
				if (result.stateChange.schemaName !== undefined) {
					this.state.schemaName = result.stateChange.schemaName;
				} else {
					delete this.state.schemaName;
				}
			}
			if (result.stateChange.explainMode !== undefined) {
				this.state.explainMode = result.stateChange.explainMode;
			}
			if (result.stateChange.parseMode !== undefined) {
				this.state.parseMode = result.stateChange.parseMode;
			}
			if (result.stateChange.outputMode !== undefined) {
				this.state.outputMode = result.stateChange.outputMode;
			}
			if (result.stateChange.inTransaction !== undefined) {
				this.state.inTransaction = result.stateChange.inTransaction;
			}
			this.emitStateChange();
		}

		// Emit the output
		if (result.error) {
			this.emit({ type: 'error', message: result.output });
		} else {
			this.emit({ type: 'info', message: result.output });
		}
	}

	// ========================================================================
	// Private: .table config
	// ========================================================================

	private handleTableConfig(arg: string): void {
		const tableConfig = appConfig.getTable();
		const parts = arg.split(/\s+/);
		const option = parts[0]?.toLowerCase() ?? '';
		const value = parts[1] ?? '';

		if (!option) {
			this.emit({
				type: 'info',
				message: `Table Configuration:\n  borders: ${tableConfig.borderStyle}\n  overflow: ${tableConfig.overflow}\n  headers: ${tableConfig.headerFormatter}\n  padding: ${tableConfig.padding}`,
			});
			return;
		}

		if (option === 'reset') {
			appConfig.resetTable();
			this.emit({
				type: 'info',
				message: '✓ Table configuration reset to defaults',
			});
			return;
		}

		const handler = TABLE_OPTION_HANDLERS[option];
		if (!handler) {
			this.emit({
				type: 'error',
				message: `Unknown option: ${option}. Options: borders, overflow, headers, padding, reset`,
			});
			return;
		}

		if (!value) {
			this.emit({
				type: 'info',
				message: `Current: ${tableConfig[handler.field]}\nOptions: ${TABLE_OPTIONS[handler.field].join(', ')}`,
			});
			return;
		}

		const parsed = handler.parse(value);
		if (isValidTableOption(handler.field, parsed)) {
			appConfig.updateTable({ [handler.field]: parsed } as Parameters<
				typeof appConfig.updateTable
			>[0]);
			this.emit({ type: 'info', message: `✓ ${handler.label} = ${parsed}` });
		} else {
			this.emit({
				type: 'error',
				message: `Invalid value. Options: ${TABLE_OPTIONS[handler.field].join(', ')}`,
			});
		}
	}

	// ========================================================================
	// Private: raw SQL handling
	// ========================================================================

	private async handleRawSql(content: string, escaped: boolean): Promise<void> {
		const queryResult: QueryResult = {
			sql: content,
			params: [],
			plan: {
				strategy: 'RAW_SQL',
				rootTable: '',
				tables: [],
				decisions: [],
				warnings: [
					{ message: getModeWarning(this.state.mode, escaped) },
					...(!this.state.execMode || !this.state.connected
						? [{ message: '(compile-only, use .exec on to execute)' }]
						: []),
				].filter((w) => w.message),
				cteCount: 0,
				planningTimeMs: 0,
			},
		};

		this.emit({ type: 'query-result', result: queryResult });

		// Execute if in exec mode and connected
		if (this.state.execMode && this.state.connected && this.dbConnection) {
			try {
				const execResult = await this.dbConnection.executeRaw(content, []);
				this.emit({
					type: 'execution-result',
					result: execResult,
					query: queryResult,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.emit({
					type: 'query-result',
					result: { sql: content, params: [], error: message },
				});
			}
		}
	}

	// ========================================================================
	// Private: NQL handling
	// ========================================================================

	private async handleNql(content: string): Promise<void> {
		if (!this.model) {
			this.emit({
				type: 'error',
				message: 'No schema model available for NQL compilation',
			});
			return;
		}

		try {
			// Strip trailing ! (bang suffix = execute mutation) before compilation
			// Must verify the ! is outside string literals (odd number of unescaped quotes = inside string)
			const trimmed = content.trim();
			const hasBangSuffix =
				trimmed.endsWith('!') && !isInsideStringLiteral(trimmed);
			const nqlContent = hasBangSuffix ? trimmed.slice(0, -1).trim() : content;

			const result = await compileNqlToSql(nqlContent, this.model, {
				...(this.state.schemaName ? { schemaName: this.state.schemaName } : {}),
				...(this.state.dbCasing ? { dbCasing: this.state.dbCasing } : {}),
			});

			const isMutation =
				result.intentType !== 'query' && result.intentType !== 'setOperation';
			const isDryRun = isMutation && !hasBangSuffix;

			// Apply EXPLAIN prefix if explainMode is on (queries only)
			const finalSql =
				!isMutation && this.state.explainMode
					? `EXPLAIN ${result.sql}`
					: result.sql;

			// Build plan info
			const planInfo = isMutation
				? isDryRun
					? 'DRY-RUN (add ! to execute)'
					: 'EXECUTED'
				: '';

			const queryResult = this.buildQueryResult(
				result,
				finalSql,
				isMutation,
				isDryRun,
				planInfo,
			);
			this.emit({ type: 'query-result', result: queryResult });

			if (this.shouldExecuteQuery(isMutation, isDryRun) && this.dbConnection) {
				const execResult = await this.dbConnection.executeRaw(
					finalSql,
					result.params,
				);
				this.emit({
					type: 'execution-result',
					result: execResult,
					query: queryResult,
				});
			}
		} catch (err) {
			const tableNames = this.schema.tableNames;
			const rawError = err instanceof Error ? err.message : String(err);
			const enhancedError = enhanceErrorWithSuggestion(rawError, tableNames);

			this.emit({
				type: 'query-result',
				result: { sql: '', params: [], error: enhancedError },
			});
		}
	}

	// ========================================================================
	// Private: NQL helpers
	// ========================================================================

	private buildQueryResult(
		nqlResult: Awaited<ReturnType<typeof compileNqlToSql>>,
		finalSql: string,
		isMutation: boolean,
		isDryRun: boolean,
		planInfo: string,
	): QueryResult {
		const pr = nqlResult.planReport;
		return {
			sql: finalSql,
			params: nqlResult.params,
			intent: nqlResult.intent,
			plan: {
				strategy: isMutation
					? `${nqlResult.intentType.toUpperCase()} - ${planInfo}`
					: 'NQL v2',
				rootTable: pr?.rootTable ?? '',
				tables: [
					...new Set(
						pr?.decisions.map((d) => d.context.sourceTable).filter(Boolean) ??
							[],
					),
				],
				decisions:
					pr?.decisions.map((d) => ({
						type: d.type,
						context: [d.context.sourceTable, d.context.target]
							.filter(Boolean)
							.join(' → '),
						choice: d.choice,
						reasoning: d.reasoning,
						...(d.alternatives.length > 0 && {
							alternatives: [...d.alternatives],
						}),
						...(d.context.foreignKey !== undefined && {
							foreignKey:
								typeof d.context.foreignKey === 'string'
									? d.context.foreignKey
									: [...d.context.foreignKey],
						}),
						...(d.context.relationType !== undefined && {
							relationType: d.context.relationType,
						}),
						...(d.context.intentPath !== undefined && {
							intentPath: d.context.intentPath,
						}),
						...(d.context.relationPath !== undefined && {
							relationPath: d.context.relationPath,
						}),
						...(d.id !== undefined && { decisionId: d.id }),
					})) ?? [],
				warnings: [
					...(isDryRun
						? [{ message: 'This is a dry-run. Add ! suffix to execute.' }]
						: []),
					...(pr?.warnings.map((w) => ({
						message: w.message,
						...(w.suggestion !== undefined && { suggestion: w.suggestion }),
						...(w.code !== undefined && { code: w.code }),
						...(w.relatedDecision !== undefined && {
							relatedDecision: w.relatedDecision,
						}),
					})) ?? []),
				],
				cteCount: pr?.ctes.length ?? 0,
				planningTimeMs: pr?.metadata.planningTimeMs ?? 0,
				...(pr?.ctes && pr.ctes.length > 0
					? {
							ctes: pr.ctes.map((c) => ({
								name: c.name,
								purpose: c.purpose,
								...(c.recursive && { recursive: c.recursive }),
								...(c.referencedBy.length > 0 && {
									referencedBy: [...c.referencedBy],
								}),
							})),
						}
					: {}),
				...(pr?.metadata
					? {
							metadata: {
								relationsAnalyzed: pr.metadata.relationsAnalyzed,
								isAmbiguous: pr.metadata.isAmbiguous,
								...(pr.metadata.ambiguousOptions &&
									pr.metadata.ambiguousOptions.length > 0 && {
										ambiguousOptions: [...pr.metadata.ambiguousOptions],
									}),
							},
						}
					: {}),
			},
		};
	}

	private shouldExecuteQuery(isMutation: boolean, isDryRun: boolean): boolean {
		return isMutation
			? !isDryRun &&
					this.state.execMode &&
					this.state.connected &&
					Boolean(this.dbConnection)
			: this.state.execMode &&
					this.state.connected &&
					Boolean(this.dbConnection);
	}
}
