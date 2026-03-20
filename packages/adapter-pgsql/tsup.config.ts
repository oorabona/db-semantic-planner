import { defineConfig } from 'tsup';

export default defineConfig({
	entry: {
		index: 'src/index.ts',
	},
	format: ['esm'],
	dts: true,
	sourcemap: true,
	clean: true,
	target: 'node20',
	external: [
		'fs',
		'path',
		'os',
		'crypto',
		'stream',
		'url',
		'util',
		'pg',
		'pg-pool',
		'pg-cursor',
	],
});
