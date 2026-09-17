// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionTestResult } from '@/lib/connection-transport';
import type { ListSchemasResult } from '@/lib/ipc';
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
		onDiscover: vi.fn().mockResolvedValue({ databases: [], transport: 'tls' }),
		onListSchemas: vi.fn().mockResolvedValue({ schemas: [], transport: 'tls' }),
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

	it('shows a cleanup failure as a warning separate from successful test text', () => {
		renderDialog({
			testResult: {
				ok: true,
				message: 'Connection successful!',
				transport: 'tls',
				cleanupError: 'Disconnect failed: sidecar cleanup failed',
			},
		});

		expect(screen.getByText('Connection successful!')).toBeTruthy();
		const warning = screen.getByText(
			'Warning: Disconnect failed: sidecar cleanup failed',
		);
		expect(warning.classList).toContain('text-yellow-700');
	});

	it('shows the fallback warning after discovery uses plaintext', async () => {
		renderDialog({
			initial: { database: 'app' },
			onDiscover: vi.fn().mockResolvedValue({
				databases: ['app'],
				transport: 'fallback-plaintext',
			}),
			onListSchemas: vi.fn().mockResolvedValue({
				schemas: ['public'],
				transport: 'fallback-plaintext',
			}),
		});

		fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
		expect(
			await screen.findByText(
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
							onDiscover={vi.fn().mockResolvedValue({
								databases: [],
								transport: 'tls',
							})}
							onListSchemas={vi.fn().mockResolvedValue({
								schemas: [],
								transport: 'tls',
							})}
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

	it('ignores a schema response that resolves after starting a test', async () => {
		let resolveSchemas: ((value: ListSchemasResult) => void) | undefined;
		const onListSchemas = vi.fn(
			() =>
				new Promise<ListSchemasResult>((resolve) => {
					resolveSchemas = resolve;
				}),
		);
		function DialogHost() {
			const [testResult, setTestResult] = useState<ConnectionTestResult | null>(
				null,
			);
			return (
				<ConnectionDialog
					open
					onClose={vi.fn()}
					onConnect={vi.fn()}
					onTest={() =>
						setTestResult({
							ok: true,
							message: 'Connection successful!',
							transport: 'fallback-plaintext',
						})
					}
					onSave={vi.fn()}
					onDiscover={vi.fn().mockResolvedValue({
						databases: ['app'],
						transport: 'tls',
					})}
					onListSchemas={onListSchemas}
					initial={{ database: 'app', schema: 'before-test' }}
					testResult={testResult}
					onTestResultInvalidated={() => setTestResult(null)}
				/>
			);
		}
		render(<DialogHost />);

		fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
		await waitFor(() => expect(onListSchemas).toHaveBeenCalledOnce());
		fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
		expect(screen.getByText('Schema').querySelector('svg')).toBeNull();
		await act(async () => {
			resolveSchemas?.({ schemas: ['public'], transport: 'tls' });
		});

		await waitFor(() => {
			expect(screen.getByText('Transport: Plaintext fallback')).toBeTruthy();
			expect((screen.getByLabelText('Schema') as HTMLInputElement).value).toBe(
				'before-test',
			);
		});
	});

	it('clears discovery state and ignores a late response after a form edit', async () => {
		let resolveDiscovery:
			| ((value: { databases: string[]; transport: 'tls' }) => void)
			| undefined;
		const onDiscover = vi.fn(
			() =>
				new Promise<{ databases: string[]; transport: 'tls' }>((resolve) => {
					resolveDiscovery = resolve;
				}),
		);
		renderDialog({
			initial: { database: 'before-edit' },
			onDiscover,
		});

		fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
		expect(screen.getByRole('button', { name: 'Discovering...' })).toBeTruthy();

		fireEvent.change(screen.getByLabelText('Host'), {
			target: { value: 'changed.example.test' },
		});
		const discoverButton = screen.getByRole('button', { name: 'Discover' });
		expect((discoverButton as HTMLButtonElement).disabled).toBe(false);

		await act(async () => {
			resolveDiscovery?.({ databases: ['late-database'], transport: 'tls' });
		});

		expect(onDiscover).toHaveBeenCalledOnce();
		expect((screen.getByLabelText('Database') as HTMLInputElement).value).toBe(
			'before-edit',
		);
	});

	it('does not invalidate a result when re-selecting the current database', async () => {
		const onTestResultInvalidated = vi.fn();
		renderDialog({
			initial: { database: 'app' },
			testResult: {
				ok: true,
				message: 'Connection successful!',
				transport: 'fallback-plaintext',
			},
			onDiscover: vi.fn().mockResolvedValue({
				databases: ['app'],
				transport: 'tls',
			}),
			onListSchemas: vi.fn().mockResolvedValue({
				schemas: [],
				transport: 'tls',
			}),
			onTestResultInvalidated,
		});

		fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
		const database = await screen.findByLabelText('Database');
		fireEvent.change(database, { target: { value: 'app' } });

		expect(onTestResultInvalidated).not.toHaveBeenCalled();
		expect(screen.getByText('Transport: Plaintext fallback')).toBeTruthy();
	});
});
