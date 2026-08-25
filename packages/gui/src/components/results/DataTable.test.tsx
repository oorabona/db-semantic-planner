// @vitest-environment jsdom
/**
 * Tests for DataTable scroll-near-end detection (AC-2: infinite scroll trigger).
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataTable } from './DataTable';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	cleanup();
	vi.clearAllTimers();
	vi.useRealTimers();
});

// ── Fixtures ─────────────────────────────────────────────────────

const COLUMNS = ['id', 'name'];
const ROWS: Record<string, unknown>[] = Array.from({ length: 20 }, (_, i) => ({
	id: i + 1,
	name: `row-${i + 1}`,
}));

// ── Tests ────────────────────────────────────────────────────────

describe('DataTable', () => {
	it('renders rows and columns', () => {
		const offsetHeight = vi
			.spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
			.mockReturnValue(640);
		const offsetWidth = vi
			.spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
			.mockReturnValue(960);
		try {
			const { container } = render(<DataTable columns={COLUMNS} rows={ROWS} />);
			act(() => {
				vi.runOnlyPendingTimers();
			});
			const table = container.querySelector('table');
			expect(table).toBeTruthy();
			// Should have header cells for each column
			const headers = container.querySelectorAll('thead th');
			expect(headers.length).toBeGreaterThanOrEqual(COLUMNS.length);
			expect(container.querySelector('tbody')?.textContent).toContain('row-1');
		} finally {
			offsetHeight.mockRestore();
			offsetWidth.mockRestore();
		}
	});

	describe('onScrollNearEnd (AC-2)', () => {
		it('fires callback when scroll is near bottom', () => {
			const onScrollNearEnd = vi.fn();
			const { container } = render(
				<DataTable
					columns={COLUMNS}
					rows={ROWS}
					onScrollNearEnd={onScrollNearEnd}
				/>,
			);

			// The scroll container is the outermost div (ref={parentRef})
			const scrollContainer = container.firstElementChild as HTMLElement;
			expect(scrollContainer).toBeTruthy();

			// Simulate scroll dimensions: container is small, content is tall
			Object.defineProperty(scrollContainer, 'scrollHeight', {
				value: 1000,
				configurable: true,
			});
			Object.defineProperty(scrollContainer, 'clientHeight', {
				value: 400,
				configurable: true,
			});
			Object.defineProperty(scrollContainer, 'scrollTop', {
				value: 700,
				writable: true,
				configurable: true,
			});

			// Trigger scroll — distance from bottom = 1000 - 700 - 400 = -100 (< 200 threshold)
			scrollContainer.dispatchEvent(new Event('scroll'));

			expect(onScrollNearEnd).toHaveBeenCalledTimes(1);
		});

		it('does NOT fire when scroll is far from bottom', () => {
			const onScrollNearEnd = vi.fn();
			const { container } = render(
				<DataTable
					columns={COLUMNS}
					rows={ROWS}
					onScrollNearEnd={onScrollNearEnd}
				/>,
			);

			const scrollContainer = container.firstElementChild as HTMLElement;

			Object.defineProperty(scrollContainer, 'scrollHeight', {
				value: 1000,
				configurable: true,
			});
			Object.defineProperty(scrollContainer, 'clientHeight', {
				value: 400,
				configurable: true,
			});
			Object.defineProperty(scrollContainer, 'scrollTop', {
				value: 100,
				writable: true,
				configurable: true,
			});

			// distance from bottom = 1000 - 100 - 400 = 500 (> 200 threshold)
			scrollContainer.dispatchEvent(new Event('scroll'));

			expect(onScrollNearEnd).not.toHaveBeenCalled();
		});

		it('does NOT fire when onScrollNearEnd is undefined', () => {
			const { container } = render(<DataTable columns={COLUMNS} rows={ROWS} />);

			const scrollContainer = container.firstElementChild as HTMLElement;

			Object.defineProperty(scrollContainer, 'scrollHeight', {
				value: 1000,
				configurable: true,
			});
			Object.defineProperty(scrollContainer, 'clientHeight', {
				value: 400,
				configurable: true,
			});
			Object.defineProperty(scrollContainer, 'scrollTop', {
				value: 700,
				writable: true,
				configurable: true,
			});

			// Should not throw even though near bottom
			expect(() => {
				scrollContainer.dispatchEvent(new Event('scroll'));
			}).not.toThrow();
		});
	});
});
