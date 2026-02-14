// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunAssertionsResult } from '@/lib/ipc';
import { AssertionResults } from './AssertionResults';

vi.mock('./AssertionSummaryBar', () => ({
	AssertionSummaryBar: ({ summary }: { summary: unknown }) => (
		<div data-testid="assertion-summary-bar">{JSON.stringify(summary)}</div>
	),
}));

afterEach(() => {
	cleanup();
});

// ── Fixtures ─────────────────────────────────────────────────────

const mockResult: RunAssertionsResult = {
	summary: {
		total: 3,
		passed: 2,
		failed: 1,
		skipped: 0,
		results: [
			{
				queryIndex: 0,
				query: 'users',
				querySuccess: true,
				assertions: [
					{
						type: 'sql.equals',
						expected: 'SELECT "id" FROM "users"',
						actual: 'SELECT "id" FROM "users"',
						passed: true,
						message: undefined,
					},
					{
						type: 'success',
						expected: true,
						actual: true,
						passed: true,
						message: undefined,
					},
				],
				passed: true,
			},
			{
				queryIndex: 1,
				query: 'users | where active = true',
				querySuccess: true,
				assertions: [
					{
						type: 'intent.table',
						expected: 'orders',
						actual: 'users',
						passed: false,
						message: 'Expected table "orders" but got "users"',
					},
				],
				passed: false,
			},
		],
	},
	queryResults: [],
	parseErrors: [],
};

const mockResultWithParseErrors: RunAssertionsResult = {
	summary: { total: 0, passed: 0, failed: 0, skipped: 0, results: [] },
	queryResults: [],
	parseErrors: [
		{ line: 3, message: 'Unknown assertion type: "bad.type"' },
		{ line: 7, message: 'Malformed assertion syntax' },
	],
};

const mockResultWithSkipped: RunAssertionsResult = {
	summary: {
		total: 1,
		passed: 0,
		failed: 0,
		skipped: 1,
		results: [
			{
				queryIndex: 0,
				query: 'users',
				querySuccess: true,
				assertions: [
					{
						type: 'db.success',
						expected: true,
						actual: undefined,
						passed: false,
						skipped: true,
						skipReason: 'No DB connection',
						message: undefined,
					},
				],
				passed: true,
			},
		],
	},
	queryResults: [],
	parseErrors: [],
};

// ── Tests ────────────────────────────────────────────────────────

describe('AssertionResults', () => {
	it('renders the summary bar', () => {
		render(<AssertionResults result={mockResult} />);
		expect(screen.getByTestId('assertion-summary-bar')).toBeDefined();
	});

	it('renders per-query blocks', () => {
		render(<AssertionResults result={mockResult} />);
		expect(screen.getByTestId('query-block-0')).toBeDefined();
		expect(screen.getByTestId('query-block-1')).toBeDefined();
	});

	it('shows query text in block header', () => {
		render(<AssertionResults result={mockResult} />);
		// "users" appears both as query text and assertion actual — use getAllByText
		expect(screen.getAllByText('users').length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText('users | where active = true')).toBeDefined();
	});

	it('shows assertion count per block', () => {
		render(<AssertionResults result={mockResult} />);
		expect(screen.getByText('2 assertions')).toBeDefined();
		expect(screen.getByText('1 assertion')).toBeDefined();
	});

	it('auto-expands failed blocks', () => {
		render(<AssertionResults result={mockResult} />);
		// Failed block (queryIndex=1) auto-expanded → assertion type visible
		expect(screen.getByText('intent.table')).toBeDefined();
	});

	it('toggles block expand/collapse on click', () => {
		render(<AssertionResults result={mockResult} />);

		// Failed block is expanded by default — shows assertion type
		expect(screen.getByText('intent.table')).toBeDefined();

		// Click to collapse
		fireEvent.click(screen.getByTestId('query-block-1'));
		expect(screen.queryByText('intent.table')).toBeNull();

		// Click to expand again
		fireEvent.click(screen.getByTestId('query-block-1'));
		expect(screen.getByText('intent.table')).toBeDefined();
	});

	it('shows expected vs actual for failed assertions', () => {
		render(<AssertionResults result={mockResult} />);
		expect(screen.getByText('Expected:')).toBeDefined();
		expect(screen.getByText('Actual:')).toBeDefined();
		expect(screen.getByText('orders')).toBeDefined();
	});

	it('shows failure message when present', () => {
		render(<AssertionResults result={mockResult} />);
		expect(
			screen.getByText('Expected table "orders" but got "users"'),
		).toBeDefined();
	});
});

describe('AssertionResults — parse errors', () => {
	it('renders parse errors section', () => {
		render(<AssertionResults result={mockResultWithParseErrors} />);
		expect(screen.getByText('Parse Errors')).toBeDefined();
	});

	it('shows each parse error with line number', () => {
		render(<AssertionResults result={mockResultWithParseErrors} />);
		expect(
			screen.getByText('Line 3: Unknown assertion type: "bad.type"'),
		).toBeDefined();
		expect(
			screen.getByText('Line 7: Malformed assertion syntax'),
		).toBeDefined();
	});

	it('hides parse errors when none exist', () => {
		render(<AssertionResults result={mockResult} />);
		expect(screen.queryByText('Parse Errors')).toBeNull();
	});
});

describe('AssertionResults — skipped assertions', () => {
	it('shows skip reason for skipped assertions', () => {
		render(<AssertionResults result={mockResultWithSkipped} />);
		// Passed block is collapsed — expand it
		fireEvent.click(screen.getByTestId('query-block-0'));
		expect(screen.getByText('Skipped: No DB connection')).toBeDefined();
	});

	it('shows assertion type for skipped assertions', () => {
		render(<AssertionResults result={mockResultWithSkipped} />);
		fireEvent.click(screen.getByTestId('query-block-0'));
		expect(screen.getByText('db.success')).toBeDefined();
	});
});
