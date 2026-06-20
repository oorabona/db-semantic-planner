import { getTestPool } from './db.js';
import type { ExtensionFeatureCapabilities } from './extension-features.ddl.js';
import { sql } from './sql.js';

export const vectorLabels = {
	cosineOrder: [
		'unit_x',
		'long_near_x',
		'mid_diagonal',
		'unit_y',
		'opposite_x',
	],
	l2Order: ['unit_x', 'mid_diagonal', 'unit_y', 'opposite_x', 'long_near_x'],
	innerProductOrder: [
		'long_near_x',
		'unit_x',
		'mid_diagonal',
		'unit_y',
		'opposite_x',
	],
} as const;

export const documentTitles = {
	bm25Order: [
		'Semantic Semantic Semantic Guide',
		'Semantic Semantic Notes',
		'Semantic Basics',
	],
	boostedBooleanOrder: ['Turbo Reference', 'Turbo Intro', 'Planner Body Match'],
	nativeFullTextOrder: ['Postgres Postgres Ranking', 'Postgres Vector Search'],
} as const;

export async function seedExtensionFeatureData(
	schemaName: string,
	capabilities: ExtensionFeatureCapabilities,
): Promise<void> {
	const pool = await getTestPool();

	if (capabilities.vector) {
		await sql`
      INSERT INTO ${sql.ref(schemaName)}.vectors (id, label, embedding)
      VALUES
        (1, 'unit_x', '[1,0,0]'::vector),
        (2, 'long_near_x', '[10,1,0]'::vector),
        (3, 'mid_diagonal', '[0.7,0.7,0]'::vector),
        (4, 'unit_y', '[0,1,0]'::vector),
        (5, 'opposite_x', '[-1,0,0]'::vector)
    `.execute(pool);
	}

	await sql`
    INSERT INTO ${sql.ref(schemaName)}.documents (id, title, body, category)
    VALUES
      (
        1,
        'Semantic Semantic Semantic Guide',
        'semantic semantic semantic semantic semantic retrieval tutorial',
        'search'
      ),
      (
        2,
        'Semantic Semantic Notes',
        'semantic semantic retrieval notes',
        'search'
      ),
      (
        3,
        'Semantic Basics',
        'semantic overview',
        'search'
      ),
      (
        4,
        'Planner Body Match',
        'planner planner planner planner planner details',
        'planner'
      ),
      (
        5,
        'Turbo Intro',
        'brief planner overview',
        'planner'
      ),
      (
        6,
        'Turbo Reference',
        'brief turbo reference',
        'planner'
      ),
      (
        7,
        'Postgres Vector Search',
        'postgres vector search ranking',
        'postgres'
      ),
      (
        8,
        'Postgres Postgres Ranking',
        'postgres postgres ranking ranking ranking',
        'postgres'
      ),
      (
        9,
        'Cooking Notes',
        'sourdough starter hydration timing',
        'other'
      )
  `.execute(pool);
}
