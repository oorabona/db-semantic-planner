/**
 * ConversationView — Renders stacked REPL entries like Claude Code's terminal.
 *
 * Each entry shows: prompt echo ("> query") followed by output.
 * Output detail is controlled by outputLayout:
 * - compact: summary line only (row count, timing)
 * - results: summary + execution results table
 * - sql: summary + SQL output
 * - full: everything inline (legacy behavior)
 */

import { Box, Text } from 'ink';
import React from 'react';
import { OutputDisplay } from '../components/OutputDisplay.js';
import type { OutputLayout } from '../engine/engine-types.js';
import { ExecutionResultDisplay } from '../result-formatter.js';
import type { ExecutionResult, QueryResult } from '../types.js';
import type { ConversationEntry } from './conversation-model.js';

interface ConversationViewProps {
	entries: readonly ConversationEntry[];
	outputLayout: OutputLayout;
}

/** Compact one-line summary for a query result. */
function QuerySummary({
	queryResult,
	execResult,
}: {
	queryResult: QueryResult | null;
	execResult: ExecutionResult | null;
}) {
	if (!queryResult && !execResult) return null;

	const parts: string[] = [];

	if (execResult) {
		if (execResult.error) {
			return <Text color="red">✗ {execResult.error}</Text>;
		}
		parts.push(
			`${execResult.rowCount} row${execResult.rowCount !== 1 ? 's' : ''}`,
		);
		parts.push(`${execResult.executionTimeMs.toFixed(0)}ms`);
		if (execResult.truncated) parts.push('truncated');
	}

	if (queryResult) {
		if (queryResult.error) {
			return <Text color="red">✗ {queryResult.error}</Text>;
		}
		if (!execResult) {
			// Compilation-only mode — show plan summary
			const plan = queryResult.plan;
			if (plan) {
				parts.push(plan.strategy);
				if (plan.decisions.length > 0)
					parts.push(
						`${plan.decisions.length} decision${plan.decisions.length !== 1 ? 's' : ''}`,
					);
				if (plan.cteCount > 0)
					parts.push(`${plan.cteCount} CTE${plan.cteCount !== 1 ? 's' : ''}`);
				if (plan.planningTimeMs > 0)
					parts.push(`${plan.planningTimeMs.toFixed(1)}ms`);
			}
			if (
				queryResult.separateQueries &&
				queryResult.separateQueries.length > 0
			) {
				parts.push(
					`${queryResult.separateQueries.length} separate quer${queryResult.separateQueries.length !== 1 ? 'ies' : 'y'}`,
				);
			}
		}
	}

	return (
		<Text>
			<Text color="green">✓ </Text>
			<Text color="gray">{parts.join(' · ')}</Text>
		</Text>
	);
}

/** Render a single conversation entry with layout-aware output. */
function ConversationEntryView({
	entry,
	outputLayout,
}: {
	entry: ConversationEntry;
	outputLayout: OutputLayout;
}) {
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

	const hasQueryOutput = queryResult !== null || execResult !== null;

	return (
		<Box flexDirection="column" marginBottom={1}>
			{/* Prompt echo */}
			{entry.input && (
				<Text color="gray" dimColor>
					{'> '}
					{entry.input}
				</Text>
			)}

			{/* Info messages (dot command output) — always shown */}
			{infoMessage && <Text>{infoMessage}</Text>}

			{/* Error messages — always shown */}
			{errorMessage && <Text color="red">{errorMessage}</Text>}

			{/* Query/execution output — layout-dependent */}
			{hasQueryOutput && outputLayout === 'compact' && (
				<QuerySummary queryResult={queryResult} execResult={execResult} />
			)}

			{hasQueryOutput && outputLayout === 'sql' && (
				<Box flexDirection="column">
					<QuerySummary queryResult={queryResult} execResult={execResult} />
					{queryResult && <OutputDisplay result={queryResult} />}
				</Box>
			)}

			{hasQueryOutput && outputLayout === 'results' && (
				<Box flexDirection="column">
					<QuerySummary queryResult={queryResult} execResult={execResult} />
					{execResult && <ExecutionResultDisplay result={execResult} />}
				</Box>
			)}

			{hasQueryOutput && outputLayout === 'full' && (
				<Box flexDirection="column">
					{queryResult && <OutputDisplay result={queryResult} />}
					{execResult && <ExecutionResultDisplay result={execResult} />}
				</Box>
			)}
		</Box>
	);
}

export function ConversationView({
	entries,
	outputLayout,
}: ConversationViewProps) {
	if (entries.length === 0) return null;

	return (
		<Box flexDirection="column">
			{entries.map((entry) => (
				<ConversationEntryView
					key={entry.id}
					entry={entry}
					outputLayout={outputLayout}
				/>
			))}
		</Box>
	);
}
