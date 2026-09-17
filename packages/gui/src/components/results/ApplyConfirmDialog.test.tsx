// @vitest-environment jsdom
/**
 * Tests for ApplyConfirmDialog — non-destructive Apply confirmation + basic rendering.
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

	describe('when the diff also has destructive changes', () => {
		const destructiveProps = { ...baseProps, hasDestructive: true };

		it('says destructive changes are excluded', () => {
			render(<ApplyConfirmDialog {...destructiveProps} />);
			expect(screen.getByTestId('destructive-warning')).toBeDefined();
			expect(screen.getByText(/excluded from this Apply/)).toBeDefined();
		});

		it('confirms immediately because the shown bundle excludes destructive SQL', () => {
			render(<ApplyConfirmDialog {...destructiveProps} />);
			const btn = screen.getByTestId('apply-confirm-btn') as HTMLButtonElement;
			expect(btn.disabled).toBe(false);
		});

		it('does not offer a destructive reviewed checkbox', () => {
			render(<ApplyConfirmDialog {...destructiveProps} />);
			expect(screen.queryByTestId('reviewed-checkbox')).toBeNull();
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
