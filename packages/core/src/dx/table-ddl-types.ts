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

import type {
	AlterColumnOptions,
	CreateIndexOptions,
	DropIndexOptions,
	IndexInfo,
	TruncateOptions,
	VacuumOptions,
} from '@dbsp/types';

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
