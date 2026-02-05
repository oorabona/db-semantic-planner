/**
 * E10: Logger Tests
 *
 * Tests for the injectable logger module.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	defaultLogger,
	getLogger,
	resetLogger,
	setLogger,
	silentLogger,
} from './logger.js';

describe('Logger', () => {
	afterEach(() => {
		resetLogger();
	});

	describe('defaultLogger', () => {
		it('should call console.warn', () => {
			const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			defaultLogger.warn('test message');
			expect(spy).toHaveBeenCalledWith('test message');
			spy.mockRestore();
		});
	});

	describe('silentLogger', () => {
		it('should not call console.warn', () => {
			const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
			silentLogger.warn('test message');
			expect(spy).not.toHaveBeenCalled();
			spy.mockRestore();
		});
	});

	describe('getLogger/setLogger', () => {
		it('should return defaultLogger by default', () => {
			expect(getLogger()).toBe(defaultLogger);
		});

		it('should return custom logger after setLogger', () => {
			const customLogger = { warn: vi.fn() };
			setLogger(customLogger);
			expect(getLogger()).toBe(customLogger);
		});

		it('should use custom logger for warnings', () => {
			const customLogger = { warn: vi.fn() };
			setLogger(customLogger);
			getLogger().warn('custom warning');
			expect(customLogger.warn).toHaveBeenCalledWith('custom warning');
		});
	});

	describe('resetLogger', () => {
		it('should reset to defaultLogger', () => {
			const customLogger = { warn: vi.fn() };
			setLogger(customLogger);
			expect(getLogger()).toBe(customLogger);
			resetLogger();
			expect(getLogger()).toBe(defaultLogger);
		});
	});
});
