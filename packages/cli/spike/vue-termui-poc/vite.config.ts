import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { vueTermui } from 'vue-termui/vite';

export default defineConfig({
	plugins: [vue(), vueTermui()],
});
