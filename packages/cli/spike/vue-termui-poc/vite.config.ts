import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { vueTermui } from 'vue-termui/vite';

export default defineConfig({
	plugins: [vue(), vueTermui()],
});
