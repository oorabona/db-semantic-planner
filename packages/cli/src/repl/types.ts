/**
import type React from 'react';
 * DX-030: REPL Types
 */

import type { ResolvedSchema } from '@db-semantic-planner/schema';

/**
 * REPL Configuration passed from CLI command
 */
export interface ReplConfig {
	schema: ResolvedSchema;
	schemaPath: string;
}

/**
 * Query mode - natural syntax or SQL
 */
export type QueryMode = 'natural' | 'sql';

/**
 * REPL state
 */
export interface ReplState {
	mode: QueryMode;
	history: string[];
	historyIndex: number;
	splitView: boolean;
}

/**
 * Dot command handler result
 */
export interface DotCommandResult {
	type: 'output' | 'clear' | 'exit' | 'mode-change' | 'toggle-split';
	content?: React.ReactNode;
	newMode?: QueryMode;
}

/**
 * Query execution result
 */
export interface QueryResult {
	sql: string;
	params: readonly unknown[];
	plan?: {
		strategy: string;
		tables: string[];
		warnings: string[];
	};
	error?: string;
}
