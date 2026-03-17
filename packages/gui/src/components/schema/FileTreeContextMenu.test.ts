import { describe, expect, it, vi } from 'vitest';
import { fileActions } from './FileTreeContextMenu';

describe('fileActions', () => {
	it('returns empty array when no handlers provided', () => {
		expect(fileActions('test.dbsp', {})).toEqual([]);
	});

	it('returns Remove action when onRemoveFile provided', () => {
		const onRemoveFile = vi.fn();
		const actions = fileActions('test.dbsp', { onRemoveFile });

		expect(actions).toHaveLength(1);
		expect(actions[0]!.label).toBe('Remove from project');
		expect(actions[0]!.danger).toBeUndefined();
	});

	it('returns Delete action when onDeleteFile provided', () => {
		const onDeleteFile = vi.fn();
		const actions = fileActions('test.dbsp', { onDeleteFile });

		expect(actions).toHaveLength(1);
		expect(actions[0]!.label).toBe('Delete from disk');
		expect(actions[0]!.danger).toBe(true);
	});

	it('returns both actions in order when both handlers provided', () => {
		const actions = fileActions('test.dbsp', {
			onRemoveFile: vi.fn(),
			onDeleteFile: vi.fn(),
		});

		expect(actions).toHaveLength(2);
		expect(actions[0]!.label).toBe('Remove from project');
		expect(actions[1]!.label).toBe('Delete from disk');
	});

	it('calls onRemoveFile with correct path', () => {
		const onRemoveFile = vi.fn();
		const actions = fileActions('src/main.dbsp', { onRemoveFile });

		actions[0]!.onClick();
		expect(onRemoveFile).toHaveBeenCalledWith('src/main.dbsp');
	});

	it('calls onDeleteFile with correct path', () => {
		const onDeleteFile = vi.fn();
		const actions = fileActions('src/main.dbsp', { onDeleteFile });

		actions[0]!.onClick();
		expect(onDeleteFile).toHaveBeenCalledWith('src/main.dbsp');
	});
});
