/**
 * @module model-impl
 * ModelIR implementation with Map-based storage and helper methods.
 */

import type {
	AmbiguityCheckResult,
	EnumIR,
	ModelIR,
	RelationIR,
	TableIR,
} from './model-ir.js';

/**
 * Immutable ModelIR implementation
 */
export class ModelIRImpl implements ModelIR {
	readonly tables: ReadonlyMap<string, TableIR>;
	readonly relations: ReadonlyMap<string, RelationIR>;
	readonly enums?: ReadonlyMap<string, EnumIR>;

	// Pre-computed indexes for efficient lookups
	private readonly relationsBySource: ReadonlyMap<
		string,
		readonly RelationIR[]
	>;
	private readonly relationsByTarget: ReadonlyMap<
		string,
		readonly RelationIR[]
	>;

	constructor(
		tables: Map<string, TableIR>,
		relations: Map<string, RelationIR>,
		enums?: Map<string, EnumIR>,
	) {
		// Freeze the maps to ensure immutability
		this.tables = Object.freeze(new Map(tables)) as ReadonlyMap<
			string,
			TableIR
		>;
		this.relations = Object.freeze(new Map(relations)) as ReadonlyMap<
			string,
			RelationIR
		>;
		if (enums) {
			this.enums = Object.freeze(new Map(enums)) as ReadonlyMap<
				string,
				EnumIR
			>;
		}

		// Build indexes
		this.relationsBySource = this.buildRelationsBySourceIndex(relations);
		this.relationsByTarget = this.buildRelationsByTargetIndex(relations);

		// Validate the schema
		this.validate();
	}

	/**
	 * Get table by name
	 */
	getTable(name: string): TableIR | undefined {
		return this.tables.get(name);
	}

	/**
	 * Get relation by qualified name "source.relationName"
	 */
	getRelation(qualifiedName: string): RelationIR | undefined {
		return this.relations.get(qualifiedName);
	}

	/**
	 * Get all relations from a source table
	 */
	getRelationsFrom(sourceTable: string): readonly RelationIR[] {
		return this.relationsBySource.get(sourceTable) ?? [];
	}

	/**
	 * Get all relations to a target table
	 */
	getRelationsTo(targetTable: string): readonly RelationIR[] {
		return this.relationsByTarget.get(targetTable) ?? [];
	}

	/**
	 * Check if relation path is ambiguous (multiple relations to same target)
	 */
	isAmbiguous(sourceTable: string, targetTable: string): AmbiguityCheckResult {
		const relationsFromSource = this.getRelationsFrom(sourceTable);
		const matchingRelations = relationsFromSource.filter(
			(r) => r.target === targetTable,
		);

		if (matchingRelations.length <= 1) {
			return {
				ambiguous: false,
				options: matchingRelations.map((r) => r.name),
			};
		}

		return {
			ambiguous: true,
			options: matchingRelations.map((r) => r.name),
		};
	}

	// =========================================================================
	// Private Methods
	// =========================================================================

	private buildRelationsBySourceIndex(
		relations: Map<string, RelationIR>,
	): ReadonlyMap<string, readonly RelationIR[]> {
		const index = new Map<string, RelationIR[]>();

		for (const relation of relations.values()) {
			const existing = index.get(relation.source) ?? [];
			index.set(relation.source, [...existing, relation]);
		}

		// Create frozen index with readonly arrays
		const frozenIndex = new Map<string, readonly RelationIR[]>();
		for (const [key, value] of index) {
			frozenIndex.set(key, Object.freeze(value));
		}

		return Object.freeze(frozenIndex) as ReadonlyMap<
			string,
			readonly RelationIR[]
		>;
	}

	private buildRelationsByTargetIndex(
		relations: Map<string, RelationIR>,
	): ReadonlyMap<string, readonly RelationIR[]> {
		const index = new Map<string, RelationIR[]>();

		for (const relation of relations.values()) {
			const existing = index.get(relation.target) ?? [];
			index.set(relation.target, [...existing, relation]);
		}

		// Create frozen index with readonly arrays
		const frozenIndex = new Map<string, readonly RelationIR[]>();
		for (const [key, value] of index) {
			frozenIndex.set(key, Object.freeze(value));
		}

		return Object.freeze(frozenIndex) as ReadonlyMap<
			string,
			readonly RelationIR[]
		>;
	}

	private validate(): void {
		const errors: string[] = [];

		// Validate PK columns exist when PK is defined
		for (const table of this.tables.values()) {
			if (table.primaryKey) {
				const pkCols = Array.isArray(table.primaryKey)
					? table.primaryKey
					: [table.primaryKey];
				for (const pk of pkCols) {
					if (!table.columns.some((c) => c.name === pk)) {
						errors.push(
							`Table "${table.name}" primary key column "${pk}" not found in columns`,
						);
					}
				}
			}
		}

		// Validate all FK references point to existing tables
		for (const table of this.tables.values()) {
			for (const fk of table.foreignKeys) {
				if (!this.tables.has(fk.references.table)) {
					errors.push(
						`Table "${table.name}" has FK referencing non-existent table "${fk.references.table}"`,
					);
				}
			}
		}

		// Validate all relation targets exist
		for (const relation of this.relations.values()) {
			if (!this.tables.has(relation.source)) {
				errors.push(
					`Relation "${relation.name}" has non-existent source table "${relation.source}"`,
				);
			}
			if (!this.tables.has(relation.target)) {
				errors.push(
					`Relation "${relation.name}" has non-existent target table "${relation.target}"`,
				);
			}
			if (relation.through && !this.tables.has(relation.through)) {
				errors.push(
					`Relation "${relation.name}" has non-existent through table "${relation.through}"`,
				);
			}
		}

		// Detect circular relations (informational only, not an error)
		// Detection logic is retained but logging removed to avoid test pollution
		this.detectCircularRelations();

		if (errors.length > 0) {
			throw new Error(
				`ModelIR validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
			);
		}
	}

	private detectCircularRelations(): string[] {
		const circular: string[] = [];
		const visited = new Set<string>();
		const recursionStack = new Set<string>();

		const dfs = (table: string, path: string[]): void => {
			if (recursionStack.has(table)) {
				const cycleStart = path.indexOf(table);
				const cycle = [...path.slice(cycleStart), table].join(' -> ');
				circular.push(cycle);
				return;
			}

			if (visited.has(table)) {
				return;
			}

			visited.add(table);
			recursionStack.add(table);

			const relations = this.getRelationsFrom(table);
			for (const relation of relations) {
				dfs(relation.target, [...path, table]);
			}

			recursionStack.delete(table);
		};

		for (const tableName of this.tables.keys()) {
			dfs(tableName, []);
		}

		return circular;
	}
}
