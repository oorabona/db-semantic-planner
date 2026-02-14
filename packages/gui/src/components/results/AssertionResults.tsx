/**
 * Assertion results panel — renders per-query results with expand/collapse.
 * Shows expected vs actual for failures, skip reasons for skipped assertions.
 */
import {
	CheckCircle,
	ChevronDown,
	ChevronRight,
	CircleSlash,
	XCircle,
} from 'lucide-react';
import { useState } from 'react';
import type {
	AssertionOutcome,
	QueryAssertionResult,
	RunAssertionsResult,
} from '@/lib/ipc';
import { AssertionSummaryBar } from './AssertionSummaryBar';

interface AssertionResultsProps {
	result: RunAssertionsResult;
}

export function AssertionResults({ result }: AssertionResultsProps) {
	return (
		<div className="flex h-full flex-col overflow-hidden">
			<AssertionSummaryBar summary={result.summary} />

			{result.parseErrors.length > 0 && (
				<div className="border-b border-red-500/20 bg-red-500/5 px-3 py-2">
					<p className="mb-1 text-xs font-medium text-red-600 dark:text-red-400">
						Parse Errors
					</p>
					{result.parseErrors.map((err, i) => (
						<p
							key={`parse-${err.line}-${i}`}
							className="font-mono text-xs text-red-600 dark:text-red-400"
						>
							Line {err.line}: {err.message}
						</p>
					))}
				</div>
			)}

			<div className="flex-1 overflow-auto">
				{result.summary.results.map((qr) => (
					<QueryResultBlock key={qr.queryIndex} queryResult={qr} />
				))}
			</div>
		</div>
	);
}

function QueryResultBlock({
	queryResult,
}: {
	queryResult: QueryAssertionResult;
}) {
	const [expanded, setExpanded] = useState(!queryResult.passed);

	return (
		<div className="border-b border-border">
			<button
				type="button"
				className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/50"
				onClick={() => setExpanded(!expanded)}
				data-testid={`query-block-${queryResult.queryIndex}`}
			>
				{expanded ? (
					<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				) : (
					<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				)}
				{queryResult.passed ? (
					<CheckCircle className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
				) : (
					<XCircle className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400" />
				)}
				<span className="truncate font-mono">{queryResult.query}</span>
				<span className="ml-auto shrink-0 text-muted-foreground">
					{queryResult.assertions.length} assertion
					{queryResult.assertions.length !== 1 ? 's' : ''}
				</span>
			</button>

			{expanded && (
				<div className="space-y-0.5 px-3 pb-2 pl-10">
					{queryResult.assertions.map((assertion, i) => (
						<AssertionRow
							key={`${queryResult.queryIndex}-${i}`}
							assertion={assertion}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function AssertionRow({ assertion }: { assertion: AssertionOutcome }) {
	if (assertion.skipped) {
		return (
			<div className="flex items-start gap-2 py-0.5 text-xs">
				<CircleSlash className="mt-0.5 h-3 w-3 shrink-0 text-yellow-600 dark:text-yellow-400" />
				<div>
					<span className="font-mono text-muted-foreground">
						{assertion.type}
					</span>
					{assertion.skipReason && (
						<p className="text-yellow-600 dark:text-yellow-400">
							Skipped: {assertion.skipReason}
						</p>
					)}
				</div>
			</div>
		);
	}

	if (assertion.passed) {
		return (
			<div className="flex items-center gap-2 py-0.5 text-xs">
				<CheckCircle className="h-3 w-3 shrink-0 text-green-600 dark:text-green-400" />
				<span className="font-mono text-muted-foreground">
					{assertion.type}
				</span>
			</div>
		);
	}

	return (
		<div className="flex items-start gap-2 py-0.5 text-xs">
			<XCircle className="mt-0.5 h-3 w-3 shrink-0 text-red-600 dark:text-red-400" />
			<div className="min-w-0">
				<span className="font-mono text-muted-foreground">
					{assertion.type}
				</span>
				{assertion.message && (
					<p className="text-red-600 dark:text-red-400">{assertion.message}</p>
				)}
				<div className="mt-0.5 grid grid-cols-2 gap-2">
					<div>
						<span className="text-muted-foreground">Expected:</span>
						<pre className="mt-0.5 max-h-20 overflow-auto whitespace-pre-wrap rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px]">
							{formatValue(assertion.expected)}
						</pre>
					</div>
					<div>
						<span className="text-muted-foreground">Actual:</span>
						<pre className="mt-0.5 max-h-20 overflow-auto whitespace-pre-wrap rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px]">
							{formatValue(assertion.actual)}
						</pre>
					</div>
				</div>
			</div>
		</div>
	);
}

function formatValue(value: unknown): string {
	if (value === null || value === undefined) return String(value);
	if (typeof value === 'string') return value;
	return JSON.stringify(value, null, 2);
}
