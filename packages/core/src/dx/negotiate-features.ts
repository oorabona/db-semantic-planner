import type {
	DDLFeature,
	DialectCapabilities,
	FeatureBehaviorConfig,
	FeatureWarning,
	ModelIR,
	UnsupportedFeatureBehavior,
} from '@dbsp/types';
import { UnsupportedFeatureError } from '@dbsp/types';

/**
 * Map DDLFeature names to DialectCapabilities flag names.
 * Used to check if a feature is supported.
 */
const FEATURE_TO_CAP: Record<DDLFeature, keyof DialectCapabilities> = {
	enum: 'supportsDDLEnumTypes',
	sequence: 'supportsDDLSequences',
	extension: 'supportsDDLExtensions',
	partition: 'supportsDDLPartitioning',
	checkConstraint: 'supportsDDLCheckConstraints',
	onUpdateFK: 'supportsDDLOnUpdateFK',
	deferredFK: 'supportsDDLDeferredFK',
	identity: 'supportsDDLIdentityColumns',
	collation: 'supportsDDLCollation',
	comment: 'supportsDDLComments',
	indexMethod: 'supportsDDLIndexMethods',
	indexOpclass: 'supportsDDLIndexOpclass',
	indexInclude: 'supportsDDLIndexInclude',
	partialIndex: 'supportsDDLPartialIndexes',
	expressionIndex: 'supportsDDLExpressionIndexes',
};

/** Resolve effective behavior for a specific feature */
function resolveBehavior(
	feature: DDLFeature,
	config: UnsupportedFeatureBehavior | FeatureBehaviorConfig,
): UnsupportedFeatureBehavior {
	if (typeof config === 'string') return config;
	return config.overrides?.[feature] ?? config.default;
}

/** Check if a DDL feature is supported by the dialect */
function isSupported(caps: DialectCapabilities, feature: DDLFeature): boolean {
	return caps[FEATURE_TO_CAP[feature]] === true;
}

export interface NegotiationResult {
	readonly warnings: readonly FeatureWarning[];
}

/**
 * Cross-check ModelIR features against DialectCapabilities.
 * Emits warnings or throws based on UnsupportedFeatureBehavior.
 *
 * INV-06: MUST NOT modify the ModelIR.
 * ERR-02: error mode throws on FIRST unsupported feature (fail-fast).
 * ERR-03: warning mode collects ALL warnings.
 */
export function negotiateFeatures(
	model: ModelIR,
	capabilities: DialectCapabilities,
	behavior: UnsupportedFeatureBehavior | FeatureBehaviorConfig = 'warning',
): NegotiationResult {
	const warnings: FeatureWarning[] = [];
	const adapterName = capabilities.name;

	function handleUnsupported(feature: DDLFeature, element: string): void {
		const effectiveBehavior = resolveBehavior(feature, behavior);
		if (effectiveBehavior === 'ignore') return;

		const message = `Unsupported feature "${feature}" on adapter "${adapterName}" for "${element}"`;

		if (effectiveBehavior === 'error') {
			throw new UnsupportedFeatureError(feature, adapterName, element);
		}

		// warning mode
		warnings.push({ feature, adapter: adapterName, element, message });
	}

	// Check schema-level features
	if (model.enums?.size && !isSupported(capabilities, 'enum')) {
		for (const [name] of model.enums) {
			handleUnsupported('enum', name);
		}
	}

	if (model.sequences?.size && !isSupported(capabilities, 'sequence')) {
		for (const [name] of model.sequences) {
			handleUnsupported('sequence', name);
		}
	}

	if (model.extensions?.length && !isSupported(capabilities, 'extension')) {
		for (const ext of model.extensions) {
			handleUnsupported('extension', ext);
		}
	}

	// Check table-level features (guard: mock models may lack .tables)
	if (!model.tables) return { warnings };
	for (const [tableName, table] of model.tables) {
		// Partition
		if (table.partition && !isSupported(capabilities, 'partition')) {
			handleUnsupported('partition', tableName);
		}

		// Table comment
		if (table.comment && !isSupported(capabilities, 'comment')) {
			handleUnsupported('comment', `${tableName} (table)`);
		}

		// CHECK constraints
		if (
			table.checkConstraints?.length &&
			!isSupported(capabilities, 'checkConstraint')
		) {
			for (const chk of table.checkConstraints) {
				handleUnsupported('checkConstraint', `${tableName}.${chk.name}`);
			}
		}

		// Foreign keys
		for (const fk of table.foreignKeys) {
			if (
				fk.onUpdate &&
				fk.onUpdate !== 'NO ACTION' &&
				!isSupported(capabilities, 'onUpdateFK')
			) {
				handleUnsupported(
					'onUpdateFK',
					`${tableName} FK → ${fk.references.table}`,
				);
			}
			if (fk.deferred && !isSupported(capabilities, 'deferredFK')) {
				handleUnsupported(
					'deferredFK',
					`${tableName} FK → ${fk.references.table}`,
				);
			}
		}

		// Columns
		for (const col of table.columns) {
			if (col.identity && !isSupported(capabilities, 'identity')) {
				handleUnsupported('identity', `${tableName}.${col.name}`);
			}
			if (col.collation && !isSupported(capabilities, 'collation')) {
				handleUnsupported('collation', `${tableName}.${col.name}`);
			}
			if (col.comment && !isSupported(capabilities, 'comment')) {
				handleUnsupported('comment', `${tableName}.${col.name} (column)`);
			}
		}

		// Indexes
		for (const idx of table.indexes) {
			const idxName = idx.name ?? `idx on ${tableName}`;
			if (
				idx.method &&
				idx.method !== 'btree' &&
				!isSupported(capabilities, 'indexMethod')
			) {
				handleUnsupported('indexMethod', idxName);
			}
			if (
				idx.opclass &&
				Object.keys(idx.opclass).length > 0 &&
				!isSupported(capabilities, 'indexOpclass')
			) {
				handleUnsupported('indexOpclass', idxName);
			}
			if (idx.include?.length && !isSupported(capabilities, 'indexInclude')) {
				handleUnsupported('indexInclude', idxName);
			}
			if (idx.where && !isSupported(capabilities, 'partialIndex')) {
				handleUnsupported('partialIndex', idxName);
			}
			if (
				idx.expressions?.length &&
				!isSupported(capabilities, 'expressionIndex')
			) {
				handleUnsupported('expressionIndex', idxName);
			}
		}
	}

	return { warnings };
}
