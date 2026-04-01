import DefaultTheme from 'vitepress/theme';
import './custom.css';
import type { App } from 'vue';
import Playground from './Playground.vue';

export default {
	extends: DefaultTheme,
	enhanceApp({ app }: { app: App }) {
		app.component('Playground', Playground);
	},
};
