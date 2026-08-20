import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultExclude, defineConfig } from 'vitest/config';

const repositoryRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../..',
);

export default defineConfig({
	// Pin Vitest's discovery root when this config is loaded from another working directory.
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
