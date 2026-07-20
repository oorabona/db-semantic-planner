import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts', 'src/adapter-sdk.ts', 'src/internal.ts'],
	format: ['esm'],
	dts: true,
	sourcemap: true,
	clean: true,
	target: 'node20',
});
