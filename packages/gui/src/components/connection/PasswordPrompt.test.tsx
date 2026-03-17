// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock Radix Dialog to avoid portal complexity in unit tests
vi.mock('@/components/ui/dialog', () => ({
	Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
		open ? <div data-testid="dialog">{children}</div> : null,
	DialogContent: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	DialogHeader: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	DialogTitle: ({ children }: { children: React.ReactNode }) => (
		<h2>{children}</h2>
	),
	DialogFooter: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
}));

import { PasswordPrompt } from './PasswordPrompt';

afterEach(cleanup);

describe('PasswordPrompt', () => {
	const baseProps = {
		open: true,
		profileName: 'dev-local',
		onSubmit: vi.fn(),
		onCancel: vi.fn(),
	};

	it('renders profile name', () => {
		render(<PasswordPrompt {...baseProps} />);
		expect(screen.getByText('dev-local')).toBeTruthy();
	});

	it('renders title', () => {
		render(<PasswordPrompt {...baseProps} />);
		expect(screen.getByText('Password Required')).toBeTruthy();
	});

	it('has a password input', () => {
		render(<PasswordPrompt {...baseProps} />);
		const input = screen.getByLabelText('Password');
		expect(input).toBeTruthy();
		expect(input.getAttribute('type')).toBe('password');
	});

	it('disables Connect when password is empty', () => {
		render(<PasswordPrompt {...baseProps} />);
		const btn = screen.getByRole('button', { name: 'Connect' });
		expect(btn.hasAttribute('disabled')).toBe(true);
	});

	it('enables Connect when password is entered', () => {
		render(<PasswordPrompt {...baseProps} />);
		const input = screen.getByLabelText('Password');
		fireEvent.change(input, { target: { value: 'secret' } });
		const btn = screen.getByRole('button', { name: 'Connect' });
		expect(btn.hasAttribute('disabled')).toBe(false);
	});

	it('calls onSubmit with password on form submit', () => {
		const onSubmit = vi.fn();
		render(<PasswordPrompt {...baseProps} onSubmit={onSubmit} />);
		const input = screen.getByLabelText('Password');
		fireEvent.change(input, { target: { value: 'secret123' } });
		fireEvent.submit(input.closest('form')!);
		expect(onSubmit).toHaveBeenCalledWith('secret123');
	});

	it('calls onCancel when Cancel clicked', () => {
		const onCancel = vi.fn();
		render(<PasswordPrompt {...baseProps} onCancel={onCancel} />);
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onCancel).toHaveBeenCalled();
	});

	it('shows error message', () => {
		render(<PasswordPrompt {...baseProps} error="Bad password" />);
		expect(screen.getByText('Bad password')).toBeTruthy();
	});

	it('shows connecting state', () => {
		render(<PasswordPrompt {...baseProps} connecting />);
		expect(screen.getByRole('button', { name: 'Connecting…' })).toBeTruthy();
		// Input should be disabled
		expect(screen.getByLabelText('Password').hasAttribute('disabled')).toBe(
			true,
		);
	});

	it('does not render when closed', () => {
		render(<PasswordPrompt {...baseProps} open={false} />);
		expect(screen.queryByText('Password Required')).toBeNull();
	});
});
