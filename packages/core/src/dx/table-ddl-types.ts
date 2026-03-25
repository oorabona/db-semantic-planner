/**
 * Type definitions for table-scoped DDL operations.
 *
 * @since DDL-TABLE-001
 */

export type IndexMethod =
	| 'btree'
	| 'hash'
	| 'gist'
	| 'gin'
	| 'brin'
	| 'hnsw'
	| 'ivfflat'
	| 'bm25';

export type IndexColumnDef =
	| string
	| {
			expression: string;
			opclass?: string;
	  };

export type CreateIndexOptions = {
	name: string;
	columns: IndexColumnDef[];
	method?: IndexMethod;
	opclass?: Record<string, string>;
	include?: string[];
	with?: Record<string, unknown>;
	where?: string;
	unique?: boolean;
	ifNotExists?: boolean;
	concurrently?: boolean;
};

export type DropIndexOptions = {
	ifExists?: boolean;
	cascade?: boolean;
	concurrently?: boolean;
	schema?: string;
};

export type VacuumOptions = {
	full?: boolean;
	analyze?: boolean;
};

export type TruncateOptions = {
	cascade?: boolean;
	restartIdentity?: boolean;
};

export type AlterColumnOptions = {
	type?: string;
	using?: string;
	setNotNull?: boolean;
	setDefault?: unknown;
	dropDefault?: boolean;
};

export type IndexInfo = {
	name: string;
	definition: string;
	unique: boolean;
	method: string;
};

export type TableIndexes = {
	create(options: CreateIndexOptions): Promise<void>;
	drop(name: string, options?: DropIndexOptions): Promise<void>;
	list(): Promise<IndexInfo[]>;
};

export type TableDDL = {
	truncate(options?: TruncateOptions): Promise<void>;
	vacuum(options?: VacuumOptions): Promise<void>;
	alterColumn(column: string, options: AlterColumnOptions): Promise<void>;
	indexes: TableIndexes;
};
