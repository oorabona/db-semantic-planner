// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecentProject } from '@/lib/app-db';
import { RecentProjectsDialog } from './RecentProjectsDialog';

const mockProjects: RecentProject[] = [
	{
		path: '/home/user/projects/alpha',
		name: 'Alpha',
		folderName: 'alpha',
		lastOpenedAt: Date.now() - 86400000,
		createdAt: Date.now() - 172800000,
	},
	{
		path: '/home/user/projects/beta',
		name: 'Beta',
		folderName: 'beta',
		lastOpenedAt: Date.now() - 3600000,
		createdAt: Date.now() - 7200000,
	},
];

const baseProps = {
	open: true,
	onClose: vi.fn(),
	projects: mockProjects,
	onOpen: vi.fn(),
	onRemove: vi.fn(),
};

describe('RecentProjectsDialog', () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('renders nothing when closed', () => {
		const { container } = render(
			<RecentProjectsDialog {...baseProps} open={false} />,
		);
		expect(container.firstChild).toBeNull();
	});

	it('shows project list when open', () => {
		render(<RecentProjectsDialog {...baseProps} />);
		expect(screen.getByText('Alpha')).toBeDefined();
		expect(screen.getByText('Beta')).toBeDefined();
		expect(screen.getByText('Recent Projects')).toBeDefined();
	});

	it('displays project paths', () => {
		render(<RecentProjectsDialog {...baseProps} />);
		expect(screen.getByText('/home/user/projects/alpha')).toBeDefined();
		expect(screen.getByText('/home/user/projects/beta')).toBeDefined();
	});

	it('shows empty state when no projects', () => {
		render(<RecentProjectsDialog {...baseProps} projects={[]} />);
		expect(screen.getByText('No recent projects')).toBeDefined();
	});

	it('calls onOpen when project is clicked', () => {
		render(<RecentProjectsDialog {...baseProps} />);
		fireEvent.click(screen.getByTestId('recent-project-alpha'));
		expect(baseProps.onOpen).toHaveBeenCalledWith('/home/user/projects/alpha');
	});

	it('calls onRemove when trash button is clicked', () => {
		render(<RecentProjectsDialog {...baseProps} />);
		fireEvent.click(screen.getByTestId('recent-remove-alpha'));
		expect(baseProps.onRemove).toHaveBeenCalledWith(
			'/home/user/projects/alpha',
		);
	});

	it('does not propagate click to onOpen when removing', () => {
		render(<RecentProjectsDialog {...baseProps} />);
		fireEvent.click(screen.getByTestId('recent-remove-beta'));
		expect(baseProps.onOpen).not.toHaveBeenCalled();
		expect(baseProps.onRemove).toHaveBeenCalledWith('/home/user/projects/beta');
	});

	it('calls onClose when close button is clicked', () => {
		render(<RecentProjectsDialog {...baseProps} />);
		fireEvent.click(screen.getByTestId('recent-close'));
		expect(baseProps.onClose).toHaveBeenCalled();
	});

	it('calls onClose when backdrop is clicked', () => {
		render(<RecentProjectsDialog {...baseProps} />);
		// Backdrop is the role="presentation" div
		const backdrop = document.querySelector('[role="presentation"]');
		expect(backdrop).not.toBeNull();
		fireEvent.click(backdrop!);
		expect(baseProps.onClose).toHaveBeenCalled();
	});
});
