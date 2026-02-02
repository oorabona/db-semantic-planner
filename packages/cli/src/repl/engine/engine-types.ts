/**
 * Engine Event Types, Configuration, and State Interface
 *
 * Defines the event-driven interface between ReplEngine (pure business logic)
 * and any UI consumer (Ink TUI, batch mode, tests, future GUI).
 */

import type { LoadedSchema } from '../../utils/schema-loader.js';
import type {
	AliasingMode,
	DialectMode,
	ExecutionResult,
	IncludeStrategyMode,
	QueryMode,
	QueryResult,
} from '../types.js';

/**
 * Output layout controls what appears inline in the conversation flow.
 * Detail inspection uses the anchored panel (.sql, .plan, .results, etc.).
 */
export type OutputLayout = 'compact' | 'results' | 'sql' | 'full';

/**
 * Panel view types for the anchored inspection panel below input.
 */
export type PanelView = 'sql' | 'plan' | 'results' | 'params' | 'dump';

/**
 * Events emitted by the engine for UI consumption.
 */
export type EngineEvent =
	| { type: 'query-result'; result: QueryResult }
	| { type: 'execution-result'; result: ExecutionResult; query: QueryResult }
	| { type: 'info'; message: string }
	| { type: 'error'; message: string }
	| { type: 'clear' }
	| { type: 'exit' }
	| { type: 'state-change'; state: EngineState }
	| { type: 'show-history' }
	| { type: 'show-panel'; view: PanelView }
	| { type: 'close-panel' }
	| { type: 'layout-change'; layout: OutputLayout };

/**
 * Engine state — mirrors the business-relevant state from the REPL.
 * UI-only state (showHelp, inputKey, completions) stays in the component.
 */
export interface EngineState {
	mode: QueryMode;
	execMode: boolean;
	connected: boolean;
	explainMode: boolean;
	parseMode: boolean;
	aliasingMode: AliasingMode;
	includeStrategy: IncludeStrategyMode;
	dialect: DialectMode;
	schemaName?: string;
	dbCasing?: 'snake_case' | 'camelCase' | 'preserve';
	outputMode: 'json' | 'table' | 'csv';
	outputLayout: OutputLayout;
}

/**
 * Configuration for creating a ReplEngine.
 */
export interface EngineConfig {
	schema: LoadedSchema;
	schemaPath: string;
	databaseUrl?: string;
	initialSchemaName?: string;
	initialParseMode?: boolean;
	initialExecMode?: boolean;
	dbCasing?: 'snake_case' | 'camelCase' | 'preserve';
}

export type EngineEventHandler = (event: EngineEvent) => void;
