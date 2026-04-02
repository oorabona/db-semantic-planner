import DefaultTheme from 'vitepress/theme';
import './custom.css';
import './landing.css';
import type { App } from 'vue';
import Playground from './Playground.vue';
import TerminalDemo from './TerminalDemo.vue';

export default {
	extends: DefaultTheme,
	enhanceApp({ app }: { app: App }) {
		app.component('Playground', Playground);
		app.component('TerminalDemo', TerminalDemo);
	},
};
