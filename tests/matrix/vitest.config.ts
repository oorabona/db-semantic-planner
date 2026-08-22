import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repositoryRoot = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../..',
);

export default defineConfig({
	root: repositoryRoot,
	test: {
		include: ['tests/matrix/**/*.test.ts'],
		testTimeout: 30000,
	},
});
