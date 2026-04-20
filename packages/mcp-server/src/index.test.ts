/**
 * CLI argument parsing tests — parseArgs
 *
 * Regression tests for C2 (unknown argument, malformed flags).
 */

import { describe, expect, it } from 'vitest';
import { parseArgs } from './index.js';

describe('parseArgs', () => {
	describe('valid arguments', () => {
		it('should parse --schema flag', () => {
			const result = parseArgs(['--schema', './my.schema.ts']);
			expect(result.schemaPath).toBe('./my.schema.ts');
			expect(result.help).toBe(false);
		});

		it('should parse -s shorthand', () => {
			const result = parseArgs(['-s', './my.schema.ts']);
			expect(result.schemaPath).toBe('./my.schema.ts');
		});

		it('should parse --schema=value form', () => {
			const result = parseArgs(['--schema=./my.schema.ts']);
			expect(result.schemaPath).toBe('./my.schema.ts');
		});

		it('should parse --help flag', () => {
			const result = parseArgs(['--help']);
			expect(result.help).toBe(true);
		});

		it('should parse -h shorthand', () => {
			const result = parseArgs(['-h']);
			expect(result.help).toBe(true);
		});

		it('should parse --allowed-root flag', () => {
			const result = parseArgs([
				'--schema',
				'./s.ts',
				'--allowed-root',
				'/safe',
			]);
			expect(result.allowedRoots).toEqual(['/safe']);
		});

		it('should accumulate multiple --allowed-root flags', () => {
			const result = parseArgs([
				'--schema',
				'./s.ts',
				'--allowed-root',
				'/safe',
				'--allowed-root',
				'/also-safe',
			]);
			expect(result.allowedRoots).toEqual(['/safe', '/also-safe']);
		});
	});

	describe('C2 regression: unknown flag rejection', () => {
		it('should throw for an unknown flag', () => {
			expect(() => parseArgs(['--shema', './x.ts'])).toThrow(
				'Unknown argument: --shema',
			);
		});

		it('should throw for any unrecognised flag', () => {
			expect(() => parseArgs(['--verbose'])).toThrow(
				'Unknown argument: --verbose',
			);
		});

		it('should throw for a positional argument that looks like a flag', () => {
			expect(() => parseArgs(['--unknown-flag'])).toThrow('Unknown argument');
		});

		it('should throw when --schema has no value', () => {
			expect(() => parseArgs(['--schema'])).toThrow(
				'--schema requires a path argument',
			);
		});

		it('should throw when --allowed-root has no value', () => {
			expect(() => parseArgs(['--schema', './s.ts', '--allowed-root'])).toThrow(
				'--allowed-root requires a path argument',
			);
		});
	});
});
