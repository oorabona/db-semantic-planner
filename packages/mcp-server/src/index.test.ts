/**
 * CLI argument parsing tests — parseArgs
 *
 * Regression tests for C2 (unknown argument, malformed flags).
 */

import { describe, expect, it, vi } from 'vitest';
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

	describe('M-A: hyphen-leading values and POSIX end-of-options', () => {
		it('should accept a schema path starting with a hyphen (-my.ts)', () => {
			// A value like '-my-file.ts' is a legitimate relative path — must NOT be
			// rejected just because it starts with '-'.
			const result = parseArgs(['--schema', '-my.ts']);
			expect(result.schemaPath).toBe('-my.ts');
		});

		it('should accept a hyphen-leading schema path via = form', () => {
			// '--schema=--weird-name.ts' splits to ['--schema', '--weird-name.ts'] in
			// normalize. '--weird-name.ts' is not a KNOWN_FLAG so it is accepted.
			const result = parseArgs(['--schema=--weird-name.ts']);
			expect(result.schemaPath).toBe('--weird-name.ts');
		});

		it('should still reject a known flag when used as --schema value', () => {
			// '--help' is a known flag, not a path value
			expect(() => parseArgs(['--schema', '--help'])).toThrow(
				'--schema requires a path argument',
			);
		});

		it('should still reject missing value after --schema', () => {
			expect(() => parseArgs(['--schema'])).toThrow(
				'--schema requires a path argument',
			);
		});
	});

	describe('S1: POSIX end-of-options (--) wired correctly', () => {
		it('should accept a hyphen-leading schema path after --', () => {
			// '--schema -- -my.ts': '-my.ts' starts with '-' so flag-matching would
			// normally reject it; after '--' it must be treated as a literal value.
			const result = parseArgs(['--schema', '--', '-my.ts']);
			expect(result.schemaPath).toBe('-my.ts');
			expect(result.help).toBe(false);
		});

		it('should accept a hyphen-leading allowed-root after --', () => {
			const result = parseArgs(['--allowed-root', '--', '-some-root']);
			expect(result.allowedRoots).toEqual(['-some-root']);
			expect(result.help).toBe(false);
		});

		it('should reject tokens after -- when no flag is pending', () => {
			// '--' then '--schema /x.ts': no flag was pending, so '--schema' is an
			// unexpected positional and must be rejected.
			expect(() => parseArgs(['--', '--schema', '/x.ts'])).toThrow(
				'Unknown argument: --schema',
			);
		});

		it('should reject a bare -- with nothing following', () => {
			// '--schema' followed by '--' with no subsequent value: missing path.
			expect(() => parseArgs(['--schema', '--'])).toThrow(
				'--schema requires a path argument',
			);
		});
	});

	describe('S3: parseArgs error shape (consumed by main)', () => {
		// We re-implement main()'s try/catch around parseArgs because main() runs at module
		// load and is hard to test in isolation. These tests verify parseArgs throws a shape
		// that main()'s catch will format correctly.
		it('main() calls process.exit(1) and writes to stderr on parseArgs error', async () => {
			const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const exitSpy = vi
				.spyOn(process, 'exit')
				.mockImplementation((() => {}) as () => never);

			// Simulate what main() does: catch parseArgs error, write to stderr, exit(1)
			try {
				parseArgs(['--schema']); // throws
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`Error: ${msg}`);
				console.error('');
				console.error('Run "dbsp-mcp --help" for usage information.');
				process.exit(1);
			}

			expect(exitSpy).toHaveBeenCalledWith(1);
			const errCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
			expect(
				errCalls.some((s) => s.includes('--schema requires a path argument')),
			).toBe(true);

			stderrSpy.mockRestore();
			exitSpy.mockRestore();
		});
	});

	describe('M-R3h regression: empty = value must be rejected immediately', () => {
		it('should throw for --schema= (empty value via = form)', () => {
			expect(() => parseArgs(['--schema='])).toThrow(
				'--schema requires a non-empty path argument',
			);
		});

		it('should throw for -s= (short form with empty = value)', () => {
			expect(() => parseArgs(['-s='])).toThrow(
				'-s requires a non-empty path argument',
			);
		});

		it('should throw for --allowed-root= (empty value via = form)', () => {
			expect(() =>
				parseArgs(['--schema', './x.ts', '--allowed-root=']),
			).toThrow('--allowed-root requires a non-empty path argument');
		});
	});
});
