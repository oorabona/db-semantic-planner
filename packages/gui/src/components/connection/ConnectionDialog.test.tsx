// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionTestResult } from '@/lib/connection-transport';
import { ConnectionDialog } from './ConnectionDialog';

afterEach(cleanup);

function renderDialog(
	overrides: Partial<React.ComponentProps<typeof ConnectionDialog>> = {},
) {
	const props: React.ComponentProps<typeof ConnectionDialog> = {
		open: true,
		onClose: vi.fn(),
		onConnect: vi.fn(),
		onTest: vi.fn(),
		onSave: vi.fn(),
		onDiscover: vi.fn().mockResolvedValue({ databases: [] }),
		onListSchemas: vi.fn().mockResolvedValue({ schemas: [] }),
		...overrides,
	};
	render(<ConnectionDialog {...props} />);
	return props;
}

describe('ConnectionDialog SSL modes', () => {
	it('does not offer allow', () => {
		renderDialog();
		expect(screen.queryByRole('option', { name: 'Allow' })).toBeNull();
	});

	it('requires a saved allow profile to choose and save a supported mode', () => {
		const props = renderDialog({
			initial: {
				name: 'Saved profile',
				database: 'app',
				sslMode: 'allow',
			},
		});

		expect(
			screen.getByText(
				'sslmode "allow" is not supported. Choose disable, prefer, require, or verify-full, then save this profile.',
			),
		).toBeTruthy();
		expect(
			(
				screen.getByRole('button', {
					name: 'Test Connection',
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
		expect(
			(screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
				.disabled,
		).toBe(true);

		fireEvent.change(screen.getByLabelText('SSL Mode'), {
			target: { value: 'require' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(props.onSave).toHaveBeenCalledWith(
			expect.objectContaining({ sslMode: 'require' }),
		);
	});

	it.each([
		['localhost', { host: 'localhost', database: 'app' }],
		['a Unix socket path', { host: '/var/run/postgresql', database: 'app' }],
	])('shows a plaintext fallback warning for %s', (_, initial) => {
		renderDialog({
			initial,
			testResult: {
				ok: true,
				message: 'Connection successful!',
				transport: 'fallback-plaintext',
			},
		});

		expect(screen.getByText('Transport: Plaintext fallback')).toBeTruthy();
		expect(
			screen.getByText(
				'Warning: TLS was unavailable, so this connection is not encrypted.',
			),
		).toBeTruthy();
	});

	it('starts fresh across two new opens, a new then edit, and edit then edit', () => {
		const props = {
			onClose: vi.fn(),
			onConnect: vi.fn(),
			onTest: vi.fn(),
			onSave: vi.fn(),
			onDiscover: vi.fn().mockResolvedValue({ databases: [] }),
			onListSchemas: vi.fn().mockResolvedValue({ schemas: [] }),
		};
		const dialog = (open: boolean, initial?: { name: string; host: string }) =>
			open ? <ConnectionDialog open initial={initial} {...props} /> : null;

		const { rerender } = render(dialog(true));
		fireEvent.change(screen.getByLabelText('Host'), {
			target: { value: 'changed.example.test' },
		});
		rerender(dialog(false));
		rerender(dialog(true));
		expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe(
			'localhost',
		);

		rerender(dialog(false));
		rerender(dialog(true, { name: 'First', host: 'first.example.test' }));
		expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe(
			'first.example.test',
		);

		rerender(dialog(false));
		rerender(dialog(true, { name: 'Second', host: 'second.example.test' }));
		expect((screen.getByLabelText('Host') as HTMLInputElement).value).toBe(
			'second.example.test',
		);
	});

	it('clears a fallback result after a form edit and after closing and reopening', () => {
		function DialogHost() {
			const [open, setOpen] = useState(true);
			const [testResult, setTestResult] = useState<ConnectionTestResult | null>(
				{
					ok: true,
					message: 'Connection successful!',
					transport: 'fallback-plaintext',
				},
			);
			return (
				<>
					<button type="button" onClick={() => setOpen(true)}>
						Reopen
					</button>
					{open && (
						<ConnectionDialog
							open
							onClose={() => setOpen(false)}
							onConnect={vi.fn()}
							onTest={vi.fn()}
							onSave={vi.fn()}
							onDiscover={vi.fn().mockResolvedValue({ databases: [] })}
							onListSchemas={vi.fn().mockResolvedValue({ schemas: [] })}
							testResult={testResult}
							onTestResultInvalidated={() => setTestResult(null)}
						/>
					)}
				</>
			);
		}

		render(<DialogHost />);
		expect(screen.getByText('Transport: Plaintext fallback')).toBeTruthy();
		fireEvent.change(screen.getByLabelText('Host'), {
			target: { value: 'changed.example.test' },
		});
		expect(screen.queryByText('Transport: Plaintext fallback')).toBeNull();

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
		expect(screen.queryByText('Transport: Plaintext fallback')).toBeNull();
	});
});
