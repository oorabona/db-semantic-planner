import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'happy-dom',
		include: ['.vitepress/theme/**/*.test.ts'],
		// Fast-skip docs site E2E (none here, but explicit).
		exclude: ['node_modules', 'dist'],
	},
});
