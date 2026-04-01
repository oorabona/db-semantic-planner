import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;
export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
		},
	},
	// Tauri dev server config
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		...(host ? { hmr: { protocol: 'ws', host, port: 1421 } } : {}),
		watch: {
			ignored: ['**/src-tauri/**'],
		},
	},
});
