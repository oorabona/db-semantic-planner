/**
 * E10: Logger Tests
 *
 * Tests for the injectable logger module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	defaultLogger,
	emitWarning,
	getLogger,
	type Logger,
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

	describe('Logger backward-compat (#159)', () => {
		it('a 1-arg custom logger keeps compiling and receives the message unchanged via emitWarning', () => {
			const calls: string[] = [];
			// Logger.warn is (and stays) 1-arg — WarningCategory is internal to
			// emitWarning's suppression decision and is NEVER forwarded to the
			// sink (Hyrum's Law: a `{ warn: console.warn }` or rest-arg/pino
			// wrapper must never see an unexpected extra token).
			const customLogger: Logger = {
				warn: (message: string) => {
					calls.push(message);
				},
			};
			setLogger(customLogger);
			emitWarning('custom warning', 'dx');
			expect(calls).toEqual(['custom warning']);
		});
	});

	describe('emitWarning (#159)', () => {
		const ENV_KEY = 'DBSP_SUPPRESS_DX_WARNINGS';
		let originalEnv: string | undefined;

		beforeEach(() => {
			originalEnv = process.env[ENV_KEY];
			delete process.env[ENV_KEY];
		});

		afterEach(() => {
			if (originalEnv === undefined) {
				delete process.env[ENV_KEY];
			} else {
				process.env[ENV_KEY] = originalEnv;
			}
		});

		it('calls the logger with ONLY the message — the category never reaches the sink (backward-compat)', () => {
			const warnSpy = vi.fn();
			setLogger({ warn: warnSpy });

			emitWarning('dx message', 'dx');
			emitWarning('runtime message', 'runtime');

			// Exact-args match: if the category leaked as a 2nd argument, these
			// would fail (a 2-arg call does not deep-equal a 1-arg expectation).
			expect(warnSpy).toHaveBeenNthCalledWith(1, 'dx message');
			expect(warnSpy).toHaveBeenNthCalledWith(2, 'runtime message');
			expect(warnSpy.mock.calls[0]).toHaveLength(1);
			expect(warnSpy.mock.calls[1]).toHaveLength(1);
		});

		it('emits normally when DBSP_SUPPRESS_DX_WARNINGS is unset (default behavior unchanged)', () => {
			const warnSpy = vi.fn();
			setLogger({ warn: warnSpy });

			emitWarning('dx message', 'dx');

			expect(warnSpy).toHaveBeenCalledWith('dx message');
		});

		it('suppresses "dx" category warnings when DBSP_SUPPRESS_DX_WARNINGS is set', () => {
			const warnSpy = vi.fn();
			setLogger({ warn: warnSpy });
			process.env[ENV_KEY] = '1';

			emitWarning('dx message', 'dx');

			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('does NOT suppress "runtime" category warnings via DBSP_SUPPRESS_DX_WARNINGS', () => {
			const warnSpy = vi.fn();
			setLogger({ warn: warnSpy });
			process.env[ENV_KEY] = '1';

			emitWarning('runtime message', 'runtime');

			expect(warnSpy).toHaveBeenCalledWith('runtime message');
		});

		it('suppresses via per-call options.suppress regardless of env', () => {
			const warnSpy = vi.fn();
			setLogger({ warn: warnSpy });

			emitWarning('dx message', 'dx', { suppress: ['dx'] });

			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('does not suppress a category not listed in options.suppress', () => {
			const warnSpy = vi.fn();
			setLogger({ warn: warnSpy });

			emitWarning('runtime message', 'runtime', { suppress: ['dx'] });

			expect(warnSpy).toHaveBeenCalledWith('runtime message');
		});

		describe('env flag parsing — DBSP_SUPPRESS_DX_WARNINGS (#159 finding 2)', () => {
			it.each([
				'0',
				'false',
				'FALSE',
				'False',
			])('value %j does NOT suppress — the warning still fires', (value) => {
				const warnSpy = vi.fn();
				setLogger({ warn: warnSpy });
				process.env[ENV_KEY] = value;

				emitWarning('dx message', 'dx');

				expect(warnSpy).toHaveBeenCalledWith('dx message');
			});

			it.each(['1', 'true', 'TRUE', 'yes'])('value %j suppresses', (value) => {
				const warnSpy = vi.fn();
				setLogger({ warn: warnSpy });
				process.env[ENV_KEY] = value;

				emitWarning('dx message', 'dx');

				expect(warnSpy).not.toHaveBeenCalled();
			});

			it('empty string does NOT suppress — the warning still fires', () => {
				const warnSpy = vi.fn();
				setLogger({ warn: warnSpy });
				process.env[ENV_KEY] = '';

				emitWarning('dx message', 'dx');

				expect(warnSpy).toHaveBeenCalledWith('dx message');
			});
		});

		describe('return value — the dedup-poisoning fix contract', () => {
			// Callers that dedup (the reserved-word warning) rely on this return
			// value to decide whether to consume their dedup slot. If emitWarning
			// reported "emitted" for a suppressed call, a suppressed access would
			// permanently poison the dedup for every later, non-suppressed caller.
			it('returns true when the warning is actually emitted', () => {
				setLogger({ warn: vi.fn() });
				expect(emitWarning('dx message', 'dx')).toBe(true);
			});

			it('returns false when suppressed via the env gate', () => {
				setLogger({ warn: vi.fn() });
				process.env[ENV_KEY] = '1';
				expect(emitWarning('dx message', 'dx')).toBe(false);
			});

			it('returns false when suppressed via options.suppress', () => {
				setLogger({ warn: vi.fn() });
				expect(emitWarning('dx message', 'dx', { suppress: ['dx'] })).toBe(
					false,
				);
			});

			it('returns false and does not call warn when the global logger is silentLogger', () => {
				setLogger(silentLogger);
				expect(emitWarning('dx message', 'dx')).toBe(false);
			});

			it('returns true for a custom no-op-looking logger that is not the silentLogger singleton', () => {
				// Only the exported silentLogger singleton short-circuits by
				// reference — an equivalent-behaving custom logger does not.
				const customNoop = { warn: vi.fn() };
				setLogger(customNoop);
				expect(emitWarning('dx message', 'dx')).toBe(true);
				expect(customNoop.warn).toHaveBeenCalledWith('dx message');
			});
		});
	});
});
