import path from 'node:path';
import { fileURLToPath } from 'node:url';
import robotsTxt from 'vite-plugin-robots-txt';
import { defineConfig } from 'vitepress';
import llmstxt from 'vitepress-plugin-llms';
import { withMermaid } from 'vitepress-plugin-mermaid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Site URL + base are provided by the deploy workflow via GitHub repo
// variables (vars.SITE_URL, vars.SITE_BASE). No fallback — if these are
// unset the build MUST fail so mis-configured CI is caught immediately
// instead of publishing with broken sitemaps and OG images.
function requireEnv(key: string): string {
	const value = process.env[key];
	if (!value) {
		throw new Error(
			`${key} environment variable is required. Set vars.${key} on the GitHub repository (Settings → Secrets and variables → Actions → Variables).`,
		);
	}
	return value;
}

const SITE_URL = requireEnv('SITE_URL').replace(/\/$/, '');
const SITE_BASE = requireEnv('SITE_BASE');
const OG_IMAGE = `${SITE_URL}${SITE_BASE}og-image.png`.replace(
	/([^:])\/+/g,
	'$1/',
);

export default withMermaid(
	defineConfig({
		title: 'db-semantic-planner',
		description: 'The intent-first query planner for PostgreSQL',
		lastUpdated: true,
		base: SITE_BASE,
		sitemap: {
			hostname: SITE_URL,
		},
		head: [
			[
				'link',
				{ rel: 'icon', type: 'image/svg+xml', href: `${SITE_BASE}logo.svg` },
			],
			['meta', { name: 'og:type', content: 'website' }],
			[
				'meta',
				{
					name: 'og:title',
					content: 'db-semantic-planner — The intent-first query planner',
				},
			],
			[
				'meta',
				{
					name: 'og:description',
					content:
						'Declare what you want. The planner decides how. Then shows you why. Type-safe, observable, PostgreSQL-native.',
				},
			],
			['meta', { name: 'og:image', content: OG_IMAGE }],
			['meta', { name: 'twitter:card', content: 'summary_large_image' }],
			['meta', { name: 'twitter:title', content: 'db-semantic-planner' }],
			[
				'meta',
				{
					name: 'twitter:description',
					content: 'The intent-first query planner for PostgreSQL',
				},
			],
		],
		themeConfig: {
			logo: '/logo.svg',
			nav: [
				{ text: 'Guide', link: '/guide/getting-started' },
				{ text: 'Demo', link: '/demo' },
				{ text: 'API', link: '/api/' },
				{ text: 'Patterns', link: '/patterns' },
				{ text: 'NQL', link: '/nql/' },
				{ text: 'Comparison', link: '/comparison' },
				{ text: 'Playground', link: '/playground' },
				{ text: 'Roadmap', link: '/roadmap' },
			],
			sidebar: {
				'/guide/': [
					{
						text: 'Introduction',
						items: [
							{ text: 'Getting Started', link: '/guide/getting-started' },
							{ text: 'Why dbsp?', link: '/guide/why-dbsp' },
						],
					},
					{
						text: 'Core Concepts',
						items: [
							{ text: 'Schema Definition', link: '/guide/schema' },
							{ text: 'Queries', link: '/guide/queries' },
							{ text: 'Relations & Includes', link: '/guide/includes' },
							{ text: 'Result Hydration', link: '/guide/result-hydration' },
							{ text: 'Mutations', link: '/guide/mutations' },
							{ text: 'Observability', link: '/guide/observability' },
						],
					},
					{
						text: 'Advanced',
						items: [
							{
								text: 'Expression Primitives',
								link: '/guide/expression-primitives',
							},
							{
								text: 'exists() vs rawExists()',
								link: '/guide/exists-vs-rawexists',
							},
							{ text: 'Joins', link: '/guide/joins' },
							{ text: 'Recursive CTEs', link: '/guide/recursive-cte' },
							{ text: 'Case Expressions', link: '/guide/case-expressions' },
							{ text: 'Batch Values', link: '/guide/batch-values' },
							{ text: 'Full-Text Search', link: '/guide/full-text-search' },
							{ text: 'Range Operators', link: '/guide/range-operators' },
							{
								text: 'Extensions (pgvector, ParadeDB)',
								link: '/guide/extensions',
							},
						],
					},
					{
						text: 'Operations',
						items: [
							{ text: 'DDL Helpers', link: '/guide/ddl-helpers' },
							{ text: 'DDL Provisioning', link: '/guide/ddl-provisioning' },
							{ text: 'Schema Versioning', link: '/guide/schema-versioning' },
							{ text: 'RLS Policies', link: '/guide/rls-policies' },
							{ text: 'Multi-tenant', link: '/guide/multi-tenant' },
							{ text: 'Production', link: '/guide/production' },
							{ text: 'CLI Usage', link: '/guide/cli-usage' },
						],
					},
					{
						text: 'Migration',
						items: [
							{ text: 'From Prisma', link: '/guide/migrating-from-prisma' },
							{ text: 'From Drizzle', link: '/guide/migrating-from-drizzle' },
							{ text: 'From Kysely', link: '/guide/migrating-from-kysely' },
						],
					},
				],
				'/api/': [
					{
						text: 'API',
						items: [
							{ text: 'Overview', link: '/api/' },
							{ text: 'ORM API Reference', link: '/api/orm-api' },
						],
					},
				],
				'/nql/': [
					{
						text: 'NQL',
						items: [{ text: 'Reference', link: '/nql/' }],
					},
				],
			},
			socialLinks: [
				{
					icon: 'github',
					link: 'https://github.com/oorabona/db-semantic-planner',
				},
			],
			search: {
				provider: 'local',
			},
			footer: {
				message: 'Released under the MIT License.',
				copyright: 'v1.0.0 — Adapter-agnostic core, PostgreSQL-native today.',
			},
		},
		vite: {
			plugins: [
				...llmstxt({ domain: SITE_URL }),
				robotsTxt({
					policy: [{ userAgent: '*', allow: '/' }],
					sitemap: `${SITE_URL}${SITE_BASE}sitemap.xml`.replace(
						/([^:])\/+/g,
						'$1/',
					),
				}),
			],
			resolve: {
				alias: {
					pg: path.resolve(__dirname, 'theme/pg-stub.ts'),
				},
			},
			optimizeDeps: {
				exclude: ['pg'],
				include: [
					'mermaid',
					'dayjs',
					'dayjs/plugin/duration',
					'dayjs/plugin/isoWeek',
					'dayjs/plugin/customParseFormat',
					'dayjs/plugin/localizedFormat',
				],
			},
		},
	}),
);
