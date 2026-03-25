/**
 * Type definitions for table-scoped DDL operations.
 *
 * Primitive option types (TruncateOptions, VacuumOptions, etc.) are defined in
 * @dbsp/types and re-exported here for backward compatibility.
 *
 * @since DDL-TABLE-001
 */

export type {
	AlterColumnOptions,
	CreateIndexOptions,
	DropIndexOptions,
	IndexColumnDef,
	IndexInfo,
	IndexMethod,
	TruncateOptions,
	VacuumOptions,
} from '@dbsp/types';

// ListIndexOptions is defined locally (not in @dbsp/types) — see below

import type {
	AlterColumnOptions,
	CreateIndexOptions,
	DropIndexOptions,
	IndexInfo,
	TruncateOptions,
	VacuumOptions,
} from '@dbsp/types';

export type ListIndexOptions = {
	/** Filter indexes by name pattern (supports SQL LIKE wildcards: %, _). */
	namePattern?: string;
};

export type TableIndexes = {
	create(options: CreateIndexOptions): Promise<void>;
	drop(name: string, options?: DropIndexOptions): Promise<void>;
	list(options?: ListIndexOptions): Promise<IndexInfo[]>;
	/** Check whether an index with the given name exists on this table. */
	exists(name: string): Promise<boolean>;
};

export type TableDDL = {
	truncate(options?: TruncateOptions): Promise<void>;
	vacuum(options?: VacuumOptions): Promise<void>;
	alterColumn(column: string, options: AlterColumnOptions): Promise<void>;
	indexes: TableIndexes;
	/** Return the total storage size of the table (in bytes). Requires a live adapter connection. */
	storageSize(): Promise<number>;
};
