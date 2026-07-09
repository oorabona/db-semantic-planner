/**
 * ARCH-002 Block 4: Manifest Generator
 *
 * Generates a JSON file containing the schema as plain JSON-serializable objects.
 * This is used for tooling and MCP (Model Context Protocol) consumption.
 */

import type {
	ResolvedSchema,
	SchemaColumnDefinition,
	SchemaRelationDefinition,
} from '@dbsp/core';

/**
 * JSON-serializable column definition for manifest output.
 */
export interface ManifestColumn {
	type: string;
	primaryKey?: boolean;
	nullable?: boolean;
	unique?: boolean;
	default?: string | number | boolean;
	references?: {
		table: string;
		schema?: string;
		column?: string;
	};
}

/**
 * JSON-serializable relation definition for manifest output.
 */
export interface ManifestRelation {
	kind: 'belongsTo' | 'hasMany' | 'manyToMany';
	target: string;
	foreignKey?: string;
	targetKey?: string;
	sourceKey?: string;
	through?: string;
	sourceFk?: string;
	targetFk?: string;
}

/**
 * JSON-serializable hint definition for manifest output.
 */
export interface ManifestHint {
	defaultStrategy?: string;
	cardinality?: string;
}

/**
 * JSON schema manifest structure.
 */
export interface SchemaManifest {
	/** Manifest format version for future compatibility */
	version: '1.0.0';
	tables: Record<string, Record<string, ManifestColumn>>;
	relations: Record<string, ManifestRelation>;
	hints: Record<string, ManifestHint>;
	conventions: {
		fkPattern: string;
		pluralize: boolean;
		timestamps: string[];
		fkAutoIndex: boolean;
	};
}

export interface ManifestOutput {
	/** Generated JSON string */
	json: string;
	/** Parsed manifest object */
	manifest: SchemaManifest;
}

/**
 * Generate manifest JSON file from schema.
 *
 * Output is a JSON file that can be consumed by tooling and MCP.
 */
export function generateManifest(schema: ResolvedSchema): ManifestOutput {
	const manifest: SchemaManifest = {
		version: '1.0.0',
		tables: {},
		relations: {},
		hints: {},
		conventions: {
			fkPattern: schema.conventions.fkPattern,
			pluralize: schema.conventions.pluralize,
			timestamps: schema.conventions.timestamps,
			fkAutoIndex: schema.conventions.fkAutoIndex,
		},
	};

	// Transform tables
	for (const [tableName, table] of Object.entries(schema.tables)) {
		manifest.tables[tableName] = {};
		for (const [colName, colDef] of Object.entries(table)) {
			manifest.tables[tableName][colName] = serializeColumn(colDef);
		}
	}

	// Transform relations
	for (const [key, rel] of Object.entries(schema.relations)) {
		manifest.relations[key] = serializeRelation(rel);
	}

	// Transform hints
	for (const [key, hint] of Object.entries(schema.hints)) {
		const manifestHint: ManifestHint = {};
		if (hint.defaultStrategy)
			manifestHint.defaultStrategy = hint.defaultStrategy;
		if (hint.cardinality) manifestHint.cardinality = hint.cardinality;
		manifest.hints[key] = manifestHint;
	}

	return {
		json: JSON.stringify(manifest, null, 2),
		manifest,
	};
}

/**
 * Serialize a column definition to JSON-serializable object.
 */
function serializeColumn(col: SchemaColumnDefinition): ManifestColumn {
	const result: ManifestColumn = {
		type: col.type,
	};

	if (col.primaryKey) result.primaryKey = true;
	if (col.nullable !== undefined) result.nullable = col.nullable;
	if (col.unique) result.unique = true;
	if (col.default) result.default = col.default;

	if (col.references) {
		result.references = { table: col.references.table };
		if (col.references.schema !== undefined) {
			result.references.schema = col.references.schema;
		}
		if (col.references.column) {
			result.references.column = col.references.column;
		}
	}

	return result;
}

/**
 * Serialize a relation definition to JSON-serializable object.
 */
function serializeRelation(rel: SchemaRelationDefinition): ManifestRelation {
	const result: ManifestRelation = {
		kind: rel.kind,
		target: rel.target,
	};

	switch (rel.kind) {
		case 'belongsTo':
			result.foreignKey = rel.foreignKey;
			if (rel.targetKey) result.targetKey = rel.targetKey;
			break;
		case 'hasMany':
			result.foreignKey = rel.foreignKey;
			if (rel.sourceKey) result.sourceKey = rel.sourceKey;
			break;
		case 'manyToMany':
			result.through = rel.through;
			result.sourceFk = rel.sourceFk;
			result.targetFk = rel.targetFk;
			break;
	}

	return result;
}
