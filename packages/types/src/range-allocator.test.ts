import { expect, it } from 'vitest';
import { RangeAllocator } from './resolved-includes.js';

it('reserves every declared table spelling without changing the root qualifier', () => {
	const allocator = new RangeAllocator();
	const root = allocator.allocate('fooSq', 'fooSq');
	allocator.reserve(root.alias, root.table);
	expect(root.alias).toBe('fooSq');
	expect(allocator.allocate('foo', 'foo_sq').alias).toBe('foo_sq_1');
});

it('range reservation uses canonical acronym and leading underscore casing', () => {
	const allocator = new RangeAllocator();
	allocator.reserve('events', '__HTTPEvents');
	expect(allocator.allocate('other', '__http_events').alias).toBe(
		'__http_events_1',
	);
});

it('query-local aliases retain their written spelling', () => {
	const allocator = new RangeAllocator();
	allocator.reserve('fileOne', 'definitions');
	expect(allocator.allocate('files', 'file_one').alias).toBe('file_one');
});

it('a table can be named beneath an aliased range of the same table', () => {
	const allocator = new RangeAllocator();
	const outer = allocator.allocate('posts', 'posts_exists_0');
	allocator.reserve(outer.alias, outer.table);
	expect(allocator.allocate('posts', 'posts', 'inner').alias).toBe('posts');
});

it('bound aliases ignore generated reservations and refuse only scope duplicates', () => {
	const allocator = new RangeAllocator();
	allocator.bind('fooBar', 'x');
	expect(allocator.bind('baz', 'foo_bar').alias).toBe('foo_bar');
	expect(() => allocator.bind('other', 'foo_bar')).toThrow(
		"Query scope already binds qualifier 'foo_bar'.",
	);
	expect(allocator.bind('other', 'foo_bar', 'inner').alias).toBe('foo_bar');
	expect(allocator.allocate('other', 'foo_bar').alias).toBe('foo_bar_1');
});
