import { type CreateIndexOptions, createOrm } from '@dbsp/core';
import { getTestAdapter, getTestPool } from './db.js';
import { extensionFeaturesModel } from './extension-features.model.js';
import { sql } from './sql.js';

export type ExtensionFeatureCapabilities = {
	vector: boolean;
	pgSearch: boolean;
	vectorError?: string;
	pgSearchError?: string;
};

type IndexableFixtureTables = Record<
	'vectors' | 'documents',
	{ indexes: { create(options: CreateIndexOptions): Promise<void> } }
>;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function ensureExtension(
	name: 'vector' | 'pg_search',
): Promise<{ available: boolean; error?: string }> {
	const pool = await getTestPool();

	try {
		await sql`CREATE EXTENSION IF NOT EXISTS ${sql.ref(name)}`.execute(pool);
		return { available: true };
	} catch (error) {
		return { available: false, error: errorMessage(error) };
	}
}

export async function createExtensionFeatureSchema(
	schemaName: string,
): Promise<ExtensionFeatureCapabilities> {
	const pool = await getTestPool();
	const s = sql.ref(schemaName);

	const vector = await ensureExtension('vector');
	const pgSearch = await ensureExtension('pg_search');

	await sql`CREATE SCHEMA IF NOT EXISTS ${s}`.execute(pool);

	if (vector.available) {
		await sql`
      CREATE TABLE ${s}.vectors (
        id INTEGER PRIMARY KEY,
        label TEXT NOT NULL UNIQUE,
        embedding vector(3) NOT NULL
      )
    `.execute(pool);
	}

	await sql`
    CREATE TABLE ${s}.documents (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT NOT NULL
    )
  `.execute(pool);

	return {
		vector: vector.available,
		pgSearch: pgSearch.available,
		...(vector.error !== undefined ? { vectorError: vector.error } : {}),
		...(pgSearch.error !== undefined ? { pgSearchError: pgSearch.error } : {}),
	};
}

export async function createExtensionFeatureIndexes(
	schemaName: string,
	capabilities: ExtensionFeatureCapabilities,
): Promise<void> {
	const adapter = await getTestAdapter();
	const orm = createOrm({ model: extensionFeaturesModel, adapter }).withSchema(
		schemaName,
	);
	const tables = orm.tables as unknown as IndexableFixtureTables;

	if (capabilities.vector) {
		await tables.vectors.indexes.create({
			name: 'idx_extension_vectors_embedding_hnsw',
			columns: ['embedding'],
			method: 'hnsw',
			opclass: { embedding: 'vector_cosine_ops' },
			with: { m: 16, ef_construction: 64 },
			ifNotExists: true,
		});
	}

	if (capabilities.pgSearch) {
		await tables.documents.indexes.create({
			name: 'idx_extension_documents_bm25',
			columns: ['id', 'title', 'body'],
			method: 'bm25',
			with: { key_field: "'id'" },
			ifNotExists: true,
		});
	}
}

export async function dropExtensionFeatureSchema(
	schemaName: string,
): Promise<void> {
	const pool = await getTestPool();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(pool);
}
