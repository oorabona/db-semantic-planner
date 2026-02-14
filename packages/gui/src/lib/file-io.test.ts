import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockOpen, mockSave, mockAsk, mockReadTextFile, mockWriteTextFile } =
	vi.hoisted(() => ({
		mockOpen: vi.fn(),
		mockSave: vi.fn(),
		mockAsk: vi.fn(),
		mockReadTextFile: vi.fn(),
		mockWriteTextFile: vi.fn(),
	}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
	open: mockOpen,
	save: mockSave,
	ask: mockAsk,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
	readTextFile: mockReadTextFile,
	writeTextFile: mockWriteTextFile,
}));

import {
	confirmUnsavedChanges,
	filenameFromPath,
	languageFromPath,
	openFile,
	saveFile,
	saveFileAs,
} from './file-io';

beforeEach(() => {
	vi.clearAllMocks();
});

describe('languageFromPath', () => {
	it('returns nql for .dbsp files', () => {
		expect(languageFromPath('queries/users.dbsp')).toBe('nql');
	});

	it('returns assert for .assert.dbsp files', () => {
		expect(languageFromPath('tests/users.assert.dbsp')).toBe('assert');
	});

	it('returns sql for .sql files', () => {
		expect(languageFromPath('queries/report.sql')).toBe('sql');
	});

	it('defaults to sql for unknown extensions', () => {
		expect(languageFromPath('README.md')).toBe('sql');
	});
});

describe('filenameFromPath', () => {
	it('extracts filename from unix path', () => {
		expect(filenameFromPath('/home/user/queries/users.dbsp')).toBe(
			'users.dbsp',
		);
	});

	it('extracts filename from windows path', () => {
		expect(filenameFromPath('C:\\Users\\dev\\query.sql')).toBe('query.sql');
	});

	it('returns the string itself if no separator', () => {
		expect(filenameFromPath('file.dbsp')).toBe('file.dbsp');
	});
});

describe('openFile', () => {
	it('returns null when user cancels', async () => {
		// Arrange
		mockOpen.mockResolvedValue(null);

		// Act
		const result = await openFile();

		// Assert
		expect(result).toBeNull();
		expect(mockReadTextFile).not.toHaveBeenCalled();
	});

	it('reads file and returns content with language', async () => {
		// Arrange
		mockOpen.mockResolvedValue('/path/to/users.dbsp');
		mockReadTextFile.mockResolvedValue('users | where active = true');

		// Act
		const result = await openFile();

		// Assert
		expect(result).toEqual({
			filePath: '/path/to/users.dbsp',
			content: 'users | where active = true',
			language: 'nql',
		});
		expect(mockReadTextFile).toHaveBeenCalledWith('/path/to/users.dbsp');
	});

	it('detects SQL language for .sql files', async () => {
		// Arrange
		mockOpen.mockResolvedValue('/path/to/query.sql');
		mockReadTextFile.mockResolvedValue('SELECT 1');

		// Act
		const result = await openFile();

		// Assert
		expect(result?.language).toBe('sql');
	});
});

describe('saveFile', () => {
	it('writes content to the given path', async () => {
		// Arrange
		mockWriteTextFile.mockResolvedValue(undefined);

		// Act
		await saveFile('/path/to/file.dbsp', 'content here');

		// Assert
		expect(mockWriteTextFile).toHaveBeenCalledWith(
			'/path/to/file.dbsp',
			'content here',
		);
	});

	it('propagates errors from fs plugin', async () => {
		// Arrange
		mockWriteTextFile.mockRejectedValue(new Error('Permission denied'));

		// Act & Assert
		await expect(saveFile('/read-only.dbsp', 'x')).rejects.toThrow(
			'Permission denied',
		);
	});
});

describe('saveFileAs', () => {
	it('returns null when user cancels', async () => {
		// Arrange
		mockSave.mockResolvedValue(null);

		// Act
		const result = await saveFileAs('content');

		// Assert
		expect(result).toBeNull();
		expect(mockWriteTextFile).not.toHaveBeenCalled();
	});

	it('writes content to chosen path and returns it', async () => {
		// Arrange
		mockSave.mockResolvedValue('/new/path/query.dbsp');
		mockWriteTextFile.mockResolvedValue(undefined);

		// Act
		const result = await saveFileAs('new content', 'query.dbsp');

		// Assert
		expect(result).toBe('/new/path/query.dbsp');
		expect(mockWriteTextFile).toHaveBeenCalledWith(
			'/new/path/query.dbsp',
			'new content',
		);
		expect(mockSave).toHaveBeenCalledWith(
			expect.objectContaining({ defaultPath: 'query.dbsp' }),
		);
	});
});

describe('confirmUnsavedChanges', () => {
	it('returns save when user clicks Yes', async () => {
		// Arrange
		mockAsk.mockResolvedValue(true);

		// Act
		const result = await confirmUnsavedChanges('users.dbsp');

		// Assert
		expect(result).toBe('save');
	});

	it('returns discard when user clicks No', async () => {
		// Arrange
		mockAsk.mockResolvedValue(false);

		// Act
		const result = await confirmUnsavedChanges('users.dbsp');

		// Assert
		expect(result).toBe('discard');
	});

	it('returns cancel when user cancels', async () => {
		// Arrange
		mockAsk.mockResolvedValue(null);

		// Act
		const result = await confirmUnsavedChanges('users.dbsp');

		// Assert
		expect(result).toBe('cancel');
	});

	it('includes filename in dialog message', async () => {
		// Arrange
		mockAsk.mockResolvedValue(true);

		// Act
		await confirmUnsavedChanges('report.sql');

		// Assert
		expect(mockAsk).toHaveBeenCalledWith(
			'Save changes to "report.sql"?',
			expect.objectContaining({ title: 'Unsaved Changes' }),
		);
	});
});
