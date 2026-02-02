/**
 * InspectionPanel — Anchored panel below the input area.
 *
 * Displays detailed inspection of the last query result (SQL, plan, results,
 * params, parse tree) without polluting the conversation scroll.
 * Activated by dot commands: .sql, .plan, .results, .params, .dump, .parse
 * Closed by: .close, Esc
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { PanelView } from '../engine/engine-types.js';
import { ExecutionResultDisplay } from '../result-formatter.js';
import type { ExecutionResult, QueryResult } from '../types.js';
import {
	ParseTreeOutput,
	PlanOutput,
	SeparateQueriesOutput,
	SqlOutput,
} from './OutputDisplay.js';

interface InspectionPanelProps {
	view: PanelView;
	queryResult: QueryResult | null;
	executionResult: ExecutionResult | null;
}

const PANEL_TITLES: Record<PanelView, string> = {
	sql: 'SQL',
	plan: 'Query Plan',
	results: 'Results',
	params: 'Parameters',
	dump: 'Full Dump',
};

function PanelHeader({ view }: { view: PanelView }) {
	return (
		<Box>
			<Text bold color="blue">
				{'╸ '}
				{PANEL_TITLES[view]}
			</Text>
			<Text color="gray"> (.close or Esc to dismiss)</Text>
		</Box>
	);
}

function PanelContent({
	view,
	queryResult,
	executionResult,
}: InspectionPanelProps) {
	if (!queryResult && !executionResult) {
		return <Text color="gray">No query result to inspect.</Text>;
	}

	switch (view) {
		case 'sql': {
			if (!queryResult) return <Text color="gray">No SQL available.</Text>;
			return (
				<Box flexDirection="column">
					<SqlOutput
						sql={queryResult.sql}
						params={queryResult.params}
						label="Main SQL:"
					/>
					{queryResult.separateQueries &&
						queryResult.separateQueries.length > 0 && (
							<SeparateQueriesOutput queries={queryResult.separateQueries} />
						)}
				</Box>
			);
		}

		case 'plan': {
			if (!queryResult?.plan)
				return <Text color="gray">No query plan available.</Text>;
			return <PlanOutput plan={queryResult.plan} />;
		}

		case 'results': {
			if (!executionResult)
				return (
					<Text color="gray">
						No execution results. Use .exec to enable execution mode.
					</Text>
				);
			return <ExecutionResultDisplay result={executionResult} />;
		}

		case 'params': {
			if (!queryResult)
				return <Text color="gray">No parameters available.</Text>;
			const params = queryResult.params;
			if (params.length === 0) {
				return <Text color="gray">No parameters (static query).</Text>;
			}
			return (
				<Box flexDirection="column">
					{params.map((p, i) => (
						<Text key={i}>
							<Text color="cyan">${i + 1}</Text>
							<Text color="gray"> = </Text>
							<Text color="green">{JSON.stringify(p)}</Text>
						</Text>
					))}
				</Box>
			);
		}

		case 'dump': {
			return (
				<Box flexDirection="column">
					{queryResult && (
						<>
							<SqlOutput
								sql={queryResult.sql}
								params={queryResult.params}
								label="Main SQL:"
							/>
							{queryResult.separateQueries &&
								queryResult.separateQueries.length > 0 && (
									<SeparateQueriesOutput
										queries={queryResult.separateQueries}
									/>
								)}
							{queryResult.plan && <PlanOutput plan={queryResult.plan} />}
							{queryResult.parsedQuery !== undefined && (
								<ParseTreeOutput parsed={queryResult.parsedQuery} />
							)}
						</>
					)}
					{executionResult && (
						<ExecutionResultDisplay result={executionResult} />
					)}
				</Box>
			);
		}
	}
}

export function InspectionPanel(props: InspectionPanelProps) {
	return (
		<Box
			flexDirection="column"
			borderStyle="single"
			borderColor="blue"
			paddingX={1}
			marginTop={1}
		>
			<PanelHeader view={props.view} />
			<Box flexDirection="column" marginTop={1}>
				<PanelContent {...props} />
			</Box>
		</Box>
	);
}
