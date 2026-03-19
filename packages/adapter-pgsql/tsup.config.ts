import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

const copyWasm = async () => {
	const wasmSrc = resolve(
		'../../node_modules/.pnpm/libpg-query@17.7.3/node_modules/libpg-query/wasm/libpg-query.wasm',
	);
	const wasmDest = resolve('dist/libpg-query.wasm');
	mkdirSync('dist', { recursive: true });
	copyFileSync(wasmSrc, wasmDest);
	console.log(`✅ Copied WASM: \${wasmSrc} → \${wasmDest}`);
};

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
		'libpg-query',
		'pgsql-deparser',
		'pgsql-parser',
		'pg',
		'pg-pool',
		'pg-cursor',
	],
	onSuccess: copyWasm,
});
