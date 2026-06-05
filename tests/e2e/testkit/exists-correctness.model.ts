/**
 * EXISTS-correctness ModelIR
 *
 * Mirrors the unit-test schema in correctness-130.test.ts:
 *   posts.author_id is the declared FK (not the conventional user_id) so any
 *   fix that threads the FK column name from the ModelIR is exercised at runtime.
 *
 * Two relations from users to comments:
 *   - users ←[user_id]— comments  (direct; name 'comments')
 *   - users ←[author_id]— posts ←[post_id]— comments  (multi-hop)
 * This gives the cross-source same-name test (case 9) a concrete query surface.
 */

import { ref, schema } from '@dbsp/core';

const existsCorrectnessSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		active: 'boolean',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		// Non-conventional FK column name — exposes DEFECT 1 if FK threading breaks.
		// Convention would be 'userId', but we declare it 'authorId' (→ author_id in DB).
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
		published: 'boolean',
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		// FK to posts (relation name: 'post')
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
		// FK to users (relation name: 'commenter')
		userId: ref('users', { as: 'commenter', inverse: 'comments' }),
		body: 'string',
		flagged: 'boolean',
	},
} as const);

export const existsCorrectnessModel = existsCorrectnessSchema.model;
