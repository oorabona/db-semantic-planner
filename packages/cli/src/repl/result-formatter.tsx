/**
 * CLI-020: Result Formatter Component
 *
 * Displays database query results in a formatted table using @oclif/table.
 */

import { makeTable } from '@oclif/table';
import { Box, Text } from 'ink';
import React from 'react';
import { config } from '../config.js';
import type { ExecutionResult } from './db-connection.js';

/** Format a cell value for display */
function formatValue(value: unknown): string {
	if (value === null) return 'NULL';
	if (value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return String(value);
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return JSON.stringify(value);
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

interface ExecutionResultDisplayProps {
	result: ExecutionResult;
}

export function ExecutionResultDisplay({
	result,
}: ExecutionResultDisplayProps) {
	// Handle error
	if (result.error) {
		return (
			<Box flexDirection="column" marginY={1}>
				<Text bold color="red">
					❌ Database Error
				</Text>
				<Text color="red">{result.error}</Text>
				<Text color="gray" dimColor>
					({result.executionTimeMs}ms)
				</Text>
			</Box>
		);
	}

	// Handle empty result
	if (result.rows.length === 0) {
		return (
			<Box flexDirection="column" marginY={1}>
				<Text color="gray">0 rows ({result.executionTimeMs}ms)</Text>
			</Box>
		);
	}

	const { columns, rows, rowCount, executionTimeMs, truncated } = result;

	// Get table configuration
	const tableConfig = config.getTable();

	// Format data for @oclif/table
	const formattedData = rows.map((row) => {
		const formatted: Record<string, string> = {};
		for (const col of columns) {
			formatted[col] = formatValue(row[col]);
		}
		return formatted;
	});

	// Build column config with configured overflow
	const columnConfig = columns.map((col) => ({
		key: col,
		name: col,
		overflow: tableConfig.overflow,
	}));

	// Generate table string using @oclif/table
	// Map 'none' formatter to identity function (oclif/table doesn't have 'none')
	const headerFormatter =
		tableConfig.headerFormatter === 'none'
			? (h: string) => h
			: tableConfig.headerFormatter;

	const tableOutput = makeTable({
		data: formattedData,
		columns: columnConfig,
		borderStyle: tableConfig.borderStyle,
		headerOptions: {
			formatter: headerFormatter,
		},
		padding: tableConfig.padding,
	});

	return (
		<Box flexDirection="column" marginY={1}>
			<Text>{tableOutput}</Text>
			<Text color="green">
				{rowCount} row{rowCount !== 1 ? 's' : ''} ({executionTimeMs}ms)
				{truncated && (
					<Text color="yellow"> (truncated, showing first 100)</Text>
				)}
			</Text>
		</Box>
	);
}
