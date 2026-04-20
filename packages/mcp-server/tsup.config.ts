import { defineConfig } from 'tsup';

export default defineConfig({
	entry: { index: 'src/index.ts', api: 'src/api.ts' },
	format: ['esm'],
	dts: true,
	sourcemap: true,
	clean: true,
	target: 'node20',
	// Note: shebang is added in src/index.ts
});
