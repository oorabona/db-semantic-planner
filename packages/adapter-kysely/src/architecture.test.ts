/**
 * Architecture tests to prevent common pitfalls.
 *
 * These tests enforce architectural constraints that prevent bugs like
 * the CompilerState shadowing issue from SPEC-001.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = join(__dirname, '..');

/**
 * Recursively get all TypeScript source files (excluding tests and node_modules)
 */
function getSourceFiles(dir: string, files: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const fullPath = join(dir, entry);
		const stat = statSync(fullPath);

		if (stat.isDirectory()) {
			if (entry !== 'node_modules' && entry !== 'dist') {
				getSourceFiles(fullPath, files);
			}
		} else if (
			entry.endsWith('.ts') &&
			!entry.endsWith('.test.ts') &&
			!entry.endsWith('.d.ts')
		) {
			files.push(fullPath);
		}
	}
	return files;
}

/**
 * Extract interface and type definitions from a file
 */
function extractDefinitions(
	filePath: string,
): { name: string; line: number; kind: 'interface' | 'type' }[] {
	const content = readFileSync(filePath, 'utf-8');
	const lines = content.split('\n');
	const definitions: {
		name: string;
		line: number;
		kind: 'interface' | 'type';
	}[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;

		// Match: export interface Name, interface Name
		const interfaceMatch = line.match(/^(?:export\s+)?interface\s+(\w+)/);
		if (interfaceMatch?.[1]) {
			definitions.push({
				name: interfaceMatch[1],
				line: i + 1,
				kind: 'interface',
			});
		}

		// Match: export type Name =, type Name =
		const typeMatch = line.match(/^(?:export\s+)?type\s+(\w+)\s*[=<]/);
		if (typeMatch?.[1]) {
			definitions.push({ name: typeMatch[1], line: i + 1, kind: 'type' });
		}
	}

	return definitions;
}

describe('Architecture', () => {
	describe('No duplicate interface/type definitions (ARCH-004)', () => {
		it('should not have critical interfaces defined in multiple files', () => {
			// Critical interfaces that MUST have single definitions
			// to prevent shadowing bugs like SPEC-001 CompilerState issue
			const CRITICAL_TYPES = [
				'CompilerState',
				'CompilerContext',
				'WhereHandler',
				'ExpressionHandler',
				'IncludeHandler',
			];

			const srcDir = join(PACKAGE_ROOT, 'src');
			const files = getSourceFiles(srcDir);

			// Build a map of definition name -> locations
			const definitionLocations = new Map<
				string,
				{ file: string; line: number; kind: 'interface' | 'type' }[]
			>();

			for (const file of files) {
				const relPath = relative(srcDir, file);
				const definitions = extractDefinitions(file);

				for (const def of definitions) {
					// Only track critical types
					if (!CRITICAL_TYPES.includes(def.name)) continue;

					const existing = definitionLocations.get(def.name) || [];
					existing.push({ file: relPath, line: def.line, kind: def.kind });
					definitionLocations.set(def.name, existing);
				}
			}

			// Find duplicates (same name in different files)
			const duplicates: string[] = [];

			for (const [name, locations] of definitionLocations) {
				const uniqueFiles = new Set(locations.map((l) => l.file));
				if (uniqueFiles.size > 1) {
					const locationList = locations
						.map((l) => `${l.file}:${l.line} (${l.kind})`)
						.join(', ');
					duplicates.push(`"${name}" defined in: ${locationList}`);
				}
			}

			if (duplicates.length > 0) {
				throw new Error(
					`Found duplicate critical interface/type definitions across files. ` +
						`This can cause shadowing bugs (see SPEC-001 CompilerState issue).\n\n` +
						`Duplicates:\n${duplicates.map((d) => `  - ${d}`).join('\n')}\n\n` +
						`Fix: Use a single definition file (e.g., types.ts) and import from there.`,
				);
			}
		});

		it('should have CompilerState defined only in compiler/types.ts', () => {
			const srcDir = join(PACKAGE_ROOT, 'src');
			const files = getSourceFiles(srcDir);

			const compilerStateLocations: string[] = [];

			for (const file of files) {
				const relPath = relative(srcDir, file);
				const definitions = extractDefinitions(file);

				for (const def of definitions) {
					if (def.name === 'CompilerState') {
						compilerStateLocations.push(`${relPath}:${def.line}`);
					}
				}
			}

			// Should be exactly one location: compiler/types.ts
			expect(compilerStateLocations).toHaveLength(1);
			expect(compilerStateLocations[0]).toMatch(/^compiler\/types\.ts:\d+$/);
		});

		it('should have all critical handler types in compiler/types.ts', () => {
			const srcDir = join(PACKAGE_ROOT, 'src');
			const files = getSourceFiles(srcDir);

			const handlerTypes = [
				'WhereHandler',
				'ExpressionHandler',
				'IncludeHandler',
			];
			const found = new Map<string, string>();

			for (const file of files) {
				const relPath = relative(srcDir, file);
				const definitions = extractDefinitions(file);

				for (const def of definitions) {
					if (handlerTypes.includes(def.name)) {
						found.set(def.name, relPath);
					}
				}
			}

			// All handler types should be in compiler/types.ts
			for (const handlerType of handlerTypes) {
				const location = found.get(handlerType);
				expect(
					location,
					`${handlerType} should be defined in compiler/types.ts`,
				).toBe('compiler/types.ts');
			}
		});
	});
});
