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
				<Text color="gray" dimColor>
					Parameters: {JSON.stringify(params)}
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
						<Text color="gray" dimColor>
							Parameters: {JSON.stringify(q.params)}
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
	return (
		<Box flexDirection="column" marginY={1}>
			<Text bold color="magenta">
				📋 Query Plan:
			</Text>
			<Box paddingLeft={2} flexDirection="column">
				<Text>
					Strategy: <Text color="cyan">{plan.strategy}</Text>
				</Text>
				<Text>
					Tables: <Text color="cyan">{plan.tables.join(', ')}</Text>
				</Text>
				{plan.warnings.length > 0 && (
					<Box flexDirection="column" marginTop={1}>
						<Text color="yellow">⚠️ Warnings:</Text>
						{plan.warnings.map((w, i) => (
							<Text key={i} color="yellow">
								• {w}
							</Text>
						))}
					</Box>
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

export function OutputDisplay({ result }: OutputDisplayProps) {
	if (!result) return null;

	if (result.error) {
		return <ErrorOutput message={result.error} />;
	}

	return (
		<Box flexDirection="column">
			<SqlOutput sql={result.sql} params={result.params} label="📝 Main SQL:" />
			{result.separateQueries && result.separateQueries.length > 0 && (
				<SeparateQueriesOutput queries={result.separateQueries} />
			)}
			{result.plan && <PlanOutput plan={result.plan} />}
		</Box>
	);
}
