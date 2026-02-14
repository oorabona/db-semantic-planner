// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnectionStore } from '@/stores/connection-store';
import { useEditorStore } from '@/stores/editor-store';
import { WelcomeScreen } from './WelcomeScreen';

describe('WelcomeScreen', () => {
	const onConnect = vi.fn();

	afterEach(() => {
		cleanup();
	});

	beforeEach(() => {
		onConnect.mockReset();
		useConnectionStore.setState({ status: 'disconnected' });
		useEditorStore.setState({ tabs: [], activeTabId: null });
	});

	it('renders title and description', () => {
		render(<WelcomeScreen onConnect={onConnect} />);
		expect(screen.getByText('db-semantic-planner')).toBeDefined();
		expect(
			screen.getByText('Intent-first database query explorer'),
		).toBeDefined();
	});

	it('shows Connect button when disconnected', () => {
		render(<WelcomeScreen onConnect={onConnect} />);
		expect(screen.getByText('Connect to Database')).toBeDefined();
	});

	it('hides Connect button when already connected', () => {
		useConnectionStore.setState({ status: 'connected' });
		render(<WelcomeScreen onConnect={onConnect} />);
		expect(screen.queryByText('Connect to Database')).toBeNull();
	});

	it('calls onConnect when Connect button clicked', () => {
		render(<WelcomeScreen onConnect={onConnect} />);
		fireEvent.click(screen.getByText('Connect to Database'));
		expect(onConnect).toHaveBeenCalledOnce();
	});

	it('creates SQL tab when New SQL Query clicked', () => {
		render(<WelcomeScreen onConnect={onConnect} />);
		fireEvent.click(screen.getByText('New SQL Query'));
		const { tabs } = useEditorStore.getState();
		expect(tabs).toHaveLength(1);
		expect(tabs[0]!.language).toBe('sql');
	});

	it('creates NQL tab when New NQL Query clicked', () => {
		render(<WelcomeScreen onConnect={onConnect} />);
		fireEvent.click(screen.getByText('New NQL Query'));
		const { tabs } = useEditorStore.getState();
		expect(tabs).toHaveLength(1);
		expect(tabs[0]!.language).toBe('nql');
	});

	it('renders sample queries', () => {
		render(<WelcomeScreen onConnect={onConnect} />);
		expect(screen.getByText('Select all users')).toBeDefined();
		expect(screen.getByText('NQL pipe query')).toBeDefined();
		expect(screen.getByText('Join with filtering')).toBeDefined();
	});

	it('loads sample query into new tab on click', () => {
		render(<WelcomeScreen onConnect={onConnect} />);
		fireEvent.click(screen.getByText('NQL pipe query'));
		const { tabs } = useEditorStore.getState();
		expect(tabs).toHaveLength(1);
		expect(tabs[0]!.language).toBe('nql');
		expect(tabs[0]!.content).toContain('from users');
	});

	it('shows keyboard shortcut hints', () => {
		render(<WelcomeScreen onConnect={onConnect} />);
		expect(screen.getByText('⌘K')).toBeDefined();
		expect(screen.getByText('⌘O')).toBeDefined();
	});
});
