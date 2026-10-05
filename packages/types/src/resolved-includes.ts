import type { ResolvedRelationPath } from './declared-relation-path.js';
import type {
	IncludeIntent,
	IncludeRecursiveOptions,
	WhereIntent,
} from './intent-ast.js';
import type { RelationType } from './model-ir.js';
import { getNamingPluginForDbCasing } from './naming-plugin.js';
import type { ResolvedIncludeStrategy } from './planner.js';
import type { ResolvedCondition } from './resolved-conditions.js';

/** Identity of a query range, independent of table identity. */
export type RangeId = string & { readonly __rangeId: unique symbol };
export interface ResolvedRange {
	readonly id: RangeId;
	readonly table: string;
	readonly alias: string;
}
/**
 * One allocator for root, explicit joins, includes and recursive ranges.
 * Reserved names and range ids are unique across the query. Aliases are unique
 * within each SQL scope and may be reused across scalar subquery scopes.
 */
export class RangeAllocator {
	private readonly names: Set<string>;
	private readonly tableSpellings = new Map<string, Set<string>>();
	private nextId = 0;
	private nameWork = 0;
	get namesScanned(): number {
		return this.nameWork;
	}
	// A written logical table name can be reused beneath an aliased range of that
	// same table. Generated names consult every table spelling; bound aliases
	// remain reserved in both cases.
	hasReserved(alias: string, ownTable?: string): boolean {
		this.nameWork++;
		return (
			this.names.has(alias) ||
			[...(this.tableSpellings.get(alias) ?? [])].some(
				(table) => table !== ownTable,
			)
		);
	}
	private readonly scopedNames = new Map<string, Set<string>>();
	constructor(reserved: readonly string[] = []) {
		this.names = new Set(reserved);
		this.nameWork += reserved.length;
	}
	reserve(alias: string, table?: string): void {
		this.names.add(alias);
		this.nameWork++;
		if (table !== undefined) this.reserveTable(table);
	}
	private reserveTable(table: string): void {
		for (const casing of ['snake_case', 'camelCase', 'preserve'] as const) {
			const spelling = getNamingPluginForDbCasing(casing).toDatabase(table);
			const owners = this.tableSpellings.get(spelling) ?? new Set<string>();
			owners.add(table);
			this.tableSpellings.set(spelling, owners);
			this.nameWork++;
		}
	}
	/** Bind caller vocabulary verbatim; only the SQL scope can reject duplicates. */
	bind(table: string, alias: string, scope = 'query'): ResolvedRange {
		const names = this.scopedNames.get(scope) ?? new Set<string>();
		if (names.has(alias))
			throw new Error(`Query scope already binds qualifier '${alias}'.`);
		this.scopedNames.set(scope, names);
		names.add(alias);
		this.reserveTable(table);
		return { id: `r${this.nextId++}` as RangeId, table, alias };
	}
	/** Allocate generated vocabulary, avoiding bound names and table spellings. */
	allocate(
		table: string,
		preferredAlias: string,
		scope = 'query',
	): ResolvedRange {
		const names = this.scopedNames.get(scope) ?? new Set<string>();
		this.scopedNames.set(scope, names);
		let alias = preferredAlias;
		for (
			let suffix = 1;
			this.hasReserved(alias, alias === table ? table : undefined) ||
			names.has(alias);
			suffix++
		)
			alias = `${preferredAlias}_${suffix}`;
		names.add(alias);
		this.reserveTable(table);
		return { id: `r${this.nextId++}` as RangeId, table, alias };
	}
}
export interface ResolvedIncludeNode {
	readonly nodeId: string;
	readonly intentPath: string;
	readonly publicKey: string;
	readonly relationName: string;
	readonly relationPath: string;
	readonly path: ResolvedRelationPath;
	readonly sourceRange: ResolvedRange;
	readonly hopRanges: readonly {
		readonly from: ResolvedRange;
		readonly to: ResolvedRange;
	}[];
	readonly targetRange: ResolvedRange;
	readonly outputRange: ResolvedRange;
	readonly cteRange?: ResolvedRange;
	readonly relationType: RelationType;
	readonly cardinality: 'one' | 'many';
	readonly strategy: ResolvedIncludeStrategy;
	readonly joinType?: 'inner' | 'left';
	readonly outputMode: 'nested' | 'flat';
	/** Projection requests captured at planning, including root relation-column aliases. */
	readonly projectionRequests?: readonly {
		readonly col: string;
		readonly alias?: string;
		readonly defaultLabel?: boolean;
		readonly nqlLabel?: boolean;
	}[];
	readonly projection?: IncludeIntent['select'];
	readonly ordering: {
		readonly authored?: IncludeIntent['orderBy'];
		readonly fallback: readonly string[];
		readonly usesFallback: boolean;
	};
	readonly limit?: number;
	readonly recursion?: IncludeRecursiveOptions;
	readonly recursiveRanges?: {
		readonly walk: ResolvedRange;
		readonly next: ResolvedRange;
	};
	readonly predicate?: {
		readonly condition: WhereIntent;
		readonly currentRange: ResolvedRange;
		readonly outerRange: ResolvedRange;
	};
	readonly children: readonly ResolvedIncludeNode[];
}
/**
 * An explicit join resolved by the SELECT issuer.
 * Its ON sees the root, every join at a lower index in SelectExecution.joins, and itself.
 */
export interface ResolvedJoin {
	readonly intentPath: string;
	readonly intentIndex: number;
	readonly kind: 'relation' | 'table' | 'values';
	readonly type: 'inner' | 'left';
	readonly range: ResolvedRange;
	readonly sourceRange: ResolvedRange;
	readonly path?: ResolvedRelationPath;
	readonly on?: WhereIntent;
}
export interface SelectExecution {
	readonly where?: ResolvedCondition;
	readonly rootRange: ResolvedRange;
	/** Ordered joins: each ON sees the root, every join at a lower index, and itself. */
	readonly joins: readonly ResolvedJoin[];
	readonly includes: readonly ResolvedIncludeNode[];
}
