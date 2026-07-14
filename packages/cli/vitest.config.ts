import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'@dbsp/adapter-pgsql': fileURLToPath(
				new URL('../adapter-pgsql/src/index.ts', import.meta.url),
			),
		},
	},
	test: {
		include: ['src/**/*.test.ts'],
		globals: true,
	},
});
