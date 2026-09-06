import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type DoctestMode = 'compile-only' | 'real-db';

type PathApi = {
	isAbsolute(path: string): boolean;
	relative(from: string, to: string): string;
	sep: string;
};

export function doctestMode(): DoctestMode {
	return process.env.DBSP_DOCTEST_REAL_DB === '1' ? 'real-db' : 'compile-only';
}

/** The root-relative directory for suites generated in one execution mode. */
export function generatedSuiteDirectory(mode: DoctestMode): string {
	return `${generatedSuitesRootDirectory()}/${mode}`;
}

/** The root-relative directory containing generated suites and runner scratch files. */
export function generatedSuitesRootDirectory(): string {
	return 'tests/docs-verification/__generated__';
}

/**
 * Resolves and creates a generated directory only when every existing path
 * component below the workspace root is a real directory that we own.
 *
 * The generator rejects an already-invalid generated-path layout before mutation. It does not
 * protect against a concurrent process that can rename or replace a validated path component or
 * entry between validation and any subsequent path-based `mkdir`, write, rename, temporary cleanup,
 * or unlink operation.
 */
export function ensureOwnedGeneratedDirectory(
	workspaceRoot: string,
	relativeDirectory: string,
): string {
	const ownedRoot = realpathSync(resolve(workspaceRoot));
	const directory = resolve(ownedRoot, relativeDirectory);
	if (isAbsolute(relativeDirectory)) {
		throw new Error(
			`Generated directory resolves outside the owned workspace root: ${directory}`,
		);
	}
	assertContainedDirectory(ownedRoot, directory);
	if (!lstatSync(ownedRoot).isDirectory()) {
		throw new Error(`Owned workspace root must be a directory: ${ownedRoot}`);
	}
	const components = relativeDirectory.split(/[\\/]/);
	assertExistingDirectoryComponents(ownedRoot, components);

	mkdirSync(directory, { recursive: true });
	assertExistingDirectoryComponents(ownedRoot, components);

	const resolvedDirectory = realpathSync(directory);
	assertContainedDirectory(ownedRoot, resolvedDirectory);
	return resolvedDirectory;
}

function assertContainedDirectory(ownedRoot: string, directory: string): void {
	const relativeDirectoryPath = relative(ownedRoot, directory);
	if (
		relativeDirectoryPath === '..' ||
		relativeDirectoryPath.startsWith(`..${sep}`) ||
		isAbsolute(relativeDirectoryPath)
	) {
		throw new Error(
			`Generated directory resolves outside the owned workspace root: ${directory}`,
		);
	}
}

function assertExistingDirectoryComponents(
	ownedRoot: string,
	components: readonly string[],
): void {
	let current = ownedRoot;
	for (const component of components) {
		current = join(current, component);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw error;
		}
		if (stat.isSymbolicLink()) {
			throw new Error(
				`Generated directory component must not be a symbolic link: ${current}`,
			);
		}
		if (!stat.isDirectory()) {
			throw new Error(
				`Generated directory component must be a directory: ${current}`,
			);
		}
	}
}

/**
 * Emits an ESM-relative specifier from a generated suite to one of its support
 * modules, regardless of the suite's generated directory depth.
 */
export function relativeModuleSpecifier(
	from: string,
	to: string,
	pathApi: PathApi = { isAbsolute, relative, sep },
): string {
	const relativePath = pathApi.relative(from, to);
	if (pathApi.isAbsolute(relativePath)) {
		throw new Error(
			`Cannot create a relative module specifier from ${from} to ${to}: paths must share a volume.`,
		);
	}
	const value = relativePath.replaceAll(pathApi.sep, '/');
	return /^\.\.?(?:\/|$)/.test(value) ? value : `./${value}`;
}
