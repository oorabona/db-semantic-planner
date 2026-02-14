// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiffSummary } from '@/lib/ipc';
import { SchemaDiffSummary } from './SchemaDiffSummary';

afterEach(() => {
	cleanup();
});

const emptySummary: DiffSummary = {
	tables: { added: 0, dropped: 0 },
	columns: { added: 0, dropped: 0, altered: 0 },
	indexes: { added: 0, dropped: 0 },
	constraints: { added: 0, dropped: 0, altered: 0 },
};

const makeSummary = (overrides: Partial<DiffSummary> = {}): DiffSummary => ({
	...emptySummary,
	...overrides,
});

describe('SchemaDiffSummary', () => {
	it('shows "Schemas are in sync" when no changes', () => {
		render(
			<SchemaDiffSummary
				summary={emptySummary}
				hasDestructive={false}
				totalChanges={0}
			/>,
		);
		expect(screen.getByText('Schemas are in sync')).toBeDefined();
	});

	it('renders total change count', () => {
		render(
			<SchemaDiffSummary
				summary={makeSummary({ tables: { added: 2, dropped: 0 } })}
				hasDestructive={false}
				totalChanges={3}
			/>,
		);
		expect(screen.getByText('3 changes')).toBeDefined();
	});

	it('renders singular for 1 change', () => {
		render(
			<SchemaDiffSummary
				summary={makeSummary({ tables: { added: 1, dropped: 0 } })}
				hasDestructive={false}
				totalChanges={1}
			/>,
		);
		expect(screen.getByText('1 change')).toBeDefined();
	});

	it('renders addition badges', () => {
		render(
			<SchemaDiffSummary
				summary={makeSummary({
					tables: { added: 2, dropped: 0 },
					columns: { added: 5, dropped: 0, altered: 0 },
				})}
				hasDestructive={false}
				totalChanges={7}
			/>,
		);
		expect(screen.getByText('+2 tables')).toBeDefined();
		expect(screen.getByText('+5 columns')).toBeDefined();
	});

	it('renders drop badges', () => {
		render(
			<SchemaDiffSummary
				summary={makeSummary({
					tables: { added: 0, dropped: 1 },
					columns: { added: 0, dropped: 3, altered: 0 },
				})}
				hasDestructive={true}
				totalChanges={4}
			/>,
		);
		expect(screen.getByText('-1 tables')).toBeDefined();
		expect(screen.getByText('-3 columns')).toBeDefined();
	});

	it('renders alteration badges', () => {
		render(
			<SchemaDiffSummary
				summary={makeSummary({
					columns: { added: 0, dropped: 0, altered: 2 },
					constraints: { added: 0, dropped: 0, altered: 1 },
				})}
				hasDestructive={false}
				totalChanges={3}
			/>,
		);
		expect(screen.getByText('~2 columns')).toBeDefined();
		expect(screen.getByText('~1 constraints')).toBeDefined();
	});

	it('shows destructive warning when hasDestructive is true', () => {
		render(
			<SchemaDiffSummary
				summary={makeSummary({ tables: { added: 0, dropped: 1 } })}
				hasDestructive={true}
				totalChanges={1}
			/>,
		);
		expect(screen.getByText('Destructive changes')).toBeDefined();
	});

	it('hides destructive warning when hasDestructive is false', () => {
		render(
			<SchemaDiffSummary
				summary={makeSummary({ tables: { added: 1, dropped: 0 } })}
				hasDestructive={false}
				totalChanges={1}
			/>,
		);
		expect(screen.queryByText('Destructive changes')).toBeNull();
	});

	it('applies red background when destructive', () => {
		render(
			<SchemaDiffSummary
				summary={makeSummary({ tables: { added: 0, dropped: 1 } })}
				hasDestructive={true}
				totalChanges={1}
			/>,
		);
		const bar = screen.getByTestId('schema-diff-summary');
		expect(bar.className).toContain('bg-red-500/5');
	});

	it('applies green background when in sync', () => {
		render(
			<SchemaDiffSummary
				summary={emptySummary}
				hasDestructive={false}
				totalChanges={0}
			/>,
		);
		const bar = screen.getByTestId('schema-diff-summary');
		expect(bar.className).toContain('bg-green-500/5');
	});

	it('hides badges for zero counts', () => {
		render(
			<SchemaDiffSummary
				summary={makeSummary({
					tables: { added: 1, dropped: 0 },
					columns: { added: 0, dropped: 0, altered: 0 },
					indexes: { added: 0, dropped: 0 },
					constraints: { added: 0, dropped: 0, altered: 0 },
				})}
				hasDestructive={false}
				totalChanges={1}
			/>,
		);
		expect(screen.getByText('+1 tables')).toBeDefined();
		expect(screen.queryByText(/columns/)).toBeNull();
		expect(screen.queryByText(/indexes/)).toBeNull();
		expect(screen.queryByText(/constraints/)).toBeNull();
	});
});
