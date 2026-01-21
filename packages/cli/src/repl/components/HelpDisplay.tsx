import React from 'react';
/**
 * DX-030: REPL Help Display Component
 */

import { Box, Text } from 'ink';

const DOT_COMMANDS = [
	{ command: '.help', description: 'Show this help' },
	{ command: '.tables', description: 'List all tables in schema' },
	{
		command: '.schema [table]',
		description: 'Show schema info (or specific table)',
	},
	{ command: '.relations', description: 'List all relations' },
	{
		command: '.history',
		description: 'Show command history (↑/↓ to navigate)',
	},
	{
		command: '.sql',
		description: 'SQL mode: input is raw SQL, ! escapes to natural',
	},
	{
		command: '.natural',
		description: 'Natural mode: input is parsed, ! escapes to SQL',
	},
	{
		command: '.use [schema]',
		description: 'Set schema for queries (empty to clear)',
	},
	{ command: '.split', description: 'Toggle split view (schema | query)' },
	{
		command: '.aliasing',
		description: 'Toggle column aliasing mode (always/onCollision)',
	},
	{
		command: '.strategy [mode]',
		description:
			'Show/set include strategy (auto|join|separate|cte|lateral|json_agg)',
	},
	{
		command: '.dialect [name]',
		description: 'Show/set SQL dialect (postgresql|mysql|sqlite|mssql|duckdb)',
	},
	{
		command: '.exec [on|off]',
		description: 'Toggle execution mode (requires --db connection)',
	},
{
		command: '.import <file>',
		description: 'Execute SQL file (DDL, seed data)',
	},
	{
		command: '.parse [on|off]',
		description: 'Toggle parse tree (AST) output for queries',
	},
	{ command: '.clear', description: 'Clear screen and output' },
	{ command: '.exit / .quit', description: 'Exit REPL' },
];

const NATURAL_SYNTAX = [
	{
		pattern: '<table>',
		example: 'users',
		description: 'Select all from table',
	},
	{
		pattern: '<table> where <cond>',
		example: 'users where active = true',
		description: 'Filter results',
	},
	{
		pattern: '<table> include <rel>',
		example: 'users include posts',
		description: 'Include related data',
	},
	{
		pattern: '<table> limit <n>',
		example: 'users limit 10',
		description: 'Limit results',
	},
	{
		pattern: '!<query>',
		example: '!SELECT... or !users',
		description: 'Mode escape: SQL in natural mode, natural in SQL mode',
	},
];

function SimpleTable({
	data,
	columns,
}: {
	data: Record<string, string>[];
	columns: string[];
}) {
	return (
		<Box flexDirection="column">
			{data.map((row, i) => (
				<Box key={i}>
					{columns.map((col, j) => (
						<Box key={col} width={col === 'description' ? 50 : 25}>
							<Text color={j === 0 ? 'cyan' : 'white'}>{row[col]}</Text>
						</Box>
					))}
				</Box>
			))}
		</Box>
	);
}

export function HelpDisplay() {
	return (
		<Box flexDirection="column" marginY={1}>
			<Text bold color="yellow">
				📚 Dot Commands:
			</Text>
			<Box marginTop={1} marginBottom={1} flexDirection="column">
				<SimpleTable data={DOT_COMMANDS} columns={['command', 'description']} />
			</Box>

			<Text bold color="cyan">
				📝 Natural Query Syntax:
			</Text>
			<Box marginTop={1} flexDirection="column">
				<SimpleTable
					data={NATURAL_SYNTAX}
					columns={['pattern', 'example', 'description']}
				/>
			</Box>

			<Box marginTop={1}>
				<Text color="gray">
					Tip: Use .sql to switch to raw SQL mode, .natural to return
				</Text>
			</Box>
		</Box>
	);
}
