// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunAssertionsSummary } from '@/lib/ipc';
import { AssertionSummaryBar } from './AssertionSummaryBar';

afterEach(() => {
	cleanup();
});

const makeSummary = (
	overrides: Partial<RunAssertionsSummary> = {},
): RunAssertionsSummary => ({
	total: 5,
	passed: 3,
	failed: 1,
	skipped: 1,
	results: [],
	...overrides,
});

describe('AssertionSummaryBar', () => {
	it('renders total assertion count', () => {
		render(<AssertionSummaryBar summary={makeSummary()} />);
		expect(screen.getByText('5 assertions')).toBeDefined();
	});

	it('renders singular for 1 assertion', () => {
		render(
			<AssertionSummaryBar
				summary={makeSummary({ total: 1, passed: 1, failed: 0, skipped: 0 })}
			/>,
		);
		expect(screen.getByText('1 assertion')).toBeDefined();
	});

	it('shows passed count', () => {
		render(<AssertionSummaryBar summary={makeSummary()} />);
		expect(screen.getByText('3 passed')).toBeDefined();
	});

	it('shows failed count when failures exist', () => {
		render(<AssertionSummaryBar summary={makeSummary({ failed: 2 })} />);
		expect(screen.getByText('2 failed')).toBeDefined();
	});

	it('hides failed count when 0 failures', () => {
		render(<AssertionSummaryBar summary={makeSummary({ failed: 0 })} />);
		expect(screen.queryByText('0 failed')).toBeNull();
	});

	it('shows skipped count when skips exist', () => {
		render(<AssertionSummaryBar summary={makeSummary({ skipped: 2 })} />);
		expect(screen.getByText('2 skipped')).toBeDefined();
	});

	it('hides skipped count when 0 skipped', () => {
		render(<AssertionSummaryBar summary={makeSummary({ skipped: 0 })} />);
		expect(screen.queryByText('0 skipped')).toBeNull();
	});

	it('shows "All passed" when all pass', () => {
		render(
			<AssertionSummaryBar
				summary={makeSummary({ total: 3, passed: 3, failed: 0, skipped: 0 })}
			/>,
		);
		expect(screen.getByText('All passed')).toBeDefined();
	});

	it('shows failure count badge when failures exist', () => {
		render(<AssertionSummaryBar summary={makeSummary({ failed: 2 })} />);
		expect(screen.getByText('2 failures')).toBeDefined();
	});

	it('shows singular "failure" for 1 failure', () => {
		render(<AssertionSummaryBar summary={makeSummary({ failed: 1 })} />);
		expect(screen.getByText('1 failure')).toBeDefined();
	});

	it('applies green background when all passed', () => {
		render(
			<AssertionSummaryBar
				summary={makeSummary({ total: 2, passed: 2, failed: 0, skipped: 0 })}
			/>,
		);
		const bar = screen.getByTestId('assertion-summary');
		expect(bar.className).toContain('bg-green-500/5');
	});

	it('applies red background when failures exist', () => {
		render(<AssertionSummaryBar summary={makeSummary({ failed: 1 })} />);
		const bar = screen.getByTestId('assertion-summary');
		expect(bar.className).toContain('bg-red-500/5');
	});
});
