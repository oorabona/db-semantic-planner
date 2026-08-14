import { defineConfig } from 'tsup';

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		internal: 'src/internal.ts',
	},
	format: ['esm'],
	dts: true,
	sourcemap: true,
	clean: true,
	// Ledger admission must use its captured deparse fixture from the published
	// package too.  Without this copy, workspace consumers load dist/internal.js
	// and classify every real server major as unsupported despite the fixture
	// existing in src.
	publicDir: 'src/transition/ledger-deparse-fixtures',
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
