import DefaultTheme from 'vitepress/theme';
import './design-tokens.css';
import './custom.css';
import './landing.css';
import type { App } from 'vue';
import PlaygroundView from './PlaygroundView.vue';
import TerminalDemo from './TerminalDemo.vue';

export default {
	extends: DefaultTheme,
	enhanceApp({ app }: { app: App }) {
		app.component('Playground', PlaygroundView);
		app.component('TerminalDemo', TerminalDemo);
	},
};
