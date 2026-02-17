// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '@/stores/editor-store';
import { EditorPanel } from './EditorPanel';

// Mock child components to isolate EditorPanel logic
vi.mock('@/components/editor/EditorTabs', () => ({
	EditorTabs: () => <div data-testid="editor-tabs">EditorTabs</div>,
}));
vi.mock('@/components/editor/SqlEditor', () => ({
	SqlEditor: () => <div data-testid="sql-editor">SqlEditor</div>,
}));
vi.mock('@/components/layout/WelcomeScreen', () => ({
	WelcomeScreen: ({
		onConnect,
		onNewProject,
		onOpenProject,
	}: {
		onConnect: () => void;
		onNewProject?: () => void;
		onOpenProject?: () => void;
	}) => (
		<div data-testid="welcome-screen">
			<button type="button" onClick={onConnect}>
				mock-connect
			</button>
			{onNewProject && (
				<button type="button" onClick={onNewProject}>
					mock-new-project
				</button>
			)}
			{onOpenProject && (
				<button type="button" onClick={onOpenProject}>
					mock-open-project
				</button>
			)}
		</div>
	),
}));

describe('EditorPanel', () => {
	const onConnect = vi.fn();

	afterEach(() => {
		cleanup();
	});

	beforeEach(() => {
		onConnect.mockReset();
		useEditorStore.setState({ tabs: [], activeTabId: null });
	});

	it('shows WelcomeScreen when no tabs exist', () => {
		render(<EditorPanel onConnect={onConnect} />);
		expect(screen.getByTestId('welcome-screen')).toBeDefined();
		expect(screen.queryByTestId('editor-tabs')).toBeNull();
	});

	it('shows editor when tabs exist', () => {
		useEditorStore.getState().addTab('sql');
		render(<EditorPanel onConnect={onConnect} />);
		expect(screen.getByTestId('editor-tabs')).toBeDefined();
		expect(screen.queryByTestId('welcome-screen')).toBeNull();
	});

	it('passes onConnect to WelcomeScreen', async () => {
		render(<EditorPanel onConnect={onConnect} />);
		screen.getByText('mock-connect').click();
		expect(onConnect).toHaveBeenCalledOnce();
	});

	it('passes onNewProject to WelcomeScreen', () => {
		const onNewProject = vi.fn();
		render(<EditorPanel onConnect={onConnect} onNewProject={onNewProject} />);
		screen.getByText('mock-new-project').click();
		expect(onNewProject).toHaveBeenCalledOnce();
	});

	it('passes onOpenProject to WelcomeScreen', () => {
		const onOpenProject = vi.fn();
		render(<EditorPanel onConnect={onConnect} onOpenProject={onOpenProject} />);
		screen.getByText('mock-open-project').click();
		expect(onOpenProject).toHaveBeenCalledOnce();
	});
});
