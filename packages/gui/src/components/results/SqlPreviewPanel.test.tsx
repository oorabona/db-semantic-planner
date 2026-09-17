// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SqlPreviewPanel } from './SqlPreviewPanel';

describe('SqlPreviewPanel', () => {
	it('labels DOWN as a rollback preview that is not executed', () => {
		render(
			<SqlPreviewPanel
				upSQL={['CREATE TABLE users ();']}
				downSQL={['DROP TABLE users;']}
			/>,
		);

		fireEvent.click(screen.getByTestId('sql-tab-down'));
		expect(screen.getByTestId('sql-tab-down').textContent).toContain(
			'Rollback preview (1)',
		);
		expect(
			screen.getByText('Rollback preview only; it is not executed.'),
		).toBeDefined();
	});
});
