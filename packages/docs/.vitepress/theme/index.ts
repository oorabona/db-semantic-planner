import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import './custom.css';
import './landing.css';
import type { App } from 'vue';
import HeroBackground from './HeroBackground.vue';
import Playground from './Playground.vue';
import TerminalDemo from './TerminalDemo.vue';

export default {
	extends: DefaultTheme,
	Layout() {
		return h(DefaultTheme.Layout, null, {
			'home-hero-info-before': () => h(HeroBackground),
		});
	},
	enhanceApp({ app }: { app: App }) {
		app.component('Playground', Playground);
		app.component('TerminalDemo', TerminalDemo);
		app.component('HeroBackground', HeroBackground);
	},
};
