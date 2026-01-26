/**
 * CLI-DDL: Schema Codegen Module
 *
 * Generates TypeScript schema files from IntrospectedModelIR.
 * Used by `dbsp introspect` to create dbsp.schema.ts from a database.
 */

import type { ModelIR, TableIR } from '@dbsp/core';

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
				isSelfRef?: boolean;
		  }
		| undefined,
	options: SchemaCodegenOptions,
): string {
	// ARCH-005: FK columns become ref() calls
	if (fkInfo) {
		return generateRefCode(column, fkInfo, options);
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
		const defaultStr =
			typeof column.default === 'string'
				? `'${column.default}'`
				: String(column.default);
		props.push(`default: ${defaultStr}`);
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
		isSelfRef?: boolean;
	},
	options: SchemaCodegenOptions,
): string {
	const refOptions: string[] = [];

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
		refOptions.push(`onDelete: '${fkInfo.onDelete}'`);
	}

	// Self-referential FK needs roles
	if (fkInfo.isSelfRef) {
		// Infer role names from column name
		// e.g., 'parentId' → parent: 'parent', children: 'children'
		const baseName = column.name.replace(/Id$/, '');
		refOptions.push(
			`roles: { parent: '${baseName}', children: '${baseName === 'parent' ? 'children' : baseName + 's'}' }`,
		);
	}

	// Build the ref() call
	let code: string;
	if (refOptions.length === 0) {
		code = `ref('${fkInfo.table}')`;
	} else {
		code = `ref('${fkInfo.table}', { ${refOptions.join(', ')} })`;
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
			const colDef = table.columns.find((c) => c.name === localCol);

			const entry: {
				table: string;
				column?: string;
				nullable?: boolean;
				unique?: boolean;
				onDelete?: string;
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

			fkMap.set(localCol, entry);
		}
	}

	const columnLines = table.columns.map((col) => {
		const isPrimaryKey =
			typeof table.primaryKey === 'string'
				? col.name === table.primaryKey
				: table.primaryKey.includes(col.name);
		const fkInfo = fkMap.get(col.name);
		const code = generateColumnCode(col, isPrimaryKey, fkInfo, options);
		return `\t\t${col.name}: ${code}`;
	});

	return `\t${table.name}: {\n${columnLines.join(',\n')},\n\t}`;
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
		// Redact password in URL
		const redactedUrl = options.sourceUrl.replace(/:[^:@]+@/, ':***@');
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
	if (hasForeignKeys) {
		lines.push("import { schema, ref } from '@dbsp/core';");
	} else {
		lines.push("import { schema } from '@dbsp/core';");
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

	return lines.join('\n');
}
