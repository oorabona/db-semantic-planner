import type {
	ColumnIR,
	ColumnJsReadType,
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
	readonly projection: ColumnMetadataProjection;
};

export type ColumnMetadataProjection =
	| {
			readonly kind: 'modelColumn';
			readonly table: string;
			readonly column: string;
			readonly js?: ColumnJsReadType;
	  }
	| { readonly kind: 'expression'; readonly reason: string }
	| { readonly kind: 'ambiguous'; readonly reason: string }
	| { readonly kind: 'unresolved'; readonly reason: string };

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

function projectionForSource(
	source: ProjectionSource,
): ColumnMetadataProjection {
	const js: ColumnJsReadType | undefined =
		source.column.type === 'bigint' ? source.column.js : undefined;
	return {
		kind: 'modelColumn',
		table: source.table,
		column: source.column.name,
		...(js !== undefined ? { js } : {}),
	};
}

function addCandidate(
	candidates: Map<string, ProjectionCandidate[]>,
	outputKey: string,
	projection: ColumnMetadataProjection,
): void {
	const entries = candidates.get(outputKey) ?? [];
	entries.push({ projection });
	candidates.set(outputKey, entries);
}

function addColumnCandidate(
	candidates: Map<string, ProjectionCandidate[]>,
	outputKey: string,
	source: ProjectionSource | 'ambiguous' | undefined,
): void {
	if (source === 'ambiguous') {
		addCandidate(candidates, outputKey, {
			kind: 'ambiguous',
			reason: 'projection column resolved to multiple visible model columns',
		});
		return;
	}
	if (source === undefined) {
		addCandidate(candidates, outputKey, {
			kind: 'unresolved',
			reason: 'projection column could not be resolved to a model column',
		});
		return;
	}
	addCandidate(candidates, outputKey, projectionForSource(source));
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
				projectionForSource({ table: tableName, column }),
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
		if (outputAlias) {
			addCandidate(candidates, outputAlias, {
				kind: 'expression',
				reason: 'projection expression has no model column provenance',
			});
		}
		return;
	}

	const last = fields[fields.length - 1];
	if (isStarField(last)) {
		const qualifier =
			fields.length >= 2 ? stringField(fields[fields.length - 2]) : undefined;
		if (outputAlias) {
			addCandidate(candidates, outputAlias, {
				kind: 'expression',
				reason: 'aliased star projection has no single model column provenance',
			});
			return;
		}
		expandStar(candidates, qualifier, ctx, model, naming);
		return;
	}

	const dbColumn = stringField(last);
	if (!dbColumn) {
		if (outputAlias) {
			addCandidate(candidates, outputAlias, {
				kind: 'unresolved',
				reason: 'projection column reference could not be read',
			});
		}
		return;
	}
	const qualifier =
		fields.length >= 2 ? stringField(fields[fields.length - 2]) : undefined;
	const source = qualifier
		? resolveQualifiedColumn(qualifier, dbColumn, ctx, model, naming)
		: resolveUnqualifiedColumn(dbColumn, ctx, model, naming);
	addColumnCandidate(candidates, outputAlias ?? dbColumn, source);
}

function finalizeProjections(
	candidates: ReadonlyMap<string, readonly ProjectionCandidate[]>,
): ReadonlyMap<string, ColumnMetadataProjection> | undefined {
	const projections = new Map<string, ColumnMetadataProjection>();
	for (const [outputKey, entries] of candidates) {
		if (entries.length !== 1) {
			projections.set(outputKey, {
				kind: 'ambiguous',
				reason: 'projection output key matched multiple sources',
			});
			continue;
		}
		const entry = entries[0];
		if (entry) projections.set(outputKey, entry.projection);
	}
	return projections.size > 0 ? projections : undefined;
}

function metadataForProjection(
	projection: ColumnMetadataProjection,
): CompiledColumnMetadata | undefined {
	if (projection.kind !== 'modelColumn' || projection.js === undefined) {
		return undefined;
	}
	return {
		table: projection.table,
		column: projection.column,
		js: projection.js,
	};
}

function metadataForProjections(
	projections: ReadonlyMap<string, ColumnMetadataProjection> | undefined,
): ReadonlyMap<string, CompiledColumnMetadata> | undefined {
	if (!projections || projections.size === 0) return undefined;
	const metadata = new Map<string, CompiledColumnMetadata>();
	for (const [outputKey, projection] of projections) {
		const entry = metadataForProjection(projection);
		if (entry) metadata.set(outputKey, entry);
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

export function buildCompiledColumnProjections(
	ast: Node,
	rootTable: string,
	model: ModelIR | undefined,
	naming: NamingPlugin,
): ReadonlyMap<string, ColumnMetadataProjection> | undefined {
	if (!model || !hasTableMap(model)) return undefined;
	const targets = targetListForAst(ast);
	if (!targets || targets.length === 0) return undefined;
	const ctx = buildAliasContext(ast, rootTable, model, naming);
	const candidates = new Map<string, ProjectionCandidate[]>();
	for (const target of targets) {
		addTargetCandidates(target, candidates, ctx, model, naming);
	}
	return finalizeProjections(candidates);
}

export function buildModelColumnProjections(
	tableName: string,
	columns: readonly string[],
	model: ModelIR,
	naming: NamingPlugin,
): ReadonlyMap<string, ColumnMetadataProjection> | undefined {
	if (typeof (model as { getTable?: unknown }).getTable !== 'function') {
		return undefined;
	}
	const table = model.getTable(tableName);
	if (!table) return undefined;
	const projections = new Map<string, ColumnMetadataProjection>();
	for (const columnName of columns) {
		const column = table.columns.find(
			(candidate) => candidate.name === columnName,
		);
		if (!column) continue;
		projections.set(
			naming.toDatabase(column.name),
			projectionForSource({ table: tableName, column }),
		);
	}
	return projections.size > 0 ? projections : undefined;
}

export function buildCompiledColumnMetadata(
	ast: Node,
	rootTable: string,
	model: ModelIR | undefined,
	naming: NamingPlugin,
): ReadonlyMap<string, CompiledColumnMetadata> | undefined {
	return metadataForProjections(
		buildCompiledColumnProjections(ast, rootTable, model, naming),
	);
}

export function metadataForModelColumns(
	tableName: string,
	columns: readonly string[],
	model: ModelIR,
	naming: NamingPlugin,
): ReadonlyMap<string, CompiledColumnMetadata> | undefined {
	return metadataForProjections(
		buildModelColumnProjections(tableName, columns, model, naming),
	);
}
