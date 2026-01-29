/**
 * NamingPlugin tests
 *
 * Tests for identifier transformation between model and database naming conventions.
 */
import { describe, expect, it } from 'vitest';

import {
	CamelCaseNamingPlugin,
	camelCaseNaming,
	getNamingPlugin,
	IdentityNamingPlugin,
	identityNaming,
} from '../naming-plugin.js';

describe('IdentityNamingPlugin', () => {
	const plugin = new IdentityNamingPlugin();

	it('returns identifier unchanged for toDatabase', () => {
		expect(plugin.toDatabase('createdAt')).toBe('createdAt');
		expect(plugin.toDatabase('created_at')).toBe('created_at');
		expect(plugin.toDatabase('ID')).toBe('ID');
	});

	it('returns identifier unchanged for toModel', () => {
		expect(plugin.toModel('createdAt')).toBe('createdAt');
		expect(plugin.toModel('created_at')).toBe('created_at');
		expect(plugin.toModel('ID')).toBe('ID');
	});
});

describe('CamelCaseNamingPlugin', () => {
	const plugin = new CamelCaseNamingPlugin();

	describe('toDatabase (camelCase → snake_case)', () => {
		it('converts simple camelCase', () => {
			expect(plugin.toDatabase('createdAt')).toBe('created_at');
			expect(plugin.toDatabase('firstName')).toBe('first_name');
			expect(plugin.toDatabase('lastName')).toBe('last_name');
		});

		it('converts multiple words', () => {
			expect(plugin.toDatabase('userProfileImage')).toBe('user_profile_image');
			expect(plugin.toDatabase('orderLineItems')).toBe('order_line_items');
		});

		it('handles consecutive uppercase (acronyms)', () => {
			expect(plugin.toDatabase('parseJSON')).toBe('parse_json');
			expect(plugin.toDatabase('loadHTMLDocument')).toBe('load_html_document');
			expect(plugin.toDatabase('getAPIKey')).toBe('get_api_key');
		});

		it('handles numbers', () => {
			expect(plugin.toDatabase('field1')).toBe('field1');
			expect(plugin.toDatabase('field1Name')).toBe('field1_name');
			expect(plugin.toDatabase('address2Line')).toBe('address2_line');
		});

		it('preserves leading underscores', () => {
			expect(plugin.toDatabase('_privateField')).toBe('_private_field');
			expect(plugin.toDatabase('__doublePrivate')).toBe('__double_private');
		});

		it('handles already snake_case', () => {
			expect(plugin.toDatabase('already_snake')).toBe('already_snake');
			expect(plugin.toDatabase('no_change')).toBe('no_change');
		});

		it('handles single words', () => {
			expect(plugin.toDatabase('id')).toBe('id');
			expect(plugin.toDatabase('name')).toBe('name');
			expect(plugin.toDatabase('ID')).toBe('id');
		});

		it('handles empty string', () => {
			expect(plugin.toDatabase('')).toBe('');
		});

		it('handles single underscore', () => {
			expect(plugin.toDatabase('_')).toBe('_');
		});
	});

	describe('toModel (snake_case → camelCase)', () => {
		it('converts simple snake_case', () => {
			expect(plugin.toModel('created_at')).toBe('createdAt');
			expect(plugin.toModel('first_name')).toBe('firstName');
			expect(plugin.toModel('last_name')).toBe('lastName');
		});

		it('converts multiple words', () => {
			expect(plugin.toModel('user_profile_image')).toBe('userProfileImage');
			expect(plugin.toModel('order_line_items')).toBe('orderLineItems');
		});

		it('handles numbers', () => {
			expect(plugin.toModel('field_1')).toBe('field1');
			expect(plugin.toModel('address_2_line')).toBe('address2Line');
		});

		it('preserves leading underscores', () => {
			expect(plugin.toModel('_private_field')).toBe('_privateField');
			expect(plugin.toModel('__double_private')).toBe('__doublePrivate');
		});

		it('handles already camelCase', () => {
			expect(plugin.toModel('alreadyCamel')).toBe('alreadyCamel');
		});

		it('handles single words', () => {
			expect(plugin.toModel('id')).toBe('id');
			expect(plugin.toModel('name')).toBe('name');
		});

		it('handles empty string', () => {
			expect(plugin.toModel('')).toBe('');
		});
	});

	describe('roundtrip consistency', () => {
		it('camelCase → snake_case → camelCase preserves original', () => {
			const testCases = [
				'createdAt',
				'firstName',
				'userProfileImage',
				'orderLineItems',
			];

			for (const original of testCases) {
				const snake = plugin.toDatabase(original);
				const backToCamel = plugin.toModel(snake);
				expect(backToCamel).toBe(original);
			}
		});

		it('snake_case → camelCase → snake_case preserves original', () => {
			const testCases = [
				'created_at',
				'first_name',
				'user_profile_image',
				'order_line_items',
			];

			for (const original of testCases) {
				const camel = plugin.toModel(original);
				const backToSnake = plugin.toDatabase(camel);
				expect(backToSnake).toBe(original);
			}
		});
	});
});

describe('getNamingPlugin', () => {
	it('returns identity plugin', () => {
		const plugin = getNamingPlugin('identity');
		expect(plugin).toBe(identityNaming);
		expect(plugin.toDatabase('createdAt')).toBe('createdAt');
	});

	it('returns camelCase plugin', () => {
		const plugin = getNamingPlugin('camelCase');
		expect(plugin).toBe(camelCaseNaming);
		expect(plugin.toDatabase('createdAt')).toBe('created_at');
	});
});

describe('Singleton instances', () => {
	it('identityNaming is a singleton', () => {
		expect(identityNaming).toBeInstanceOf(IdentityNamingPlugin);
		expect(identityNaming.toDatabase('test')).toBe('test');
	});

	it('camelCaseNaming is a singleton', () => {
		expect(camelCaseNaming).toBeInstanceOf(CamelCaseNamingPlugin);
		expect(camelCaseNaming.toDatabase('testCase')).toBe('test_case');
	});
});
