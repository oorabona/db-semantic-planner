import { create } from 'zustand';

// ── Serializable schema types (from sidecar introspect response) ────

export interface SchemaColumn {
	readonly name: string;
	readonly type: string;
	readonly nullable: boolean;
	readonly default?: unknown;
	readonly originalDbType?: string;
	readonly unique?: boolean;
	readonly autoIncrement?: boolean;
}

export interface SchemaForeignKey {
	readonly columns: readonly string[];
	readonly references: {
		readonly table: string;
		readonly columns: readonly string[];
	};
	readonly onDelete?: string;
}

export interface SchemaIndex {
	readonly name?: string;
	readonly columns: readonly string[];
	readonly unique?: boolean;
}

export interface SchemaTable {
	readonly name: string;
	readonly columns: readonly SchemaColumn[];
	readonly primaryKey?: string | readonly string[];
	readonly foreignKeys: readonly SchemaForeignKey[];
	readonly indexes: readonly SchemaIndex[];
}

export interface SchemaRelation {
	readonly name: string;
	readonly type: string;
	readonly source: string;
	readonly target: string;
	readonly through?: string;
	readonly foreignKey?: string | readonly string[];
	readonly cardinality: string;
}

export interface IntrospectionResult {
	readonly tables: readonly SchemaTable[];
	readonly relations: readonly SchemaRelation[];
	readonly hierarchies: readonly unknown[];
	readonly warnings: readonly string[];
	readonly introspectedAt: string;
}

// ── Store ───────────────────────────────────────────────────────────

interface SchemaState {
	/** Introspected schema data (null = not loaded) */
	schema: IntrospectionResult | null;

	/** Loading state */
	loading: boolean;

	/** Error message */
	error: string | null;

	/** Set of expanded node IDs (e.g., "table:users", "table:users:columns") */
	expanded: Set<string>;

	/** Search filter text */
	searchFilter: string;

	// ── Actions ──

	setSchema: (schema: IntrospectionResult) => void;
	clearSchema: () => void;
	setLoading: (loading: boolean) => void;
	setError: (error: string | null) => void;
	toggleExpanded: (nodeId: string) => void;
	setExpanded: (nodeId: string, expanded: boolean) => void;
	collapseAll: () => void;
	setSearchFilter: (filter: string) => void;
}

export const useSchemaStore = create<SchemaState>((set) => ({
	schema: null,
	loading: false,
	error: null,
	expanded: new Set<string>(),
	searchFilter: '',

	setSchema: (schema) => set({ schema, error: null }),
	clearSchema: () => set({ schema: null, error: null, expanded: new Set() }),
	setLoading: (loading) => set({ loading }),
	setError: (error) => set({ error, loading: false }),

	toggleExpanded: (nodeId) =>
		set((state) => {
			const next = new Set(state.expanded);
			if (next.has(nodeId)) {
				next.delete(nodeId);
			} else {
				next.add(nodeId);
			}
			return { expanded: next };
		}),

	setExpanded: (nodeId, expanded) =>
		set((state) => {
			const next = new Set(state.expanded);
			if (expanded) {
				next.add(nodeId);
			} else {
				next.delete(nodeId);
			}
			return { expanded: next };
		}),

	collapseAll: () => set({ expanded: new Set() }),

	setSearchFilter: (filter) => set({ searchFilter: filter }),
}));

// ── Derived helpers ──────────────────────────────────────────────────

/** Get tables filtered by search query */
export function getFilteredTables(
	schema: IntrospectionResult | null,
	filter: string,
): readonly SchemaTable[] {
	if (!schema) return [];
	if (!filter.trim()) return schema.tables;
	const lower = filter.toLowerCase();
	return schema.tables.filter((t) => t.name.toLowerCase().includes(lower));
}

/** Check if a column is part of the primary key */
export function isPrimaryKey(table: SchemaTable, columnName: string): boolean {
	if (!table.primaryKey) return false;
	if (typeof table.primaryKey === 'string')
		return table.primaryKey === columnName;
	return table.primaryKey.includes(columnName);
}

/** Check if a column is a foreign key */
export function isForeignKey(table: SchemaTable, columnName: string): boolean {
	return table.foreignKeys.some((fk) => fk.columns.includes(columnName));
}

/** Get the FK reference target for a column (if any) */
export function getFkTarget(
	table: SchemaTable,
	columnName: string,
): { table: string; column: string } | null {
	for (const fk of table.foreignKeys) {
		const idx = fk.columns.indexOf(columnName);
		if (idx >= 0) {
			return {
				table: fk.references.table,
				column: fk.references.columns[idx] ?? fk.references.columns[0] ?? '',
			};
		}
	}
	return null;
}
