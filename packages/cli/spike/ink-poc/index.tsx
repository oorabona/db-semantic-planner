/**
 * Ink POC for DX-030-SPIKE
 *
 * Features to test:
 * - Input handling (text input with history)
 * - Box layout (borders, padding, flexbox)
 * - Table output (SQL results display)
 * - Basic styling (colors, bold, etc.)
 */

import { TextInput } from '@inkjs/ui';
import { Box, render, Text, useApp, useInput } from 'ink';
import Table from 'ink-table';
import type React from 'react';
import { useCallback, useState } from 'react';

// Mock SQL results data
const MOCK_SQL_RESULTS = [
	{ id: 1, name: 'Alice', email: 'alice@example.com', active: true },
	{ id: 2, name: 'Bob', email: 'bob@example.com', active: false },
	{ id: 3, name: 'Charlie', email: 'charlie@example.com', active: true },
];

const MOCK_PLAN = {
	strategy: 'EXISTS',
	tables: ['users', 'posts'],
	warnings: [],
};

// Header component with styling
function Header() {
	return (
		<Box borderStyle="round" borderColor="cyan" paddingX={2} marginBottom={1}>
			<Text bold color="cyan">
				🔍 db-semantic-planner REPL
			</Text>
			<Text color="gray"> | Type .help for commands, Ctrl+C to exit</Text>
		</Box>
	);
}

// SQL output display with box and styling
function SqlOutput({ sql, params }: { sql: string; params: unknown[] }) {
	return (
		<Box flexDirection="column" marginY={1}>
			<Text bold color="yellow">
				📝 Generated SQL:
			</Text>
			<Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
				<Text color="green">{sql}</Text>
			</Box>
			{params.length > 0 && (
				<Text color="gray" dimColor>
					Parameters: {JSON.stringify(params)}
				</Text>
			)}
		</Box>
	);
}

// Plan output with box styling
function PlanOutput({ plan }: { plan: typeof MOCK_PLAN }) {
	return (
		<Box flexDirection="column" marginY={1}>
			<Text bold color="magenta">
				📋 Query Plan:
			</Text>
			<Box paddingLeft={2}>
				<Text>
					Strategy: <Text color="cyan">{plan.strategy}</Text>
				</Text>
			</Box>
			<Box paddingLeft={2}>
				<Text>
					Tables: <Text color="cyan">{plan.tables.join(', ')}</Text>
				</Text>
			</Box>
		</Box>
	);
}

// Results table component
function ResultsTable({ data }: { data: typeof MOCK_SQL_RESULTS }) {
	return (
		<Box flexDirection="column" marginY={1}>
			<Text bold color="blue">
				📊 Results ({data.length} rows):
			</Text>
			<Box marginTop={1}>
				<Table data={data} />
			</Box>
		</Box>
	);
}

// Command history display
function History({ commands }: { commands: string[] }) {
	if (commands.length === 0) return null;

	return (
		<Box flexDirection="column" marginY={1}>
			<Text bold color="gray">
				📜 History:
			</Text>
			{commands.slice(-5).map((cmd, i) => (
				<Text key={i} color="gray" dimColor>
					{i + 1}. {cmd}
				</Text>
			))}
		</Box>
	);
}

// Help display
function HelpDisplay() {
	const commands = [
		{ command: '.help', description: 'Show this help' },
		{ command: '.tables', description: 'List all tables' },
		{ command: '.schema', description: 'Show schema info' },
		{ command: '.clear', description: 'Clear screen' },
		{ command: 'select(...)', description: 'Run a query' },
	];

	return (
		<Box flexDirection="column" marginY={1}>
			<Text bold color="yellow">
				📚 Available Commands:
			</Text>
			<Table data={commands} />
		</Box>
	);
}

// Main REPL App
function ReplApp() {
	const { exit } = useApp();
	const [input, setInput] = useState('');
	const [history, setHistory] = useState<string[]>([]);
	const [output, setOutput] = useState<React.ReactNode | null>(null);
	const [showHelp, setShowHelp] = useState(false);

	// Handle special keys
	useInput((inputChar, key) => {
		if (key.ctrl && inputChar === 'c') {
			exit();
		}
	});

	const handleSubmit = useCallback((value: string) => {
		const trimmed = value.trim();
		if (!trimmed) return;

		setHistory((prev) => [...prev, trimmed]);
		setInput('');

		// Handle dot commands
		if (trimmed === '.help') {
			setShowHelp(true);
			setOutput(null);
			return;
		}

		if (trimmed === '.tables') {
			setShowHelp(false);
			setOutput(
				<Box flexDirection="column">
					<Text bold color="cyan">
						📋 Tables:
					</Text>
					<Text> - users</Text>
					<Text> - posts</Text>
					<Text> - comments</Text>
				</Box>,
			);
			return;
		}

		if (trimmed === '.clear') {
			setShowHelp(false);
			setOutput(null);
			setHistory([]);
			return;
		}

		// Simulate query execution
		setShowHelp(false);
		setOutput(
			<Box flexDirection="column">
				<SqlOutput
					sql="SELECT id, name, email, active FROM users WHERE active = $1"
					params={[true]}
				/>
				<PlanOutput plan={MOCK_PLAN} />
				<ResultsTable data={MOCK_SQL_RESULTS} />
			</Box>,
		);
	}, []);

	return (
		<Box flexDirection="column" padding={1}>
			<Header />

			{/* Output area */}
			{showHelp && <HelpDisplay />}
			{output}

			{/* History */}
			<History commands={history} />

			{/* Input area */}
			<Box marginTop={1}>
				<Text color="green" bold>
					{'> '}
				</Text>
				<TextInput
					value={input}
					onChange={setInput}
					onSubmit={handleSubmit}
					placeholder="Enter query or command..."
				/>
			</Box>
		</Box>
	);
}

// Render the app
render(<ReplApp />);
