/**
 * CLI-DDL: Schema Codegen Module
 *
 * Generates TypeScript schema files from IntrospectedModelIR.
 * Used by `dbsp introspect` to create dbsp.schema.ts from a database.
 */

import type { ModelIR, TableIR } from '@dbsp/core';
import { redactDbUrl } from '../utils/db-utils.js';

/**
 * Convert a snake_case string to camelCase.
 * @example 'author_id' → 'authorId'
 */
function snakeToCamelCase(name: string): string {
	return name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * Options for schema code generation.
 */
export interface SchemaCodegenOptions {
	/** Source database URL (for comment header) */
	readonly sourceUrl?: string;
	/** Include original DB types as comments */
	readonly includeDbTypeComments?: boolean;
	/** Warnings from introspection to include as comments */
	readonly warnings?: readonly string[];
	/** Timestamp of introspection */
	readonly introspectedAt?: Date;
	/**
	 * Database column casing convention.
	 * When set to 'snake_case', column names are converted to camelCase
	 * and a `dbCasing: 'snake_case'` comment is added to the generated code.
	 * @default 'preserve'
	 */
	readonly dbCasing?: 'snake_case' | 'camelCase' | 'preserve';
}

/**
 * Serialize a column default value to valid TypeScript source code.
 *
 * CODEX-11/CODEX-14: String(value) produced "[object Object]" for SQL-expression
 * defaults like { sql: 'now()' }, and single-quote wrapping without escape broke
 * strings containing quotes, backslashes, or newlines.
 *
 * Rules:
 * - null/undefined → 'null'
 * - number | boolean → unquoted literal (String(value))
 * - string → singleQuoteEscape (escapes \, ', \n, \r, \t — produces single-quoted TS literal)
 * - { sql: '...' } shape → `{ sql: ${JSON.stringify(sqlExpr)} }`
 * - anything else → throws (unrecognized shape; prevents silent [object Object])
 */

/**
 * Wrap a string value in single quotes for TypeScript source output,
 * escaping any single quotes and backslashes contained in the value.
 *
 * Examples:
 *   'hello'       → "'hello'"
 *   "O'Brien"     → "'O\\'Brien'"
 *   'C:\\Users'   → "'C:\\\\Users'"
 */
function singleQuoteEscape(s: string): string {
	return `'${s
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'")
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t')}'`;
}

function emitDefault(d: unknown): string {
	if (d === null || d === undefined) return 'null';
	if (typeof d === 'number' || typeof d === 'boolean') return String(d);
	if (typeof d === 'string') return singleQuoteEscape(d);
	if (
		typeof d === 'object' &&
		'sql' in d &&
		typeof (d as { sql: unknown }).sql === 'string'
	) {
		return `{ sql: ${singleQuoteEscape((d as { sql: string }).sql)} }`;
	}
	throw new Error(
		`[schema-codegen] Unrecognized default shape: ${JSON.stringify(d)}`,
	);
}

/**
 * Generate column definition object code.
 */
function generateColumnCode(
	column: TableIR['columns'][number],
	isPrimaryKey: boolean,
	fkInfo:
		| {
				table: string;
				column?: string;
				nullable?: boolean;
				unique?: boolean;
				onDelete?: string;
				onUpdate?: string;
				isSelfRef?: boolean;
		  }
		| undefined,
	options: SchemaCodegenOptions,
): string {
	// CODEX-13: FK + PK overlap — a column can be both FK and PK (e.g. shared-PK 1:1).
	// We must preserve isPrimaryKey even when fkInfo is present.
	if (fkInfo) {
		return generateRefCode(column, fkInfo, isPrimaryKey, options);
	}

	// Check if we can use short form (just 'type' string)
	const canUseShortForm =
		!isPrimaryKey &&
		!column.nullable &&
		column.default === undefined &&
		!column.unique;

	if (canUseShortForm) {
		// Short form: 'type'
		let code = `'${column.type}'`;
		if (options.includeDbTypeComments && column.originalDbType) {
			code += ` /* from: ${column.originalDbType} */`;
		}
		return code;
	}

	// Long form: { type, primaryKey?, nullable?, default?, unique? }
	const props: string[] = [];
	props.push(`type: '${column.type}'`);

	if (isPrimaryKey) {
		props.push('primaryKey: true');
	}

	if (column.nullable) {
		props.push('nullable: true');
	}

	if (column.default !== undefined) {
		props.push(`default: ${emitDefault(column.default)}`);
	}

	if (column.unique) {
		props.push('unique: true');
	}

	let code = `{ ${props.join(', ')} }`;

	if (options.includeDbTypeComments && column.originalDbType) {
		code += ` /* from: ${column.originalDbType} */`;
	}

	return code;
}

/**
 * Generate ref() call for a foreign key column.
 * ARCH-005: Use ref() instead of references: { table, column }
 */
function generateRefCode(
	column: TableIR['columns'][number],
	fkInfo: {
		table: string;
		column?: string;
		nullable?: boolean;
		unique?: boolean;
		onDelete?: string;
		onUpdate?: string;
		isSelfRef?: boolean;
	},
	isPrimaryKey: boolean,
	options: SchemaCodegenOptions,
): string {
	const refOptions: string[] = [];

	// C2: Non-PK FK column — emit references option so codegen round-trips correctly.
	// generateTableCode stores entry.column only when refCol !== 'id' (the default PK).
	if (fkInfo.column && fkInfo.column !== 'id') {
		refOptions.push(`references: ['${fkInfo.column}']`);
	}

	// CODEX-13: FK column that is also PK — emit isPrimaryKey inside ref() options
	if (isPrimaryKey) {
		refOptions.push('isPrimaryKey: true');
	}

	// Nullable FK
	if (fkInfo.nullable || column.nullable) {
		refOptions.push('nullable: true');
	}

	// Unique FK → hasOne (1:1 relation)
	if (fkInfo.unique || column.unique) {
		refOptions.push('unique: true');
	}

	// onDelete action
	if (fkInfo.onDelete && fkInfo.onDelete !== 'NO ACTION') {
		refOptions.push(`onDelete: ${singleQuoteEscape(fkInfo.onDelete)}`);
	}

	// CODEX-12: onUpdate action
	if (fkInfo.onUpdate && fkInfo.onUpdate !== 'NO ACTION') {
		refOptions.push(`onUpdate: ${singleQuoteEscape(fkInfo.onUpdate)}`);
	}

	// Self-referential FK needs roles
	if (fkInfo.isSelfRef) {
		// Infer role names from column name
		// e.g., 'parentId' → parent: 'parent', children: 'children'
		const baseName = column.name.replace(/_?[iI]d$/, '');
		refOptions.push(
			`roles: { parent: '${baseName}', children: '${baseName === 'parent' ? 'children' : `${baseName}s`}' }`,
		);
	}

	// Build the ref() call — table name converted if dbCasing applies
	const refTable =
		options.dbCasing === 'snake_case'
			? snakeToCamelCase(fkInfo.table)
			: fkInfo.table;
	let code: string;
	if (refOptions.length === 0) {
		code = `ref('${refTable}')`;
	} else {
		code = `ref('${refTable}', { ${refOptions.join(', ')} })`;
	}

	// Add comment for original DB type if requested
	if (options.includeDbTypeComments && column.originalDbType) {
		code += ` /* from: ${column.originalDbType} */`;
	}

	return code;
}

/**
 * Generate table definition code.
 */
function generateTableCode(
	table: TableIR,
	options: SchemaCodegenOptions,
): string {
	// ARCH-005: Build FK info map with extended properties
	const fkMap = new Map<
		string,
		{
			table: string;
			column?: string;
			nullable?: boolean;
			unique?: boolean;
			onDelete?: string;
			onUpdate?: string;
			isSelfRef?: boolean;
		}
	>();

	for (const fk of table.foreignKeys) {
		const localCol = fk.columns[0];
		const refCol = fk.references.columns[0];
		if (
			fk.columns.length === 1 &&
			fk.references.columns.length === 1 &&
			localCol &&
			refCol
		) {
			// Find the column to check nullable/unique
			// FK column names may be snake_case (from raw SQL) while column.name
			// is camelCase (when CamelCasePlugin is active)
			const colDef = table.columns.find(
				(c) => c.name === localCol || c.name === snakeToCamelCase(localCol),
			);

			const entry: {
				table: string;
				column?: string;
				nullable?: boolean;
				unique?: boolean;
				onDelete?: string;
				onUpdate?: string;
				isSelfRef?: boolean;
			} = {
				table: fk.references.table,
				isSelfRef: fk.references.table === table.name,
			};

			// Only include column if not 'id' (the default)
			if (refCol !== 'id') {
				entry.column = refCol;
			}

			// Include nullable if true
			if (colDef?.nullable) {
				entry.nullable = true;
			}

			// Include unique if true
			if (colDef?.unique) {
				entry.unique = true;
			}

			// Include onDelete if not the default
			if (fk.onDelete && fk.onDelete !== 'NO ACTION') {
				entry.onDelete = fk.onDelete;
			}

			// CODEX-12: Include onUpdate if not the default
			if (fk.onUpdate && fk.onUpdate !== 'NO ACTION') {
				entry.onUpdate = fk.onUpdate;
			}

			// Store under both snake_case and camelCase keys so fkMap.get(col.name) works
			// regardless of naming convention
			fkMap.set(localCol, entry);
			const camelCol = snakeToCamelCase(localCol);
			if (camelCol !== localCol) {
				fkMap.set(camelCol, entry);
			}
		}
	}

	const shouldCamelCase = options.dbCasing === 'snake_case';

	const columnLines = table.columns.map((col) => {
		const isPrimaryKey = table.primaryKey
			? typeof table.primaryKey === 'string'
				? col.name === table.primaryKey
				: table.primaryKey.includes(col.name)
			: false;
		const fkInfo = fkMap.get(col.name);
		const code = generateColumnCode(col, isPrimaryKey, fkInfo, options);
		const colName = shouldCamelCase ? snakeToCamelCase(col.name) : col.name;
		return `\t\t${colName}: ${code}`;
	});

	const tableName = shouldCamelCase ? snakeToCamelCase(table.name) : table.name;
	return `\t${tableName}: {\n${columnLines.join(',\n')},\n\t}`;
}

/**
 * Generate a TypeScript schema file from ModelIR.
 *
 * @param model - The ModelIR (or IntrospectedModelIR) to generate from
 * @param options - Code generation options
 * @returns TypeScript source code for a schema file
 */
export function generateSchemaFile(
	model: ModelIR,
	options: SchemaCodegenOptions = {},
): string {
	const lines: string[] = [];

	// Header comment
	lines.push('/**');
	lines.push(' * Auto-generated by: dbsp introspect');
	if (options.sourceUrl) {
		const redactedUrl = redactDbUrl(options.sourceUrl);
		lines.push(` * Source: ${redactedUrl}`);
	}
	if (options.introspectedAt) {
		lines.push(` * Generated: ${options.introspectedAt.toISOString()}`);
	}
	lines.push(' *');
	if (options.warnings && options.warnings.length > 0) {
		lines.push(' * ⚠️ Warnings:');
		for (const warning of options.warnings) {
			lines.push(` *   - ${warning}`);
		}
	}
	lines.push(' * Review before using in production.');
	lines.push(' */');
	lines.push('');

	// ARCH-005: Check if any table has FKs to determine imports
	const hasForeignKeys = Array.from(model.tables.values()).some(
		(table) => table.foreignKeys.length > 0,
	);

	// Imports - ARCH-005: Use schema() + ref() instead of defineSchema()
	const coreImports = ['schema'];
	if (hasForeignKeys) {
		coreImports.push('ref');
	}
	lines.push(`import { ${coreImports.join(', ')} } from '@dbsp/core';`);
	if (options.dbCasing && options.dbCasing !== 'preserve') {
		lines.push("import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';");
	}
	lines.push('');

	// Schema definition - ARCH-005: Use schema() instead of defineSchema()
	lines.push('export const dbSchema = schema({');

	// Generate each table
	const tables = Array.from(model.tables.values());
	const tableLines = tables.map((table) => generateTableCode(table, options));
	lines.push(tableLines.join(',\n\n'));

	lines.push('});');
	lines.push('');

	// Usage hint with dbCasing
	if (options.dbCasing && options.dbCasing !== 'preserve') {
		lines.push('/**');
		lines.push(
			` * Usage: columns above are camelCase; the database uses ${options.dbCasing}.`,
		);
		lines.push(
			' * Pass dbCasing to the adapter so it maps camelCase ↔ snake_case automatically.',
		);
		lines.push(' *');
		lines.push(' * @example');
		lines.push(' * ```typescript');
		lines.push(' * const orm = createOrm({');
		lines.push(' *   model: dbSchema.model,');
		lines.push(
			` *   adapter: createPgsqlAdapter(pool, { dbCasing: '${options.dbCasing}' }),`,
		);
		lines.push(' * });');
		lines.push(' * ```');
		lines.push(' */');
		lines.push(`export const dbCasing = '${options.dbCasing}' as const;`);
		lines.push('');
	}

	return lines.join('\n');
}
