// @vitest-environment jsdom
/**
 * Tests for ApplyConfirmDialog — destructive checkbox gate + basic rendering.
 * Covers SC-22: Destructive → warning + "I reviewed" checkbox.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplyConfirmDialog } from './ApplyConfirmDialog';

const baseProps = {
	open: true,
	onConfirm: vi.fn(),
	onCancel: vi.fn(),
	statements: ['ALTER TABLE "users" DROP COLUMN "legacy"'],
	hasDestructive: false,
	applying: false,
};

describe('ApplyConfirmDialog', () => {
	afterEach(cleanup);
	it('renders nothing when closed', () => {
		const { container } = render(
			<ApplyConfirmDialog {...baseProps} open={false} />,
		);
		expect(container.firstChild).toBeNull();
	});

	it('shows SQL preview and statement count', () => {
		render(<ApplyConfirmDialog {...baseProps} />);
		expect(screen.getByTestId('apply-sql-preview').textContent).toContain(
			'ALTER TABLE "users" DROP COLUMN "legacy"',
		);
		expect(screen.getByText(/1 statement/)).toBeDefined();
	});

	describe('when not destructive', () => {
		it('confirm button is enabled immediately', () => {
			render(<ApplyConfirmDialog {...baseProps} />);
			const btn = screen.getByTestId('apply-confirm-btn') as HTMLButtonElement;
			expect(btn.disabled).toBe(false);
		});

		it('does not show destructive warning or checkbox', () => {
			render(<ApplyConfirmDialog {...baseProps} />);
			expect(screen.queryByTestId('destructive-warning')).toBeNull();
			expect(screen.queryByTestId('reviewed-checkbox')).toBeNull();
		});
	});

	describe('when destructive (SC-22)', () => {
		const destructiveProps = { ...baseProps, hasDestructive: true };

		it('shows destructive warning', () => {
			render(<ApplyConfirmDialog {...destructiveProps} />);
			expect(screen.getByTestId('destructive-warning')).toBeDefined();
		});

		it('confirm button is disabled until checkbox checked', () => {
			render(<ApplyConfirmDialog {...destructiveProps} />);
			const btn = screen.getByTestId('apply-confirm-btn') as HTMLButtonElement;
			expect(btn.disabled).toBe(true);

			fireEvent.click(screen.getByTestId('reviewed-checkbox'));
			expect(btn.disabled).toBe(false);
		});

		it('checkbox unchecks → re-disables confirm', () => {
			render(<ApplyConfirmDialog {...destructiveProps} />);
			const checkbox = screen.getByTestId('reviewed-checkbox');
			fireEvent.click(checkbox); // check
			fireEvent.click(checkbox); // uncheck
			const btn = screen.getByTestId('apply-confirm-btn') as HTMLButtonElement;
			expect(btn.disabled).toBe(true);
		});
	});

	it('calls onCancel when cancel clicked', () => {
		const onCancel = vi.fn();
		render(<ApplyConfirmDialog {...baseProps} onCancel={onCancel} />);
		fireEvent.click(screen.getByTestId('apply-cancel-btn'));
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it('calls onConfirm when confirm clicked', () => {
		const onConfirm = vi.fn();
		render(<ApplyConfirmDialog {...baseProps} onConfirm={onConfirm} />);
		fireEvent.click(screen.getByTestId('apply-confirm-btn'));
		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it('disables buttons while applying', () => {
		render(<ApplyConfirmDialog {...baseProps} applying={true} />);
		const confirmBtn = screen.getByTestId(
			'apply-confirm-btn',
		) as HTMLButtonElement;
		const cancelBtn = screen.getByTestId(
			'apply-cancel-btn',
		) as HTMLButtonElement;
		expect(confirmBtn.disabled).toBe(true);
		expect(cancelBtn.disabled).toBe(true);
		expect(screen.getByText('Applying...')).toBeDefined();
	});

	it('pluralizes statement count', () => {
		render(
			<ApplyConfirmDialog
				{...baseProps}
				statements={['stmt 1', 'stmt 2', 'stmt 3']}
			/>,
		);
		expect(screen.getByText(/3 statements/)).toBeDefined();
	});
});
