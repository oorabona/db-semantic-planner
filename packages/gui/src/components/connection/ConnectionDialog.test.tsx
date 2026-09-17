// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
				'sslmode "allow" is not supported. Choose disable, prefer, or require, then save this profile.',
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

	it('shows a plaintext fallback and a non-local warning in a test result', () => {
		renderDialog({
			initial: { host: 'db.example.test', database: 'app' },
			testResult: {
				ok: true,
				message: 'Connection successful!',
				transport: 'fallback-plaintext',
			},
		});

		expect(screen.getByText('Transport: Plaintext fallback')).toBeTruthy();
		expect(
			screen.getByText(
				'Warning: TLS was unavailable, so this connection fell back to plaintext over a non-local network.',
			),
		).toBeTruthy();
	});
});
