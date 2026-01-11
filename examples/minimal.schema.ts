/**
 * Example: Minimal Schema
 *
 * The simplest possible schema - just users and posts.
 * Perfect for getting started quickly.
 *
 * Usage:
 *   pnpm dbsp repl --schema ./examples/minimal.schema.ts
 *   pnpm dbsp generate kysely --schema ./examples/minimal.schema.ts
 */

import { defineSchema } from '@db-semantic-planner/schema';

export default defineSchema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'string' },
		email: { type: 'string' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: { type: 'string' },
		content: { type: 'text', nullable: true },
		userId: { type: 'integer', references: { table: 'users' } },
	},
});
// Relations auto-inferred from `references`:
// - users.posts (hasMany)
// - posts.user (belongsTo)
