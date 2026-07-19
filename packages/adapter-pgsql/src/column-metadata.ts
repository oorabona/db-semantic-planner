import type {
	ColumnIR,
	CompiledColumnMetadata,
	ModelIR,
	TableIR,
} from '@dbsp/types';
import type { Node } from '@pgsql/types';
import type { NamingPlugin } from './naming-plugin.js';

type ProjectionSource = {
	readonly table: string;
	readonly column: ColumnIR;
};

type ProjectionCandidate = {
	readonly metadata?: CompiledColumnMetadata;
};

type AliasContext = {
	readonly aliases: ReadonlyMap<string, string>;
	readonly visibleTables: readonly string[];
};

function hasTableMap(model: ModelIR): boolean {
	const tables = (model as { tables?: unknown }).tables;
	return (
		tables !== null &&
		typeof tables === 'object' &&
		typeof (tables as { values?: unknown }).values === 'function'
	);
}

function recordTableLookup(
	model: ModelIR,
	naming: NamingPlugin,
): Map<string, string> {
	const lookup = new Map<string, string>();
	for (const table of model.tables.values()) {
		lookup.set(table.name, table.name);
		lookup.set(naming.toDatabase(table.name), table.name);
	}
	return lookup;
}

function addVisibleTable(
	aliases: Map<string, string>,
	visibleTables: string[],
	key: string,
	table: string,
): void {
	aliases.set(key, table);
	if (!visibleTables.includes(table)) visibleTables.push(table);
}

function collectAliasesFromRange(
	node: unknown,
	tableLookup: ReadonlyMap<string, string>,
	cteNames: ReadonlySet<string>,
	aliases: Map<string, string>,
	visibleTables: string[],
): void {
	if (node === null || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const item of node) {
			collectAliasesFromRange(
				item,
				tableLookup,
				cteNames,
				aliases,
				visibleTables,
			);
		}
		return;
	}

	const record = node as Record<string, unknown>;
	const rangeVar = record.RangeVar as
		| {
				relname?: unknown;
				alias?: { aliasname?: unknown };
		  }
		| undefined;
	if (rangeVar) {
		const relname =
			typeof rangeVar.relname === 'string' ? rangeVar.relname : undefined;
		if (relname && cteNames.has(relname)) return;
		const table = relname ? tableLookup.get(relname) : undefined;
		if (!table || !relname) return;
		addVisibleTable(aliases, visibleTables, relname, table);
		const aliasName =
			typeof rangeVar.alias?.aliasname === 'string'
				? rangeVar.alias.aliasname
				: undefined;
		if (aliasName) addVisibleTable(aliases, visibleTables, aliasName, table);
		return;
	}

	const joinExpr = record.JoinExpr as
		| {
				larg?: unknown;
				rarg?: unknown;
		  }
		| undefined;
	if (joinExpr) {
		collectAliasesFromRange(
			joinExpr.larg,
			tableLookup,
			cteNames,
			aliases,
			visibleTables,
		);
		collectAliasesFromRange(
			joinExpr.rarg,
			tableLookup,
			cteNames,
			aliases,
			visibleTables,
		);
	}
}

function rangeReferencesTable(
	node: unknown,
	tableLookup: ReadonlyMap<string, string>,
	cteNames: ReadonlySet<string>,
	tableName: string,
): boolean {
	if (node === null || typeof node !== 'object') return false;
	if (Array.isArray(node)) {
		return node.some((item) =>
			rangeReferencesTable(item, tableLookup, cteNames, tableName),
		);
	}

	const record = node as Record<string, unknown>;
	const rangeVar = record.RangeVar as { relname?: unknown } | undefined;
	if (rangeVar) {
		const relname =
			typeof rangeVar.relname === 'string' ? rangeVar.relname : undefined;
		if (relname && cteNames.has(relname)) return false;
		return relname !== undefined && tableLookup.get(relname) === tableName;
	}

	const joinExpr = record.JoinExpr as
		| {
				larg?: unknown;
				rarg?: unknown;
		  }
		| undefined;
	if (joinExpr) {
		return (
			rangeReferencesTable(joinExpr.larg, tableLookup, cteNames, tableName) ||
			rangeReferencesTable(joinExpr.rarg, tableLookup, cteNames, tableName)
		);
	}

	return false;
}

function collectWithCteNames(ast: Node): ReadonlySet<string> {
	const selectStmt = (
		ast as { SelectStmt?: { withClause?: { ctes?: unknown } } }
	).SelectStmt;
	const ctes = selectStmt?.withClause?.ctes;
	if (!Array.isArray(ctes) || ctes.length === 0) return new Set();
	const names = new Set<string>();
	for (const cte of ctes) {
		const name = (cte as { CommonTableExpr?: { ctename?: unknown } })
			.CommonTableExpr?.ctename;
		if (typeof name === 'string') names.add(name);
	}
	return names;
}

function buildAliasContext(
	ast: Node,
	rootTable: string,
	model: ModelIR,
	naming: NamingPlugin,
): AliasContext {
	const tableLookup = recordTableLookup(model, naming);
	const cteNames = collectWithCteNames(ast);
	const aliases = new Map<string, string>();
	const visibleTables: string[] = [];

	const selectStmt = (ast as { SelectStmt?: { fromClause?: unknown } })
		.SelectStmt;
	const fromClause = selectStmt?.fromClause;
	const hasSelectFromClause =
		fromClause !== undefined &&
		(!Array.isArray(fromClause) || fromClause.length > 0);
	if (hasSelectFromClause) {
		collectAliasesFromRange(
			fromClause,
			tableLookup,
			cteNames,
			aliases,
			visibleTables,
		);
	}
	if (
		!hasSelectFromClause ||
		rangeReferencesTable(fromClause, tableLookup, cteNames, rootTable)
	) {
		addVisibleTable(aliases, visibleTables, rootTable, rootTable);
		addVisibleTable(
			aliases,
			visibleTables,
			naming.toDatabase(rootTable),
			rootTable,
		);
	}

	return { aliases, visibleTables };
}

function stringField(field: unknown): string | undefined {
	if (field === null || typeof field !== 'object') return undefined;
	const stringNode = (field as { String?: { sval?: unknown } }).String;
	return typeof stringNode?.sval === 'string' ? stringNode.sval : undefined;
}

function isStarField(field: unknown): boolean {
	return (
		field !== null &&
		typeof field === 'object' &&
		'A_Star' in (field as Record<string, unknown>)
	);
}

function columnRefFields(value: unknown): readonly unknown[] | undefined {
	if (value === null || typeof value !== 'object') return undefined;
	const columnRef = (value as { ColumnRef?: { fields?: unknown } }).ColumnRef;
	return Array.isArray(columnRef?.fields) ? columnRef.fields : undefined;
}

function findColumnByDbName(
	table: TableIR | undefined,
	dbColumn: string,
	naming: NamingPlugin,
): ColumnIR | undefined {
	if (!table) return undefined;
	return table.columns.find(
		(column) =>
			column.name === dbColumn || naming.toDatabase(column.name) === dbColumn,
	);
}

function resolveQualifiedColumn(
	qualifier: string,
	dbColumn: string,
	ctx: AliasContext,
	model: ModelIR,
	naming: NamingPlugin,
): ProjectionSource | 'ambiguous' | undefined {
	const tableName = ctx.aliases.get(qualifier);
	if (!tableName) return undefined;
	const table = model.getTable(tableName);
	const column = findColumnByDbName(table, dbColumn, naming);
	return column ? { table: tableName, column } : undefined;
}

function resolveUnqualifiedColumn(
	dbColumn: string,
	ctx: AliasContext,
	model: ModelIR,
	naming: NamingPlugin,
): ProjectionSource | 'ambiguous' | undefined {
	const matches: ProjectionSource[] = [];
	for (const tableName of ctx.visibleTables) {
		const table = model.getTable(tableName);
		const column = findColumnByDbName(table, dbColumn, naming);
		if (column) matches.push({ table: tableName, column });
	}
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) return 'ambiguous';
	return undefined;
}

function metadataForSource(
	source: ProjectionSource,
): CompiledColumnMetadata | undefined {
	if (source.column.js === undefined) return undefined;
	if (source.column.type !== 'bigint') return undefined;
	return {
		table: source.table,
		column: source.column.name,
		js: source.column.js,
	};
}

function addCandidate(
	candidates: Map<string, ProjectionCandidate[]>,
	outputKey: string,
	metadata?: CompiledColumnMetadata,
): void {
	const entries = candidates.get(outputKey) ?? [];
	entries.push(metadata ? { metadata } : {});
	candidates.set(outputKey, entries);
}

function addColumnCandidate(
	candidates: Map<string, ProjectionCandidate[]>,
	outputKey: string,
	source: ProjectionSource | 'ambiguous' | undefined,
): void {
	if (source === 'ambiguous' || source === undefined) {
		addCandidate(candidates, outputKey);
		return;
	}
	addCandidate(candidates, outputKey, metadataForSource(source));
}

function expandStar(
	candidates: Map<string, ProjectionCandidate[]>,
	qualifier: string | undefined,
	ctx: AliasContext,
	model: ModelIR,
	naming: NamingPlugin,
): void {
	const tableNames = qualifier
		? [...new Set([ctx.aliases.get(qualifier)].filter(Boolean) as string[])]
		: ctx.visibleTables;
	for (const tableName of tableNames) {
		const table = model.getTable(tableName);
		if (!table) continue;
		for (const column of table.columns) {
			addCandidate(
				candidates,
				naming.toDatabase(column.name),
				metadataForSource({ table: tableName, column }),
			);
		}
	}
}

function addTargetCandidates(
	target: unknown,
	candidates: Map<string, ProjectionCandidate[]>,
	ctx: AliasContext,
	model: ModelIR,
	naming: NamingPlugin,
): void {
	const resTarget = (
		target as { ResTarget?: { val?: unknown; name?: unknown } }
	).ResTarget;
	const value = resTarget ? resTarget.val : target;
	const outputAlias =
		typeof resTarget?.name === 'string' ? resTarget.name : undefined;
	const fields = columnRefFields(value);
	if (!fields) {
		if (outputAlias) addCandidate(candidates, outputAlias);
		return;
	}

	const last = fields[fields.length - 1];
	if (isStarField(last)) {
		const qualifier =
			fields.length >= 2 ? stringField(fields[fields.length - 2]) : undefined;
		if (outputAlias) {
			addCandidate(candidates, outputAlias);
			return;
		}
		expandStar(candidates, qualifier, ctx, model, naming);
		return;
	}

	const dbColumn = stringField(last);
	if (!dbColumn) {
		if (outputAlias) addCandidate(candidates, outputAlias);
		return;
	}
	const qualifier =
		fields.length >= 2 ? stringField(fields[fields.length - 2]) : undefined;
	const source = qualifier
		? resolveQualifiedColumn(qualifier, dbColumn, ctx, model, naming)
		: resolveUnqualifiedColumn(dbColumn, ctx, model, naming);
	addColumnCandidate(candidates, outputAlias ?? dbColumn, source);
}

function finalizeMetadata(
	candidates: ReadonlyMap<string, readonly ProjectionCandidate[]>,
): ReadonlyMap<string, CompiledColumnMetadata> | undefined {
	const metadata = new Map<string, CompiledColumnMetadata>();
	for (const [outputKey, entries] of candidates) {
		if (entries.length !== 1) continue;
		const entry = entries[0];
		if (entry?.metadata) metadata.set(outputKey, entry.metadata);
	}
	return metadata.size > 0 ? metadata : undefined;
}

function targetListForAst(ast: Node): readonly unknown[] | undefined {
	const record = ast as {
		SelectStmt?: { targetList?: unknown };
		InsertStmt?: { returningList?: unknown };
		UpdateStmt?: { returningList?: unknown };
		DeleteStmt?: { returningList?: unknown };
	};
	const targetList =
		record.SelectStmt?.targetList ??
		record.InsertStmt?.returningList ??
		record.UpdateStmt?.returningList ??
		record.DeleteStmt?.returningList;
	return Array.isArray(targetList) ? targetList : undefined;
}

export function buildCompiledColumnMetadata(
	ast: Node,
	rootTable: string,
	model: ModelIR | undefined,
	naming: NamingPlugin,
): ReadonlyMap<string, CompiledColumnMetadata> | undefined {
	if (!model || !hasTableMap(model)) return undefined;
	const targets = targetListForAst(ast);
	if (!targets || targets.length === 0) return undefined;
	const ctx = buildAliasContext(ast, rootTable, model, naming);
	const candidates = new Map<string, ProjectionCandidate[]>();
	for (const target of targets) {
		addTargetCandidates(target, candidates, ctx, model, naming);
	}
	return finalizeMetadata(candidates);
}
