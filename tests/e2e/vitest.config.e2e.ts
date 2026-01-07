import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/e2e/**/*.test.ts'],
		exclude: ['tests/e2e/benchmarks/**'],
		globalSetup: ['tests/e2e/globalSetup.ts'],
		testTimeout: 60000, // 60s for container startup
		hookTimeout: 120000, // 120s for global setup/teardown
		fileParallelism: false, // Run test files sequentially (share container)
	},
});
