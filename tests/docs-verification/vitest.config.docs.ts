import { defineConfig } from 'vitest/config';
import {
	doctestMode,
	generatedSuiteDirectory,
} from './generated-suite-path.js';

const mode = doctestMode();
const realDb = mode === 'real-db';

export default defineConfig({
	test: {
		// When running doctests against a real PG, serialize test files because
		// they share the same database and schema-reset between blocks would race
		// across parallel workers. Compile-only runs keep default parallelism.
		// fileParallelism=false is the Vitest 4+ way (poolOptions was removed in v4).
		fileParallelism: !realDb,
		// Deterministic test discovery: only the generated doctest files.
		include: [`${generatedSuiteDirectory(mode)}/*.test.ts`],
	},
});
