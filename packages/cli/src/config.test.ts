/**
 * Unit tests for CLI Configuration Module
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidTableOption, TABLE_OPTIONS } from './config.js';

// Mock the fs and os modules
// os.homedir must return a value immediately since ConfigManager is a singleton
vi.mock('node:fs');
vi.mock('node:os', () => ({
	homedir: vi.fn(() => '/mock/home'),
}));

describe('config', () => {
	const mockHomedir = '/mock/home';
	const defaultConfigPath = path.join(mockHomedir, '.dbsp', 'config.json');

	beforeEach(() => {
		vi.resetModules();
		vi.mocked(fs.existsSync).mockReturnValue(false);
		vi.mocked(fs.readFileSync).mockReturnValue('{}');
		vi.mocked(fs.writeFileSync).mockImplementation(() => {});
		vi.mocked(fs.mkdirSync).mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('isValidTableOption', () => {
		it('should validate borderStyle options', () => {
			expect(isValidTableOption('borderStyle', 'all')).toBe(true);
			expect(isValidTableOption('borderStyle', 'outline')).toBe(true);
			expect(isValidTableOption('borderStyle', 'headers-only')).toBe(true);
			expect(isValidTableOption('borderStyle', 'vertical')).toBe(true);
			expect(isValidTableOption('borderStyle', 'horizontal')).toBe(true);
			expect(isValidTableOption('borderStyle', 'none')).toBe(true);
			expect(isValidTableOption('borderStyle', 'invalid')).toBe(false);
		});

		it('should validate overflow options', () => {
			expect(isValidTableOption('overflow', 'wrap')).toBe(true);
			expect(isValidTableOption('overflow', 'truncate')).toBe(true);
			expect(isValidTableOption('overflow', 'truncate-middle')).toBe(true);
			expect(isValidTableOption('overflow', 'truncate-start')).toBe(true);
			expect(isValidTableOption('overflow', 'truncate-end')).toBe(true);
			expect(isValidTableOption('overflow', 'invalid')).toBe(false);
		});

		it('should validate headerFormatter options', () => {
			expect(isValidTableOption('headerFormatter', 'capitalCase')).toBe(true);
			expect(isValidTableOption('headerFormatter', 'none')).toBe(true);
			expect(isValidTableOption('headerFormatter', 'snakeCase')).toBe(true);
			expect(isValidTableOption('headerFormatter', 'camelCase')).toBe(true);
			expect(isValidTableOption('headerFormatter', 'invalid')).toBe(false);
		});

		it('should validate padding options', () => {
			expect(isValidTableOption('padding', 0)).toBe(true);
			expect(isValidTableOption('padding', 1)).toBe(true);
			expect(isValidTableOption('padding', 2)).toBe(true);
			expect(isValidTableOption('padding', 3)).toBe(true);
			expect(isValidTableOption('padding', 4)).toBe(true);
			expect(isValidTableOption('padding', 5)).toBe(false);
			expect(isValidTableOption('padding', -1)).toBe(false);
		});
	});

	describe('TABLE_OPTIONS', () => {
		it('should have all borderStyle options', () => {
			expect(TABLE_OPTIONS.borderStyle).toEqual([
				'all',
				'outline',
				'headers-only',
				'vertical',
				'horizontal',
				'none',
			]);
		});

		it('should have all overflow options', () => {
			expect(TABLE_OPTIONS.overflow).toEqual([
				'wrap',
				'truncate',
				'truncate-middle',
				'truncate-start',
				'truncate-end',
			]);
		});

		it('should have all headerFormatter options', () => {
			expect(TABLE_OPTIONS.headerFormatter).toEqual([
				'capitalCase',
				'none',
				'snakeCase',
				'camelCase',
			]);
		});

		it('should have all padding options', () => {
			expect(TABLE_OPTIONS.padding).toEqual([0, 1, 2, 3, 4]);
		});
	});

	describe('ConfigManager', () => {
		it('should use default config path', async () => {
			const { config } = await import('./config.js');
			expect(config.getConfigPath()).toBe(defaultConfigPath);
		});

		it('should allow setting custom config path', async () => {
			const { config } = await import('./config.js');
			const customPath = '/custom/config.json';
			config.setConfigPath(customPath);
			expect(config.getConfigPath()).toBe(customPath);
		});

		it('should return default table config when no file exists', async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			const { config } = await import('./config.js');
			const tableConfig = config.getTable();

			expect(tableConfig.borderStyle).toBe('all');
			expect(tableConfig.overflow).toBe('wrap');
			expect(tableConfig.headerFormatter).toBe('capitalCase');
			expect(tableConfig.padding).toBe(1);
		});

		it('should load config from file when it exists', async () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(
				JSON.stringify({
					table: {
						borderStyle: 'none',
						overflow: 'truncate',
					},
				}),
			);

			const { config } = await import('./config.js');
			config.load();
			const tableConfig = config.getTable();

			expect(tableConfig.borderStyle).toBe('none');
			expect(tableConfig.overflow).toBe('truncate');
			// Defaults for missing values
			expect(tableConfig.headerFormatter).toBe('capitalCase');
			expect(tableConfig.padding).toBe(1);
		});

		it('should use defaults when config file is invalid JSON', async () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue('invalid json');

			const { config } = await import('./config.js');
			config.load();
			const tableConfig = config.getTable();

			expect(tableConfig.borderStyle).toBe('all');
			expect(tableConfig.overflow).toBe('wrap');
		});

		it('should save config to file', async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			const { config } = await import('./config.js');

			config.updateTable({ borderStyle: 'outline' });

			expect(fs.mkdirSync).toHaveBeenCalledWith(
				path.join(mockHomedir, '.dbsp'),
				{ recursive: true },
			);
			expect(fs.writeFileSync).toHaveBeenCalled();
		});

		it('should reset table config to defaults', async () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(
				JSON.stringify({
					table: { borderStyle: 'none', padding: 4 },
				}),
			);

			const { config } = await import('./config.js');
			config.load();
			config.resetTable();
			const tableConfig = config.getTable();

			expect(tableConfig.borderStyle).toBe('all');
			expect(tableConfig.padding).toBe(1);
		});
	});
});
