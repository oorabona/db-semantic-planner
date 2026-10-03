import { describe, expect, it } from 'vitest';
import { compile } from '../index.js';

const relations = [
	{
		name: 'author',
		source: 'posts',
		target: 'users',
		type: 'belongsTo' as const,
		foreignKey: 'authorId',
	},
	{
		name: 'file',
		source: 'users',
		target: 'files',
		type: 'belongsTo' as const,
		foreignKey: 'fileId',
	},
];
const schema = {
	getRelation(qualifiedName: string) {
		return relations.find(
			(relation) => `${relation.source}.${relation.name}` === qualifiedName,
		);
	},
	getTable(name: string) {
		const columns: Record<string, string[]> = {
			posts: ['id', 'authorId'],
			users: ['id', 'fileId', 'firstName'],
			files: ['id', 'path'],
		};
		return columns[name]
			? { columns: columns[name].map((name) => ({ name })) }
			: undefined;
	},
	getRelationsFrom(source: string) {
		return relations.filter((relation) => relation.source === source);
	},
};

describe('declared relation column final target', () => {
	it('accepts a leaf on the final target', () => {
		expect(compile('posts | select author.file.path', schema).success).toBe(
			true,
		);
	});
	it('refuses a leaf that exists only on the first target', () => {
		const result = compile('posts | select author.file.firstName', schema);
		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toBe(
			"Column 'firstName' does not exist on table 'files'. Available columns: id, path",
		);
	});
	it('validates a binding relation column against the final target', () => {
		const prefix =
			'posts | select id, authorId | bind projected_posts\nprojected_posts | select ';
		expect(compile(`${prefix}author.file.path`, schema).success).toBe(true);
		const result = compile(`${prefix}author.file.firstName`, schema);
		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toBe(
			"Column 'firstName' does not exist on table 'files'. Available columns: id, path",
		);
	});
	it('validates relation paths inside SELECT functions against the final target', () => {
		expect(
			compile('posts | select upper(author.file.path) as path', schema).success,
		).toBe(true);
		const result = compile(
			'posts | select upper(author.file.firstName) as name',
			schema,
		);
		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toBe(
			"Column 'firstName' does not exist on table 'files'. Available columns: id, path",
		);
	});
	it('refuses an undeclared segment', () => {
		const result = compile('posts | select author.missing.path', schema);
		expect(result.success).toBe(false);
		expect(result.errors[0]?.message).toBe(
			"Relation 'missing' is not declared on table 'users'.",
		);
	});
});
