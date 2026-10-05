import type { ResolvedRelationPath } from './declared-relation-path.js';
import type {
	IncludeIntent,
	IncludeRecursiveOptions,
	WhereIntent,
} from './intent-ast.js';
import type { RelationType } from './model-ir.js';
import type { ResolvedIncludeStrategy } from './planner.js';

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
	private nextId = 0;
	private readonly scopedNames = new Map<string, Set<string>>();
	constructor(reserved: readonly string[] = []) {
		this.names = new Set(reserved);
	}
	reserve(alias: string): void {
		this.names.add(alias);
	}
	allocate(
		table: string,
		preferredAlias: string,
		scope = 'query',
	): ResolvedRange {
		const names = this.scopedNames.get(scope) ?? new Set<string>();
		this.scopedNames.set(scope, names);
		let alias = preferredAlias;
		for (let suffix = 1; this.names.has(alias) || names.has(alias); suffix++)
			alias = `${preferredAlias}_${suffix}`;
		names.add(alias);
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
	readonly rootRange: ResolvedRange;
	/** Ordered joins: each ON sees the root, every join at a lower index, and itself. */
	readonly joins: readonly ResolvedJoin[];
	readonly includes: readonly ResolvedIncludeNode[];
}
