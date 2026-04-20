import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		setupFiles: ['vitest.setup.ts'],
		typecheck: {
			enabled: true,
			include: ['src/**/*.test.ts'],
		},
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
		},
	},
});
