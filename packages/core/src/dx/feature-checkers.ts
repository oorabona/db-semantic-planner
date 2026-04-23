import type { DDLFeature, DialectCapabilities, ModelIR } from '@dbsp/types';

// ---------------------------------------------------------------------------
// FeatureChecker interface (OCP-001: Open/Closed for feature negotiation)
// ---------------------------------------------------------------------------

/**
 * Restricted key type: only keys of DialectCapabilities whose value is boolean
 * (or optional boolean). Prevents custom checkers from targeting non-boolean
 * fields (name, recursivePathStyle, identifierQuote, etc.) where a truthy
 * guard would silently break at runtime.
 */
export type DialectCapabilityFlag = Extract<
	{
		[K in keyof DialectCapabilities]: NonNullable<
			DialectCapabilities[K]
		> extends boolean
			? K
			: never;
	}[keyof DialectCapabilities],
	string
>;

/**
 * A self-contained checker for a single DDL feature.
 * Add a new feature by appending a FeatureChecker to DEFAULT_FEATURE_CHECKERS
 * -- no edits to negotiateFeatures() required.
 *
 * Note: when multiple checkers target the same `capability`, all run in array
 * order and each can emit warnings/errors. Deduplication by capability is the
 * caller's responsibility.
 */
export interface FeatureChecker {
	/** Capability flag key — restricted to boolean-valued fields of DialectCapabilities. */
	readonly capability: DialectCapabilityFlag;
	/** DDLFeature name used in warn/error messages and behavior lookup. */
	readonly feature: DDLFeature;
	/**
	 * Walk the ModelIR and return locations where this feature is used.
	 * Return empty array if the feature is not used anywhere.
	 */
	detectUsage(model: ModelIR): readonly FeatureUsage[];
}

/** Location descriptor returned by FeatureChecker.detectUsage(). */
export interface FeatureUsage {
	readonly table?: string;
	readonly column?: string;
	/** Human-readable element label used in warn/error messages. */
	readonly detail: string;
}

// ---------------------------------------------------------------------------
// Default registry -- one entry per supportsDDL* capability flag
// ---------------------------------------------------------------------------

/**
 * Default feature checkers -- mirrors the 15 supportsDDL* flags that
 * negotiateFeatures() previously checked inline.
 *
 * Each checker preserves exactly the same detection logic (same guards,
 * same element label format) that was previously inlined in negotiateFeatures().
 */
export const DEFAULT_FEATURE_CHECKERS: readonly FeatureChecker[] =
	Object.freeze<readonly FeatureChecker[]>([
		// -----------------------------------------------------------------------
		// Schema-level features
		// -----------------------------------------------------------------------
		{
			capability: 'supportsDDLEnumTypes',
			feature: 'enum',
			detectUsage(model) {
				if (!model.enums?.size) return [];
				return [...model.enums.keys()].map((name) => ({ detail: name }));
			},
		},
		{
			capability: 'supportsDDLSequences',
			feature: 'sequence',
			detectUsage(model) {
				if (!model.sequences?.size) return [];
				return [...model.sequences.keys()].map((name) => ({ detail: name }));
			},
		},
		{
			capability: 'supportsDDLExtensions',
			feature: 'extension',
			detectUsage(model) {
				if (!model.extensions?.length) return [];
				return model.extensions.map((ext) => ({ detail: ext }));
			},
		},

		// -----------------------------------------------------------------------
		// Table-level features
		// -----------------------------------------------------------------------
		{
			capability: 'supportsDDLPartitioning',
			feature: 'partition',
			detectUsage(model) {
				if (!model.tables) return [];
				const usages: FeatureUsage[] = [];
				for (const [tableName, table] of model.tables) {
					if (table.partition) {
						usages.push({ table: tableName, detail: tableName });
					}
				}
				return usages;
			},
		},
		{
			capability: 'supportsDDLComments',
			feature: 'comment',
			detectUsage(model) {
				if (!model.tables) return [];
				const usages: FeatureUsage[] = [];
				for (const [tableName, table] of model.tables) {
					if (table.comment) {
						usages.push({ table: tableName, detail: `${tableName} (table)` });
					}
					for (const col of table.columns) {
						if (col.comment) {
							usages.push({
								table: tableName,
								column: col.name,
								detail: `${tableName}.${col.name} (column)`,
							});
						}
					}
				}
				return usages;
			},
		},
		{
			capability: 'supportsDDLCheckConstraints',
			feature: 'checkConstraint',
			detectUsage(model) {
				if (!model.tables) return [];
				const usages: FeatureUsage[] = [];
				for (const [tableName, table] of model.tables) {
					if (table.checkConstraints?.length) {
						for (const chk of table.checkConstraints) {
							usages.push({
								table: tableName,
								detail: `${tableName}.${chk.name}`,
							});
						}
					}
				}
				return usages;
			},
		},
		{
			capability: 'supportsDDLOnUpdateFK',
			feature: 'onUpdateFK',
			detectUsage(model) {
				if (!model.tables) return [];
				const usages: FeatureUsage[] = [];
				for (const [tableName, table] of model.tables) {
					for (const fk of table.foreignKeys) {
						if (fk.onUpdate && fk.onUpdate !== 'NO ACTION') {
							usages.push({
								table: tableName,
								detail: `${tableName} FK → ${fk.references.table}`,
							});
						}
					}
				}
				return usages;
			},
		},
		{
			capability: 'supportsDDLDeferredFK',
			feature: 'deferredFK',
			detectUsage(model) {
				if (!model.tables) return [];
				const usages: FeatureUsage[] = [];
				for (const [tableName, table] of model.tables) {
					for (const fk of table.foreignKeys) {
						if (fk.deferred) {
							usages.push({
								table: tableName,
								detail: `${tableName} FK → ${fk.references.table}`,
							});
						}
					}
				}
				return usages;
			},
		},

		// -----------------------------------------------------------------------
		// Column-level features
		// -----------------------------------------------------------------------
		{
			capability: 'supportsDDLIdentityColumns',
			feature: 'identity',
			detectUsage(model) {
				if (!model.tables) return [];
				const usages: FeatureUsage[] = [];
				for (const [tableName, table] of model.tables) {
					for (const col of table.columns) {
						if (col.identity) {
							usages.push({
								table: tableName,
								column: col.name,
								detail: `${tableName}.${col.name}`,
							});
						}
					}
				}
				return usages;
			},
		},
		{
			capability: 'supportsDDLCollation',
			feature: 'collation',
			detectUsage(model) {
				if (!model.tables) return [];
				const usages: FeatureUsage[] = [];
				for (const [tableName, table] of model.tables) {
					for (const col of table.columns) {
						if (col.collation) {
							usages.push({
								table: tableName,
								column: col.name,
								detail: `${tableName}.${col.name}`,
							});
						}
					}
				}
				return usages;
			},
		},

		// -----------------------------------------------------------------------
		// Index-level features
		// -----------------------------------------------------------------------
		{
			capability: 'supportsDDLIndexMethods',
			feature: 'indexMethod',
			detectUsage(model) {
				if (!model.tables) return [];
				const usages: FeatureUsage[] = [];
				for (const [tableName, table] of model.tables) {
					for (const idx of table.indexes) {
						if (idx.method && idx.method !== 'btree') {
							const idxName = idx.name ?? `idx on ${tableName}`;
							usages.push({ table: tableName, detail: idxName });
						}
					}
				}
				return usages;
			},
		},
		{
			capability: 'supportsDDLIndexOpclass',
			feature: 'indexOpclass',
			detectUsage(model) {
				if (!model.tables) return [];
				const usages: FeatureUsage[] = [];
				for (const [tableName, table] of model.tables) {
					for (const idx of table.indexes) {
						if (idx.opclass && Object.keys(idx.opclass).length > 0) {
							const idxName = idx.name ?? `idx on ${tableName}`;
							usages.push({ table: tableName, detail: idxName });
						}
					}
				}
				return usages;
			},
		},
		{
			capability: 'supportsDDLIndexInclude',
			feature: 'indexInclude',
			detectUsage(model) {
				if (!model.tables) return [];
				const usages: FeatureUsage[] = [];
				for (const [tableName, table] of model.tables) {
					for (const idx of table.indexes) {
						if (idx.include?.length) {
							const idxName = idx.name ?? `idx on ${tableName}`;
							usages.push({ table: tableName, detail: idxName });
						}
					}
				}
				return usages;
			},
		},
		{
			capability: 'supportsDDLPartialIndexes',
			feature: 'partialIndex',
			detectUsage(model) {
				if (!model.tables) return [];
				const usages: FeatureUsage[] = [];
				for (const [tableName, table] of model.tables) {
					for (const idx of table.indexes) {
						if (idx.where) {
							const idxName = idx.name ?? `idx on ${tableName}`;
							usages.push({ table: tableName, detail: idxName });
						}
					}
				}
				return usages;
			},
		},
		{
			capability: 'supportsDDLExpressionIndexes',
			feature: 'expressionIndex',
			detectUsage(model) {
				if (!model.tables) return [];
				const usages: FeatureUsage[] = [];
				for (const [tableName, table] of model.tables) {
					for (const idx of table.indexes) {
						if (idx.expressions?.length) {
							const idxName = idx.name ?? `idx on ${tableName}`;
							usages.push({ table: tableName, detail: idxName });
						}
					}
				}
				return usages;
			},
		},
	]);
