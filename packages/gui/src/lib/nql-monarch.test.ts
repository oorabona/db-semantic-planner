import { describe, expect, it } from 'vitest';
import {
	NQL_LANGUAGE_ID,
	nqlLanguageConfiguration,
	nqlMonarchTokensProvider,
} from './nql-monarch.js';

describe('NQL Monarch tokenizer', () => {
	it('exports language ID as "nql"', () => {
		expect(NQL_LANGUAGE_ID).toBe('nql');
	});

	it('has case-insensitive mode', () => {
		expect(nqlMonarchTokensProvider.ignoreCase).toBe(true);
	});

	it('includes all core SQL/NQL keywords', () => {
		const kw = nqlMonarchTokensProvider.keywords as string[];
		const required = [
			'select',
			'from',
			'where',
			'limit',
			'offset',
			'order',
			'by',
			'group',
			'having',
			'distinct',
			'join',
			'insert',
			'update',
			'delete',
			'upsert',
			'include',
			'bind',
			'returning',
			'and',
			'or',
			'not',
			'in',
			'between',
			'like',
			'ilike',
			'is',
			'null',
			'true',
			'false',
			'exists',
			'asc',
			'desc',
			'case',
			'when',
			'then',
			'else',
			'end',
			'count',
			'sum',
			'avg',
			'min',
			'max',
		];
		for (const k of required) {
			expect(kw).toContain(k);
		}
	});

	it('includes NQL-specific keywords', () => {
		const kw = nqlMonarchTokensProvider.keywords as string[];
		expect(kw).toContain('with');
		expect(kw).toContain('strategy');
		expect(kw).toContain('flat');
		expect(kw).toContain('json_agg');
		expect(kw).toContain('cte');
	});

	it('includes window function keywords', () => {
		const kw = nqlMonarchTokensProvider.keywords as string[];
		expect(kw).toContain('over');
		expect(kw).toContain('partition');
		expect(kw).toContain('rows');
		expect(kw).toContain('range');
		expect(kw).toContain('unbounded');
		expect(kw).toContain('preceding');
		expect(kw).toContain('following');
	});

	it('includes set operation keywords', () => {
		const kw = nqlMonarchTokensProvider.keywords as string[];
		expect(kw).toContain('union');
		expect(kw).toContain('intersect');
		expect(kw).toContain('except');
		expect(kw).toContain('all');
	});

	it('defines operators', () => {
		const ops = nqlMonarchTokensProvider.operators as string[];
		expect(ops).toContain('=');
		expect(ops).toContain('!=');
		expect(ops).toContain('<>');
		expect(ops).toContain('>=');
		expect(ops).toContain('~');
	});

	it('has tokenizer root with pipe, comment, string, number, identifier rules', () => {
		const tokenizer = nqlMonarchTokensProvider.tokenizer as Record<
			string,
			unknown[]
		>;
		expect(tokenizer.root).toBeDefined();
		expect(tokenizer.root!.length).toBeGreaterThan(5);
		expect(tokenizer.comment).toBeDefined();
		expect(tokenizer.string).toBeDefined();
	});

	it('default token is identifier', () => {
		expect(nqlMonarchTokensProvider.defaultToken).toBe('identifier');
	});
});

describe('NQL language configuration', () => {
	it('supports line and block comments', () => {
		expect(nqlLanguageConfiguration.comments?.lineComment).toBe('//');
		expect(nqlLanguageConfiguration.comments?.blockComment).toEqual([
			'/*',
			'*/',
		]);
	});

	it('defines bracket pairs', () => {
		expect(nqlLanguageConfiguration.brackets).toEqual([
			['(', ')'],
			['[', ']'],
		]);
	});

	it('configures auto-closing pairs', () => {
		const pairs = nqlLanguageConfiguration.autoClosingPairs as Array<{
			open: string;
			close: string;
		}>;
		expect(pairs).toContainEqual({ open: '(', close: ')' });
		expect(pairs).toContainEqual({ open: '[', close: ']' });
	});

	it('configures surrounding pairs', () => {
		const pairs = nqlLanguageConfiguration.surroundingPairs as Array<{
			open: string;
			close: string;
		}>;
		expect(pairs).toContainEqual({ open: '(', close: ')' });
		expect(pairs).toContainEqual({ open: "'", close: "'" });
	});
});
