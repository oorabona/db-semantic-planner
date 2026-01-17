/**
 * CLI-020: Result Formatter Component
 *
 * Displays database query results in a formatted table.
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { ExecutionResult } from './db-connection.js';

/** Maximum column width for display */
const MAX_COL_WIDTH = 30;

/** Truncate string to max length with ellipsis */
function truncate(value: string, maxLen: number): string {
	if (value.length <= maxLen) return value;
	return value.slice(0, maxLen - 1) + '…';
}

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

/** Calculate column widths based on content */
function calculateColumnWidths(
	columns: string[],
	rows: Record<string, unknown>[],
): number[] {
	const widths = columns.map((col) => col.length);

	for (const row of rows) {
		columns.forEach((col, idx) => {
			const value = formatValue(row[col]);
			const currentWidth = widths[idx] ?? 0;
			widths[idx] = Math.min(MAX_COL_WIDTH, Math.max(currentWidth, value.length));
		});
	}

	return widths;
}

/** Pad string to width */
function padCell(value: string, width: number): string {
	const truncated = truncate(value, width);
	return truncated.padEnd(width, ' ');
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
	const widths = calculateColumnWidths(columns, rows);

	// Build separator line
	const separator = '─'.repeat(
		widths.reduce((sum, w) => sum + w + 3, 0) - 1,
	);

	return (
		<Box flexDirection="column" marginY={1}>
			{/* Header */}
			<Text color="cyan">
				│ {columns.map((col, idx) => padCell(col, widths[idx] ?? col.length)).join(' │ ')} │
			</Text>
			<Text color="gray">├{separator}┤</Text>

			{/* Rows */}
			{rows.map((row, rowIdx) => (
				<Text key={rowIdx}>
					│{' '}
					{columns
						.map((col, idx) => padCell(formatValue(row[col]), widths[idx] ?? 10))
						.join(' │ ')}{' '}
					│
				</Text>
			))}

			{/* Footer */}
			<Text color="gray">└{separator}┘</Text>
			<Text color="green">
				{rowCount} row{rowCount !== 1 ? 's' : ''} ({executionTimeMs}ms)
				{truncated && (
					<Text color="yellow"> (truncated, showing first 100)</Text>
				)}
			</Text>
		</Box>
	);
}
