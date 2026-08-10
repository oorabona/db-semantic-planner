import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultExclude, defineConfig } from 'vitest/config';

const repositoryRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../..',
);

export default defineConfig({
	resolve: {
		alias: {
			'@dbsp/adapter-pgsql/internal': fileURLToPath(
				new URL(
					'../../packages/adapter-pgsql/src/internal.ts',
					import.meta.url,
				),
			),
		},
	},
	// This config lives in a workspace package solely so tsc checks the E2E
	// sources. Pin Vitest's root to the repository: otherwise its include glob
	// is evaluated from this package and falls back to Vitest's default suite.
	root: repositoryRoot,
	test: {
		include: ['tests/e2e/**/*.test.ts'],
		exclude: [...defaultExclude, 'tests/e2e/benchmarks/**'],
		globalSetup: ['tests/e2e/globalSetup.ts'],
		testTimeout: 60000, // 60s for container startup
		hookTimeout: 120000, // 120s for global setup/teardown
		fileParallelism: false, // Run test files sequentially (share container)
	},
});
