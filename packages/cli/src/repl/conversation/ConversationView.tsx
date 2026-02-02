/**
 * ConversationView — Renders stacked REPL entries like Claude Code's terminal.
 *
 * Each entry shows: prompt echo ("> query") followed by output.
 * Auto-scrolls to newest entry.
 */

import { Box, Text } from 'ink';
import React from 'react';
import { OutputDisplay } from '../components/OutputDisplay.js';
import { ExecutionResultDisplay } from '../result-formatter.js';
import type { ExecutionResult, QueryResult } from '../types.js';
import type { ConversationEntry } from './conversation-model.js';

interface ConversationViewProps {
	entries: readonly ConversationEntry[];
}

/** Render a single conversation entry. */
function ConversationEntryView({ entry }: { entry: ConversationEntry }) {
	// Extract relevant events for display
	let queryResult: QueryResult | null = null;
	let execResult: ExecutionResult | null = null;
	let infoMessage: string | null = null;
	let errorMessage: string | null = null;

	for (const event of entry.events) {
		switch (event.type) {
			case 'query-result':
				queryResult = event.result;
				break;
			case 'execution-result':
				execResult = event.result;
				break;
			case 'info':
				infoMessage = event.message;
				break;
			case 'error':
				errorMessage = event.message;
				break;
		}
	}

	return (
		<Box flexDirection="column" marginBottom={1}>
			{/* Prompt echo */}
			<Text color="gray" dimColor>
				{'> '}
				{entry.input}
			</Text>

			{/* Info messages (dot command output) */}
			{infoMessage && <Text>{infoMessage}</Text>}

			{/* Error messages */}
			{errorMessage && <Text color="red">{errorMessage}</Text>}

			{/* Query result (SQL output + plan) */}
			{queryResult && <OutputDisplay result={queryResult} />}

			{/* Execution result (table of rows) */}
			{execResult && <ExecutionResultDisplay result={execResult} />}
		</Box>
	);
}

export function ConversationView({ entries }: ConversationViewProps) {
	if (entries.length === 0) return null;

	return (
		<Box flexDirection="column">
			{entries.map((entry) => (
				<ConversationEntryView key={entry.id} entry={entry} />
			))}
		</Box>
	);
}
