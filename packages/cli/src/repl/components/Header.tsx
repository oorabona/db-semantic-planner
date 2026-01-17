import React from 'react';
/**
 * DX-030: REPL Header Component
 * CLI-013: Enhanced status line with dialect, strategy, aliasing mode
 */

import { Box, Text } from 'ink';
import type {
	AliasingMode,
	DialectMode,
	IncludeStrategyMode,
	QueryMode,
} from '../types.js';

interface HeaderProps {
	schemaPath: string;
	mode: QueryMode;
	tableCount: number;
	relationCount: number;
	dialect: DialectMode;
	includeStrategy: IncludeStrategyMode;
	aliasingMode: AliasingMode;
	/** CLI-020: Database connection status */
	connected?: boolean;
	/** CLI-020: Execution mode enabled */
	execMode?: boolean;
	/** CLI-020: Database name for display */
	databaseName?: string;
	/** CLI-021: Active schema name for schema-scoped queries */
	schemaName?: string;
}

/** Short display names for dialects */
const DIALECT_DISPLAY: Record<DialectMode, string> = {
	postgresql: 'PG',
	mysql: 'MySQL',
	sqlite: 'SQLite',
	mssql: 'MSSQL',
	duckdb: 'DuckDB',
};

/** Short display names for strategies */
const STRATEGY_DISPLAY: Record<IncludeStrategyMode, string> = {
	auto: 'auto',
	join: 'join',
	separate: 'sep',
	cte: 'cte',
	lateral: 'lat',
	json_agg: 'json',
};

export function Header({
	schemaPath,
	mode,
	tableCount,
	relationCount,
	dialect,
	includeStrategy,
	aliasingMode,
	connected,
	execMode,
	databaseName,
	schemaName,
}: HeaderProps) {
	return (
		<Box
			borderStyle="round"
			borderColor="cyan"
			paddingX={2}
			marginBottom={1}
			flexDirection="column"
		>
			{/* Row 1: Title and help */}
			<Box>
				<Text bold color="cyan">
					🔍 db-semantic-planner REPL
				</Text>
				<Text color="gray"> | </Text>
				<Text color="gray">.help for commands</Text>
				<Text color="gray"> | </Text>
				<Text color="gray">Ctrl+C to exit</Text>
			</Box>

			{/* Row 2: Schema info and mode */}
			<Box>
				<Text color="gray">Schema: </Text>
				<Text color="white">{schemaPath}</Text>
				<Text color="gray">
					{' '}
					({tableCount} tables, {relationCount} relations)
				</Text>
				<Text color="gray"> | Mode: </Text>
				<Text color={mode === 'natural' ? 'green' : 'yellow'}>{mode}</Text>
				{schemaName && (
					<>
						<Text color="gray"> | Schema: </Text>
						<Text color="cyan">{schemaName}</Text>
					</>
				)}
			</Box>

			{/* Row 3: Dialect, Strategy, Aliasing (CLI-013) */}
			<Box>
				<Text color="gray">Dialect: </Text>
				<Text color="blue">{DIALECT_DISPLAY[dialect]}</Text>

				<Text color="gray"> | Strategy: </Text>
				<Text color="magenta">{STRATEGY_DISPLAY[includeStrategy]}</Text>

				<Text color="gray"> | Alias: </Text>
				<Text color={aliasingMode === 'always' ? 'cyan' : 'yellow'}>
					{aliasingMode === 'always' ? 'all' : 'collision'}
				</Text>

				{/* CLI-020: Database connection status */}
				{connected && (
					<>
						<Text color="gray"> | </Text>
						<Text color="green">DB: {databaseName}</Text>
						<Text color="gray"> | </Text>
						<Text color={execMode ? 'green' : 'yellow'}>
							{execMode ? '▶ EXEC' : '◼ COMPILE'}
						</Text>
					</>
				)}
			</Box>
		</Box>
	);
}
