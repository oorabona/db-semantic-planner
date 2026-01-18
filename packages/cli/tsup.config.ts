import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts', 'src/generators/schema-codegen.ts'],
	format: ['esm'],
	dts: true,
	sourcemap: true,
	clean: true,
	target: 'node20',
	// Note: shebang is already in src/index.ts, no banner needed
});
