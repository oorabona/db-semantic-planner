/**
 * Example: Minimal Schema
 *
 * The simplest possible schema - just users and posts.
 * Perfect for getting started quickly.
 *
 * Usage:
 *   pnpm dbsp repl --schema ./examples/minimal.schema.ts
 *   pnpm dbsp generate ddl --schema ./examples/minimal.schema.ts
 */

// ARCH-005: Use ref() alias to avoid conflict with subquery ref()
// Alternatively: import { schema, ref } from '@dbsp/core/dx/schema.js'
import { ref, schema } from '@dbsp/core';

export default schema({
	users: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		name: { type: 'string', index: true },
		email: { type: 'string', unique: true },
	},
	posts: {
		id: { type: 'integer', primaryKey: true, autoIncrement: true },
		title: 'string',
		content: { type: 'text', nullable: true },
		published: { type: 'boolean', default: 'false' },
		userId: ref('users', { onDelete: 'CASCADE', inverse: 'posts' }),
	},
});
// Relations auto-inferred from ref():
// - users.posts (hasMany) - custom inverse name
// - posts.user (belongsTo)
