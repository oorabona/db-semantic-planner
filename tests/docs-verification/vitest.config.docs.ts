import { defineConfig } from 'vitest/config';

const realDb = process.env.DBSP_DOCTEST_REAL_DB === '1';

export default defineConfig({
	test: {
		// When running doctests against a real PG, serialize test files because
		// they share the same database and schema-reset between blocks would race
		// across parallel workers. Compile-only runs keep default parallelism.
		// fileParallelism=false is the Vitest 4+ way (poolOptions was removed in v4).
		fileParallelism: !realDb,
		// Deterministic test discovery: only the generated doctest files.
		include: ['tests/docs-verification/__generated__/**/*.test.ts'],
	},
});
