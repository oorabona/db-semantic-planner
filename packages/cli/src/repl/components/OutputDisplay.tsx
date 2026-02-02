import React from 'react';
/**
 * DX-030: REPL Output Display Component
 */

import { Box, Text } from 'ink';
import type { QueryResult, SeparateQueryResult } from '../types.js';

interface OutputDisplayProps {
	result: QueryResult | null;
}

export function SqlOutput({
	sql,
	params,
	label = '📝 Generated SQL:',
}: {
	sql: string;
	params: readonly unknown[];
	label?: string;
}) {
	return (
		<Box flexDirection="column" marginY={1}>
			<Text bold color="yellow">
				{label}
			</Text>
			<Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
				<Text color="green">{sql}</Text>
			</Box>
			{params.length > 0 && (
				<Text>
					<Text color="gray">Parameters: </Text>
					<Text color="cyan">{JSON.stringify(params)}</Text>
				</Text>
			)}
		</Box>
	);
}

export function SeparateQueriesOutput({
	queries,
}: {
	queries: SeparateQueryResult[];
}) {
	return (
		<Box flexDirection="column" marginY={1}>
			{queries.map((q, i) => (
				<Box key={i} flexDirection="column" marginBottom={1}>
					<Text bold color="cyan">
						📎 Separate Query ({q.relation}):
					</Text>
					<Box
						borderStyle="single"
						borderColor="cyan"
						paddingX={1}
						marginTop={1}
					>
						<Text color="green">{q.sql}</Text>
					</Box>
					{q.params.length > 0 && (
						<Text>
							<Text color="gray">Parameters: </Text>
							<Text color="cyan">{JSON.stringify(q.params)}</Text>
						</Text>
					)}
				</Box>
			))}
		</Box>
	);
}

export function PlanOutput({
	plan,
}: {
	plan: NonNullable<QueryResult['plan']>;
}) {
	const hasDecisions = plan.decisions.length > 0;
	const hasWarnings = plan.warnings.length > 0;
	const hasCtes = plan.cteCount > 0;
	const isCompact = !hasDecisions && !hasCtes && !hasWarnings;

	// Compact one-liner for simple queries
	if (isCompact) {
		return (
			<Box marginY={1}>
				<Text bold color="magenta">
					📋 Query Plan:{' '}
				</Text>
				<Text color="cyan">
					{plan.rootTable || plan.strategy}
					{' (no decisions)'}
				</Text>
				{plan.planningTimeMs > 0 && (
					<Text color="gray"> ⏱ {plan.planningTimeMs.toFixed(1)}ms</Text>
				)}
			</Box>
		);
	}

	return (
		<Box flexDirection="column" marginY={1}>
			<Text bold color="magenta">
				📋 Query Plan:
			</Text>
			<Box paddingLeft={2} flexDirection="column">
				{plan.rootTable && (
					<Text>
						Root: <Text color="cyan">{plan.rootTable}</Text>
					</Text>
				)}
				{plan.tables.length > 0 && (
					<Text>
						Tables: <Text color="cyan">{plan.tables.join(', ')}</Text>
					</Text>
				)}
				{hasDecisions && (
					<Box flexDirection="column" marginTop={1}>
						<Text bold>Decisions:</Text>
						{plan.decisions.map((d, i) => (
							<Text key={i}>
								<Text color="gray"> • </Text>
								<Text color="blue">{d.type}</Text>
								<Text color="gray">: </Text>
								<Text color="cyan">{d.context}</Text>
								<Text color="gray"> — </Text>
								<Text color="green">{d.choice}</Text>
								<Text color="gray"> ({d.reasoning})</Text>
							</Text>
						))}
					</Box>
				)}
				{hasCtes && (
					<Text>
						CTEs: <Text color="cyan">{plan.cteCount} extracted</Text>
					</Text>
				)}
				{hasWarnings && (
					<Box flexDirection="column" marginTop={1}>
						<Text color="yellow">⚠️ Warnings:</Text>
						{plan.warnings.map((w, i) => (
							<Box key={i} flexDirection="column">
								<Text color="yellow"> • {w.message}</Text>
								{w.suggestion && <Text color="gray"> → {w.suggestion}</Text>}
							</Box>
						))}
					</Box>
				)}
				{plan.planningTimeMs > 0 && (
					<Text color="gray">
						⏱ Planning: {plan.planningTimeMs.toFixed(1)}ms
					</Text>
				)}
			</Box>
		</Box>
	);
}

export function ErrorOutput({ message }: { message: string }) {
	return (
		<Box marginY={1}>
			<Text color="red">❌ Error: {message}</Text>
		</Box>
	);
}

/**
 * CLI-NQL: Format parsed query as a tree for .parse mode
 */
export function formatParseTree(parsed: unknown): string {
	const lines: string[] = [];

	const formatValue = (value: unknown, indent = 2): string => {
		const pad = ' '.repeat(indent);
		if (value === null) return 'null';
		if (value === undefined) return 'undefined';
		if (typeof value === 'string') return `"${value}"`;
		if (typeof value === 'number' || typeof value === 'boolean')
			return String(value);
		if (Array.isArray(value)) {
			if (value.length === 0) return '[]';
			const items = value.map((v) => formatValue(v, indent + 2)).join(', ');
			return `[${items}]`;
		}
		if (typeof value === 'object') {
			const entries = Object.entries(value);
			if (entries.length === 0) return '{}';
			const formatted = entries
				.map(([k, v]) => `${pad}  ${k}: ${formatValue(v, indent + 2)}`)
				.join('\n');
			return `{\n${formatted}\n${pad}}`;
		}
		return String(value);
	};

	lines.push('ParsedQuery {');
	const obj = parsed as Record<string, unknown>;
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined) {
			lines.push(`  ${key}: ${formatValue(value)}`);
		}
	}
	lines.push('}');
	return lines.join('\n');
}

export function ParseTreeOutput({ parsed }: { parsed: unknown }) {
	const treeText = formatParseTree(parsed);
	return (
		<Box flexDirection="column" marginY={1}>
			<Text bold color="blue">
				🌳 Parse Tree (AST):
			</Text>
			<Box borderStyle="single" borderColor="blue" paddingX={1} marginTop={1}>
				<Text color="white">{treeText}</Text>
			</Box>
		</Box>
	);
}

export function OutputDisplay({ result }: OutputDisplayProps) {
	if (!result) return null;

	if (result.error) {
		return (
			<Box flexDirection="column">
				<ErrorOutput message={result.error} />
				{result.parsedQuery !== undefined && (
					<ParseTreeOutput parsed={result.parsedQuery} />
				)}
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			{result.parsedQuery !== undefined && (
				<ParseTreeOutput parsed={result.parsedQuery} />
			)}
			<SqlOutput sql={result.sql} params={result.params} label="📝 Main SQL:" />
			{result.separateQueries && result.separateQueries.length > 0 && (
				<SeparateQueriesOutput queries={result.separateQueries} />
			)}
			{result.plan && <PlanOutput plan={result.plan} />}
		</Box>
	);
}
