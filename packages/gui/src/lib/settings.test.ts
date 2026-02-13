import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExists, mockReadTextFile, mockWriteTextFile, mockJoin } =
	vi.hoisted(() => ({
		mockExists: vi.fn(),
		mockReadTextFile: vi.fn(),
		mockWriteTextFile: vi.fn(),
		mockJoin: vi.fn(),
	}));

vi.mock('@tauri-apps/plugin-fs', () => ({
	exists: mockExists,
	readTextFile: mockReadTextFile,
	writeTextFile: mockWriteTextFile,
}));

vi.mock('@tauri-apps/api/path', () => ({
	join: mockJoin,
}));

import {
	type DbspSettings,
	DEFAULT_EDITOR,
	DEFAULT_EXCLUDE,
	DEFAULT_INCLUDE,
	readSettings,
	resolveProjectSettings,
	resolveSchemaPath,
	SCHEMA_SEARCH_PATHS,
	SETTINGS_FILENAME,
	SettingsParseError,
	SettingsValidationError,
	validateSettings,
	writeSettings,
} from './settings';

beforeEach(() => {
	vi.clearAllMocks();
	// Default: join just concatenates with /
	mockJoin.mockImplementation((...parts: string[]) =>
		Promise.resolve(parts.join('/')),
	);
});

// ── Constants ────────────────────────────────────────────────────

describe('constants', () => {
	it('has correct settings filename', () => {
		expect(SETTINGS_FILENAME).toBe('dbsp.settings.json');
	});

	it('has default include globs', () => {
		expect(DEFAULT_INCLUDE).toEqual(['**/*.dbsp', '**/*.assert.dbsp']);
	});

	it('has default exclude globs', () => {
		expect(DEFAULT_EXCLUDE).toEqual(['node_modules', 'dist', '.git']);
	});

	it('has default editor settings', () => {
		expect(DEFAULT_EDITOR).toEqual({
			tabSize: 2,
			formatOnSave: false,
			maxResults: 1000,
		});
	});

	it('has schema search paths in priority order', () => {
		expect(SCHEMA_SEARCH_PATHS).toEqual([
			'src/schema.ts',
			'schema.ts',
			'src/db/schema.ts',
			'db/schema.ts',
		]);
	});
});

// ── validateSettings ─────────────────────────────────────────────

describe('validateSettings', () => {
	describe('when input is valid', () => {
		it('accepts minimal settings (version only)', () => {
			// Arrange
			const raw = { version: 1 };

			// Act
			const result = validateSettings(raw);

			// Assert
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.settings.version).toBe(1);
			}
		});

		it('accepts full settings', () => {
			// Arrange
			const raw: DbspSettings = {
				version: 1,
				connections: [
					{ name: 'dev', profile: 'file://.env.local' },
					{
						name: 'staging',
						profile: 'env://DATABASE_URL',
						defaultSchema: 'public',
						readOnly: true,
					},
				],
				defaultConnection: 'dev',
				project: {
					schemaPath: 'auto',
					include: ['**/*.dbsp'],
					exclude: ['node_modules'],
				},
				editor: {
					tabSize: 4,
					formatOnSave: true,
					maxResults: 500,
				},
			};

			// Act
			const result = validateSettings(raw);

			// Assert
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.settings.connections).toHaveLength(2);
				expect(result.settings.project?.schemaPath).toBe('auto');
			}
		});

		it('accepts store:// profile URI', () => {
			const raw = {
				version: 1,
				connections: [{ name: 'local', profile: 'store://dev-local' }],
			};
			const result = validateSettings(raw);
			expect(result.ok).toBe(true);
		});
	});

	describe('when input is invalid', () => {
		it('rejects non-object input', () => {
			expect(validateSettings(null).ok).toBe(false);
			expect(validateSettings('string').ok).toBe(false);
			expect(validateSettings([]).ok).toBe(false);
			expect(validateSettings(42).ok).toBe(false);
		});

		it('rejects missing version', () => {
			const result = validateSettings({});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors).toContainEqual({
					path: 'version',
					message: 'version must be 1',
				});
			}
		});

		it('rejects wrong version number', () => {
			const result = validateSettings({ version: 2 });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors[0]?.path).toBe('version');
			}
		});

		it('rejects invalid connections array', () => {
			const result = validateSettings({ version: 1, connections: 'not-array' });
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors[0]?.path).toBe('connections');
			}
		});

		it('rejects connection with missing name', () => {
			const result = validateSettings({
				version: 1,
				connections: [{ profile: 'file://.env' }],
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors).toContainEqual(
					expect.objectContaining({ path: 'connections[0].name' }),
				);
			}
		});

		it('rejects connection with invalid profile scheme', () => {
			const result = validateSettings({
				version: 1,
				connections: [{ name: 'bad', profile: 'http://example.com' }],
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors).toContainEqual(
					expect.objectContaining({ path: 'connections[0].profile' }),
				);
			}
		});

		it('rejects invalid editor.tabSize', () => {
			const result = validateSettings({
				version: 1,
				editor: { tabSize: 0 },
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors[0]?.path).toBe('editor.tabSize');
			}
		});

		it('rejects invalid editor.formatOnSave type', () => {
			const result = validateSettings({
				version: 1,
				editor: { formatOnSave: 'yes' },
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors[0]?.path).toBe('editor.formatOnSave');
			}
		});

		it('rejects invalid project.include type', () => {
			const result = validateSettings({
				version: 1,
				project: { include: 'not-array' },
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors[0]?.path).toBe('project.include');
			}
		});

		it('rejects project as non-object', () => {
			const result = validateSettings({ version: 1, project: 'string' });
			expect(result.ok).toBe(false);
		});

		it('rejects editor as non-object', () => {
			const result = validateSettings({ version: 1, editor: [] });
			expect(result.ok).toBe(false);
		});

		it('collects multiple errors at once', () => {
			const result = validateSettings({
				connections: [{ name: '', profile: '' }],
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors.length).toBeGreaterThanOrEqual(3); // version + name + profile
			}
		});
	});
});

// ── readSettings ─────────────────────────────────────────────────

describe('readSettings', () => {
	it('returns null when file does not exist', async () => {
		// Arrange
		mockExists.mockResolvedValue(false);

		// Act
		const result = await readSettings('/project');

		// Assert
		expect(result).toBeNull();
		expect(mockReadTextFile).not.toHaveBeenCalled();
	});

	it('reads and validates a valid settings file', async () => {
		// Arrange
		mockExists.mockResolvedValue(true);
		mockReadTextFile.mockResolvedValue(
			JSON.stringify({ version: 1, defaultConnection: 'dev' }),
		);

		// Act
		const result = await readSettings('/project');

		// Assert
		expect(result).not.toBeNull();
		expect(result?.version).toBe(1);
		expect(result?.defaultConnection).toBe('dev');
	});

	it('throws SettingsParseError for invalid JSON', async () => {
		// Arrange
		mockExists.mockResolvedValue(true);
		mockReadTextFile.mockResolvedValue('{ not valid json');

		// Act & Assert
		await expect(readSettings('/project')).rejects.toThrow(SettingsParseError);
	});

	it('throws SettingsValidationError for invalid settings', async () => {
		// Arrange
		mockExists.mockResolvedValue(true);
		mockReadTextFile.mockResolvedValue(JSON.stringify({ version: 99 }));

		// Act & Assert
		await expect(readSettings('/project')).rejects.toThrow(
			SettingsValidationError,
		);
	});

	it('parse error includes file path', async () => {
		// Arrange
		mockExists.mockResolvedValue(true);
		mockReadTextFile.mockResolvedValue('broken');

		// Act & Assert
		try {
			await readSettings('/my/project');
		} catch (e) {
			expect(e).toBeInstanceOf(SettingsParseError);
			expect((e as SettingsParseError).filePath).toBe(
				'/my/project/dbsp.settings.json',
			);
		}
	});

	it('validation error includes errors array', async () => {
		// Arrange
		mockExists.mockResolvedValue(true);
		mockReadTextFile.mockResolvedValue(JSON.stringify({}));

		// Act & Assert
		try {
			await readSettings('/project');
		} catch (e) {
			expect(e).toBeInstanceOf(SettingsValidationError);
			expect((e as SettingsValidationError).errors.length).toBeGreaterThan(0);
		}
	});
});

// ── writeSettings ────────────────────────────────────────────────

describe('writeSettings', () => {
	it('writes formatted JSON to the correct path', async () => {
		// Arrange
		mockWriteTextFile.mockResolvedValue(undefined);
		const settings: DbspSettings = { version: 1, defaultConnection: 'dev' };

		// Act
		await writeSettings('/project', settings);

		// Assert
		expect(mockWriteTextFile).toHaveBeenCalledWith(
			'/project/dbsp.settings.json',
			`${JSON.stringify(settings, null, 2)}\n`,
		);
	});

	it('propagates write errors', async () => {
		// Arrange
		mockWriteTextFile.mockRejectedValue(new Error('Permission denied'));

		// Act & Assert
		await expect(writeSettings('/readonly', { version: 1 })).rejects.toThrow(
			'Permission denied',
		);
	});
});

// ── resolveSchemaPath ────────────────────────────────────────────

describe('resolveSchemaPath', () => {
	it('returns null when schemaPath is undefined', async () => {
		const result = await resolveSchemaPath('/project', undefined);
		expect(result).toBeNull();
	});

	it('returns explicit path if file exists', async () => {
		// Arrange
		mockExists.mockResolvedValue(true);

		// Act
		const result = await resolveSchemaPath('/project', 'lib/schema.ts');

		// Assert
		expect(result).toBe('lib/schema.ts');
		expect(mockExists).toHaveBeenCalledWith('/project/lib/schema.ts');
	});

	it('returns null for explicit path that does not exist', async () => {
		// Arrange
		mockExists.mockResolvedValue(false);

		// Act
		const result = await resolveSchemaPath('/project', 'lib/schema.ts');

		// Assert
		expect(result).toBeNull();
	});

	it('auto-detects first matching schema path', async () => {
		// Arrange: src/schema.ts does not exist, schema.ts does
		mockExists
			.mockResolvedValueOnce(false) // src/schema.ts
			.mockResolvedValueOnce(true); // schema.ts

		// Act
		const result = await resolveSchemaPath('/project', 'auto');

		// Assert
		expect(result).toBe('schema.ts');
		expect(mockExists).toHaveBeenCalledTimes(2);
	});

	it('returns null when auto-detect finds no schema', async () => {
		// Arrange: all candidates missing
		mockExists.mockResolvedValue(false);

		// Act
		const result = await resolveSchemaPath('/project', 'auto');

		// Assert
		expect(result).toBeNull();
		expect(mockExists).toHaveBeenCalledTimes(4); // all 4 candidates checked
	});

	it('auto-detect checks paths in priority order', async () => {
		// Arrange: all exist — should return first
		mockExists.mockResolvedValue(true);

		// Act
		const result = await resolveSchemaPath('/project', 'auto');

		// Assert
		expect(result).toBe('src/schema.ts');
		expect(mockExists).toHaveBeenCalledTimes(1); // stops at first match
	});
});

// ── resolveProjectSettings (GUI-MW-D04) ─────────────────────────

describe('resolveProjectSettings', () => {
	it('returns all defaults when settings is null', () => {
		const result = resolveProjectSettings(null);

		expect(result.include).toEqual([...DEFAULT_INCLUDE]);
		expect(result.exclude).toEqual([...DEFAULT_EXCLUDE]);
		expect(result.editor).toEqual(DEFAULT_EDITOR);
	});

	it('returns all defaults when settings has no overrides', () => {
		const settings: DbspSettings = { version: 1 };
		const result = resolveProjectSettings(settings);

		expect(result.include).toEqual([...DEFAULT_INCLUDE]);
		expect(result.exclude).toEqual([...DEFAULT_EXCLUDE]);
		expect(result.editor).toEqual(DEFAULT_EDITOR);
	});

	it('project.include fully replaces default include', () => {
		const settings: DbspSettings = {
			version: 1,
			project: { include: ['*.sql'] },
		};
		const result = resolveProjectSettings(settings);

		expect(result.include).toEqual(['*.sql']);
		expect(result.exclude).toEqual([...DEFAULT_EXCLUDE]); // untouched
	});

	it('project.exclude fully replaces default exclude', () => {
		const settings: DbspSettings = {
			version: 1,
			project: { exclude: ['vendor', 'tmp'] },
		};
		const result = resolveProjectSettings(settings);

		expect(result.exclude).toEqual(['vendor', 'tmp']);
		expect(result.include).toEqual([...DEFAULT_INCLUDE]); // untouched
	});

	it('editor settings merge with defaults (partial override)', () => {
		const settings: DbspSettings = {
			version: 1,
			editor: { tabSize: 4 },
		};
		const result = resolveProjectSettings(settings);

		expect(result.editor).toEqual({
			tabSize: 4,
			formatOnSave: false, // from default
			maxResults: 1000, // from default
		});
	});

	it('editor settings fully override when all fields provided', () => {
		const settings: DbspSettings = {
			version: 1,
			editor: { tabSize: 4, formatOnSave: true, maxResults: 500 },
		};
		const result = resolveProjectSettings(settings);

		expect(result.editor).toEqual({
			tabSize: 4,
			formatOnSave: true,
			maxResults: 500,
		});
	});

	it('combines project and editor overrides', () => {
		const settings: DbspSettings = {
			version: 1,
			project: { include: ['*.nql'], exclude: ['build'] },
			editor: { maxResults: 200 },
		};
		const result = resolveProjectSettings(settings);

		expect(result.include).toEqual(['*.nql']);
		expect(result.exclude).toEqual(['build']);
		expect(result.editor).toEqual({
			tabSize: 2,
			formatOnSave: false,
			maxResults: 200,
		});
	});
});
