/**
 * InspectionPanel — Anchored panel below the input area.
 *
 * Displays detailed inspection of the last query result (SQL, plan, results,
 * params, dump) without polluting the conversation scroll.
 * Tab bar at top cycles through views with Tab key.
 * Activated by dot commands: .show sql|plan|results|params|dump
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
	execMode: boolean;
	onViewChange: (view: PanelView) => void;
}

const ALL_VIEWS: PanelView[] = ['sql', 'plan', 'results', 'params', 'dump'];

const TAB_LABELS: Record<PanelView, string> = {
	sql: 'SQL',
	plan: 'Plan',
	results: 'Results',
	params: 'Params',
	dump: 'Dump',
};

function TabBar({
	activeView,
	execMode,
}: { activeView: PanelView; execMode: boolean }) {
	return (
		<Box>
			{ALL_VIEWS.map((v, i) => {
				const isActive = v === activeView;
				const isDimmed = v === 'results' && !execMode;
				return (
					<React.Fragment key={v}>
						{i > 0 && <Text color="gray"> </Text>}
						{isActive ? (
							<Text bold inverse color="blue">
								{` ${TAB_LABELS[v]} `}
							</Text>
						) : (
							<Text color={isDimmed ? 'gray' : 'white'} dimColor={isDimmed}>
								{` ${TAB_LABELS[v]} `}
							</Text>
						)}
					</React.Fragment>
				);
			})}
			<Text color="gray"> Tab↹ cycle · Esc close</Text>
		</Box>
	);
}

function PanelContent({
	view,
	queryResult,
	executionResult,
	execMode,
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
			if (!execMode)
				return (
					<Text color="gray">
						Not in execution mode. Use .exec to enable.
					</Text>
				);
			if (!executionResult)
				return (
					<Text color="gray">
						No execution results yet. Run a query with .exec enabled.
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
			<TabBar activeView={props.view} execMode={props.execMode} />
			<Box flexDirection="column" marginTop={1}>
				<PanelContent {...props} />
			</Box>
		</Box>
	);
}
