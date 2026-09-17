// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionStatus } from './ConnectionStatus';

afterEach(cleanup);

describe('ConnectionStatus', () => {
	it.each([
		['localhost', 'localhost'],
		['no profile host', undefined],
	])('warns about an unencrypted fallback for %s', (_, host) => {
		render(
			<ConnectionStatus
				status="connected"
				transport="fallback-plaintext"
				host={host}
			/>,
		);

		expect(
			screen.getByText(
				'Warning: TLS was unavailable, so this connection is not encrypted.',
			),
		).toBeTruthy();
	});
});
