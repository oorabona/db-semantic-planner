import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const copyWasm = () => {
	const wasmSrc = resolve('../../node_modules/.pnpm/libpg-query@17.7.3/node_modules/libpg-query/wasm/libpg-query.wasm');
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
	onSuccess: copyWasm,
});
