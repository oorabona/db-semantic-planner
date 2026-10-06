import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'@dbsp/adapter-pgsql/internal': fileURLToPath(
				new URL('./src/internal.ts', import.meta.url),
			),
		},
	},
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
