/**
 * EXISTS-correctness Seed
 *
 * DISCRIMINATION DESIGN — each case has rows that SHOULD be included and rows
 * that SHOULD be excluded (so a bug that broadens or narrows the result is
 * immediately visible):
 *
 * Users:
 *   u1 "Alice"   active=true   → has published post(s) and also unpublished post(s)
 *   u2 "Bob"     active=true   → ONLY published posts (no unpublished)
 *   u3 "Carol"   active=false  → has posts (1 published, 1 unpublished)
 *   u4 "Dave"    active=true   → has NO posts at all
 *   u5 "Eve"     active=false  → has NO posts at all
 *
 * Posts:
 *   p1 author=Alice  published=true   (the published one for Alice)
 *   p2 author=Alice  published=false  (the unpublished draft)
 *   p3 author=Bob    published=true
 *   p4 author=Bob    published=true
 *   p5 author=Carol  published=true
 *   p6 author=Carol  published=false
 *
 * Comments (post_id links to posts; user_id is the commenter):
 *   c1 post=p1 user=Alice   flagged=false   (Alice comments on her own post)
 *   c2 post=p1 user=Bob     flagged=true    (Bob writes a flagged comment on p1)
 *   c3 post=p3 user=Alice   flagged=false   (Alice comments on Bob's published post)
 *   c4 post=p5 user=Dave    flagged=true    (Dave flags on Carol's published post)
 *   c5 post=p2 user=Eve     flagged=false   (Eve on Alice's DRAFT — post is unpublished)
 *
 * From this seed, the expected row-sets for each test case are:
 *
 * Case 1 — users WHERE EXISTS posts{published=T}:
 *   Alice (p1), Bob (p3,p4), Carol (p5)  → names: ["Alice","Bob","Carol"]
 *   Excluded: Dave (no posts), Eve (no posts)
 *   Bug discriminator: a broadened query (dropped published predicate) would include
 *   Alice AND Dave/Eve if it missed the FK correlation entirely.
 *
 * Case 2 — users WHERE NOT EXISTS posts{published=F}:
 *   Alice has p2 (published=false) → EXCLUDED
 *   Bob has only published posts   → INCLUDED
 *   Carol has p6 (published=false) → EXCLUDED
 *   Dave no posts at all → NOT EXISTS vacuously true → INCLUDED
 *   Eve no posts at all  → INCLUDED
 *   Expected: ["Bob","Dave","Eve"]
 *   Bug: if FK dropped, NOT EXISTS misses the user_id correlation → wrong exclusion.
 *
 * Case 3 — IN/NOT-IN subquery:
 *   inSubquery('id', posts[published=T].select('authorId')) → users who authored ≥1 published post
 *   = Alice (p1), Bob (p3), Carol (p5) → ["Alice","Bob","Carol"]
 *   NOT-IN: Dave, Eve  → ["Dave","Eve"]
 *   Bug: if the IN-to-ANY rewrite picks wrong polarity, sets flip.
 *
 * Case 4 — nested exists: users WHERE EXISTS posts{WHERE EXISTS comments{flagged=T}}:
 *   p1 (Alice's) has c2 flagged → Alice INCLUDED
 *   p5 (Carol's) has c4 flagged → Carol INCLUDED
 *   p3/p4 (Bob's) have only c3 (Alice's, not flagged) → Bob EXCLUDED
 *   Dave, Eve: no posts → EXCLUDED
 *   Expected: ["Alice","Carol"]
 *   Bug discriminator: if inner EXISTS uses wrong post_id correlation (post_id vs user_id),
 *   it might match c4(user=Dave) and include Dave; or match c2 on user not post.
 *
 * Case 5 — NOT(AND(EXISTS posts, active=T)):
 *   Active users WITH posts: Alice (active+posts), Bob (active+posts) → these FAIL condition → EXCLUDED
 *   Carol: active=false, has posts → NOT(EXISTS∧false) = NOT(false) = true → INCLUDED
 *   Dave:  active=true, no posts  → NOT(false∧true) = NOT(false) = true → INCLUDED
 *   Eve:   active=false, no posts → NOT(false∧false) → INCLUDED
 *   Expected: ["Carol","Dave","Eve"]
 *
 * Case 6 — OR(active=T, EXISTS posts{published=T}):
 *   Alice: active=T → INCLUDED (regardless of posts)
 *   Bob:   active=T → INCLUDED
 *   Carol: active=F, has published p5 → INCLUDED via EXISTS
 *   Dave:  active=T, no posts → INCLUDED via active
 *   Eve:   active=F, no posts → EXCLUDED (both sides false)
 *   Expected: ["Alice","Bob","Carol","Dave"]
 *
 * Case 7 — multi-hop ['posts','comments'] with flagged=T:
 *   Reachable chain: user→posts→comments where flagged=T
 *   Alice → p1 → c2(flagged=T) → INCLUDED
 *   Carol → p5 → c4(flagged=T) → INCLUDED
 *   Bob   → p3,p4 → only c3(flagged=F) → EXCLUDED
 *   Dave/Eve: no posts → EXCLUDED
 *   Expected: ["Alice","Carol"]
 *
 * Case 8 — include + exists: users WHERE EXISTS posts{published=T} + INCLUDE posts:
 *   Matching users: Alice, Bob, Carol (same as Case 1)
 *   propagateExistsConditions propagates published=T into the include subquery (designed).
 *   Alice: 1 included post (p1, published=T only)  [p2 is published=F, excluded by propagation]
 *   Bob:   2 included posts (p3+p4, both published=T)
 *   Carol: 1 included post (p5, published=T only)  [p6 is published=F, excluded by propagation]
 *
 * Case 9 — cross-source same-name: users WHERE EXISTS comments{flagged=T}:
 *   (direct relation via user_id FK, NOT via posts.post_id)
 *   c2(user=Bob, flagged=T), c4(user=Dave, flagged=T)
 *   Included: Bob, Dave
 *   Alice's comments: c1(flagged=F), c3(flagged=F) → EXCLUDED
 *   Carol, Eve: no direct comments → EXCLUDED
 *   Expected: ["Bob","Dave"]
 *   Contrast with Case 4: DIFFERENT result set proves FK routing is correct.
 */

import { getTestPool } from './db.js';
import { sql } from './sql.js';

export async function seedExistsCorrectnessData(
	schemaName: string,
): Promise<void> {
	const pool = await getTestPool();
	const s = sql.ref(schemaName);

	// users
	await sql`
    INSERT INTO ${s}.users (id, name, active) VALUES
      (1, 'Alice', true),
      (2, 'Bob',   true),
      (3, 'Carol', false),
      (4, 'Dave',  true),
      (5, 'Eve',   false)
  `.execute(pool);

	// posts — author_id uses declared FK column, NOT the conventional user_id
	await sql`
    INSERT INTO ${s}.posts (id, title, author_id, published) VALUES
      (1, 'Alice pub',     1, true),
      (2, 'Alice draft',   1, false),
      (3, 'Bob pub 1',     2, true),
      (4, 'Bob pub 2',     2, true),
      (5, 'Carol pub',     3, true),
      (6, 'Carol draft',   3, false)
  `.execute(pool);

	// comments — post_id + user_id both populated
	await sql`
    INSERT INTO ${s}.comments (id, post_id, user_id, body, flagged) VALUES
      (1, 1, 1, 'Alice on her own post',       false),
      (2, 1, 2, 'Bob flagged comment on p1',   true),
      (3, 3, 1, 'Alice on Bob pub post',        false),
      (4, 5, 4, 'Dave flagged on Carol post',   true),
      (5, 2, 5, 'Eve on Alice draft',           false)
  `.execute(pool);
}
