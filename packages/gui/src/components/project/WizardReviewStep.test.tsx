// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WizardReviewStep } from './WizardReviewStep';

const defaultProps = {
	name: 'my-project',
	folderPath: '/home/user/my-project',
	connectionCount: 2,
	files: ['src/main.dbsp', 'src/query.sql'] as string[],
	schemaSelection: 'generate' as const,
	generateSchema: true,
};

afterEach(cleanup);

describe('WizardReviewStep', () => {
	it('renders the review container', () => {
		render(<WizardReviewStep {...defaultProps} />);
		expect(screen.getByTestId('wizard-review')).toBeDefined();
	});

	it('displays the project name', () => {
		render(<WizardReviewStep {...defaultProps} />);
		expect(screen.getByTestId('review-name').textContent).toBe('my-project');
	});

	it('displays the folder path', () => {
		render(<WizardReviewStep {...defaultProps} />);
		expect(screen.getByTestId('review-folder').textContent).toBe(
			'/home/user/my-project',
		);
	});

	it('displays connection count', () => {
		render(<WizardReviewStep {...defaultProps} />);
		expect(screen.getByTestId('review-connections').textContent).toBe(
			'2 connections',
		);
	});

	it('displays singular connection text for 1', () => {
		render(<WizardReviewStep {...defaultProps} connectionCount={1} />);
		expect(screen.getByTestId('review-connections').textContent).toBe(
			'1 connection',
		);
	});

	it('displays "None configured" for 0 connections', () => {
		render(<WizardReviewStep {...defaultProps} connectionCount={0} />);
		expect(screen.getByTestId('review-connections').textContent).toBe(
			'None configured',
		);
	});

	it('displays file count', () => {
		render(<WizardReviewStep {...defaultProps} />);
		expect(screen.getByText('2 files')).toBeDefined();
	});

	it('displays "No files selected" when empty', () => {
		render(<WizardReviewStep {...defaultProps} files={[]} />);
		expect(screen.getByText('No files selected')).toBeDefined();
	});

	it('displays schema selection label for "generate"', () => {
		render(<WizardReviewStep {...defaultProps} />);
		expect(screen.getByText('Generate from DB')).toBeDefined();
	});

	it('displays schema selection label for "skip"', () => {
		render(<WizardReviewStep {...defaultProps} schemaSelection="skip" />);
		expect(screen.getByText('Skip (configure later)')).toBeDefined();
	});

	it('displays schema selection label for auto-detect', () => {
		render(<WizardReviewStep {...defaultProps} schemaSelection="schema.ts" />);
		expect(screen.getByText('Auto-detect (schema.ts)')).toBeDefined();
	});

	it('shows generate schema.ts notice when enabled', () => {
		render(<WizardReviewStep {...defaultProps} generateSchema={true} />);
		expect(
			screen.getByText('Will generate schema.ts on creation'),
		).toBeDefined();
	});

	it('hides generate schema.ts notice when disabled', () => {
		render(<WizardReviewStep {...defaultProps} generateSchema={false} />);
		expect(
			screen.queryByText('Will generate schema.ts on creation'),
		).toBeNull();
	});
});
