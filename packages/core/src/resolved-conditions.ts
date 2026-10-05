import {
	EXPRESSION_BRAND,
	type ExpressionIntent,
	isParamIntent,
	type ModelIR,
	type QueryIntent,
	type RangeAllocator,
	REF_BRAND,
	type ResolvedCast,
	type ResolvedColumnOperand,
	type ResolvedCondition,
	type ResolvedExpression,
	type ResolvedOrder,
	type ResolvedParameter,
	type ResolvedProjection,
	type ResolvedRange,
	type ResolvedRhs,
	type ResolvedSubqueryBody,
	type WhereIntent,
} from '@dbsp/types';
import {
	assertNoUnsupportedSubqueryModifiers,
	getTrustedNqlRelationFilterFields,
	isFieldRef,
	isSubqueryRef,
	resolveDeclaredRelationPath,
} from '@dbsp/types/internal';

function isExpression(value: unknown): value is { intent: ExpressionIntent } {
	return (
		value !== null && typeof value === 'object' && EXPRESSION_BRAND in value
	);
}
function isRef(value: unknown): value is { target: string } {
	return value !== null && typeof value === 'object' && REF_BRAND in value;
}

export const externalConditionRefusal =
	'Conditions with relation paths, outer references or subqueries compile only from a report planned in this process';

/** External reports may use only columns and expressions in their root range. */
export function conditionNeedsPlanning(value: unknown): boolean {
	if (!value || typeof value !== 'object' || isParamIntent(value)) return false;
	const node = value as Record<string, unknown>;
	if (
		[
			'exists',
			'notExists',
			'relationFilter',
			'rawExists',
			'rawNotExists',
			'subquery',
		].includes(String(node.kind)) ||
		node.outer === true ||
		(node.kind === 'fieldRef' && node.scope === 'outer')
	)
		return true;
	if (
		['field', 'column', 'target'].some(
			(key) =>
				typeof node[key] === 'string' && (node[key] as string).includes('.'),
		)
	)
		return true;
	if (node.subquery || node.query) return true;
	return Object.entries(node).some(([key, child]) =>
		!['value', 'values', 'pattern'].includes(key)
			? conditionNeedsPlanning(child)
			: key === 'value' &&
				child !== null &&
				typeof child === 'object' &&
				(EXPRESSION_BRAND in child ||
					REF_BRAND in child ||
					['ref', 'fieldRef'].includes(
						String((child as Record<string, unknown>).kind),
					)) &&
				conditionNeedsPlanning(child),
	);
}

/** One traversal, with one shared allocator and no reconstruction of ancestor name sets. */
export function resolveSelectWhere(
	where: WhereIntent | undefined,
	root: ResolvedRange,
	visible: readonly ResolvedRange[],
	allocator: RangeAllocator,
	model: ModelIR | undefined,
	initialAliasCount = 0,
	additionalOuterRanges: readonly ResolvedRange[] = [],
): ResolvedCondition | undefined {
	for (const range of [root, ...visible, ...additionalOuterRanges])
		allocator.reserve(range.alias);
	let aliasCount = initialAliasCount;
	const rawNext = new Map<string, number>();
	const expressionNext = new Map<string, number>();
	const utf8 = new TextEncoder();
	const truncate = (name: string, bytes: number) => {
		let out = '';
		let size = 0;
		for (const char of name) {
			size += utf8.encode(char).length;
			if (size > bytes) break;
			out += char;
		}
		return out;
	};
	const generated = (table: string, suffix: string) =>
		truncate(table, 63 - utf8.encode(suffix).length) + suffix;
	const activeNames = new Set(visible.map((r) => r.alias));
	let scopeIndex = 0;
	const column = (
		name: string,
		current: ResolvedRange,
		ranges: readonly ResolvedRange[],
		enclosing: readonly (readonly ResolvedRange[])[],
		outer = false,
	): ResolvedColumnOperand => {
		const parts = name.split('.');
		let range = current;
		if (outer) {
			if (!enclosing.length)
				throw new Error('outerRef() requires an enclosing query range.');
			range = enclosing[0]![0]!;
			if (parts.length > 1) {
				const qualifier = parts.shift()!;
				let found: ResolvedRange | undefined;
				for (const scope of enclosing) {
					const candidates = scope.filter((r) => r.table === qualifier);
					// A self-join makes the logical root name ambiguous even though its default alias matches.
					found = scope.find(
						(r) =>
							r.alias === qualifier &&
							(r !== scope[0] || r.alias !== r.table || candidates.length < 2),
					);
					if (found) break;
					if (candidates.length > 1)
						throw new Error(
							`outerRef qualifier '${qualifier}' is ambiguous between ${candidates
								.map((r) => `'${r.alias}'`)
								.sort()
								.join(', ')} in an enclosing query.`,
						);
					found = candidates[0];
					if (found) break;
				}
				if (!found)
					throw new Error(
						`outerRef qualifier '${qualifier}' is not visible in an enclosing query.`,
					);
				range = found;
			}
		} else if (parts.length > 1) {
			const qualifier = parts.shift()!;
			const candidates = ranges.filter((r) => r.table === qualifier);
			const exact = ranges.find(
				(r) =>
					r.alias === qualifier &&
					(r !== ranges[0] || r.alias !== r.table || candidates.length < 2),
			);
			if (exact) range = exact;
			else if (candidates.length > 1)
				throw new Error(
					`WHERE qualifier '${qualifier}' is ambiguous between ${candidates
						.map((r) => `'${r.alias}'`)
						.sort()
						.join(', ')}.`,
				);
			else if (candidates[0]) range = candidates[0];
			else
				throw new Error(
					`WHERE qualifier '${qualifier}' is not visible in this query.`,
				);
		}
		return {
			kind: outer ? 'outerRef' : 'column',
			range,
			column: parts.join('.'),
		};
	};
	const pathFor = (
		source: ResolvedRange,
		segments: readonly string[],
		kind: string,
	) => {
		if (segments.length > 10)
			throw new Error(
				`Dotted relation path exceeds the maximum depth of 10 hops: "${segments.join('.')}…".`,
			);
		if (!model)
			throw new Error(
				`${kind}('${segments.join('.')}'): cannot resolve relation '${segments.join('.')}' — no model configured. Use rawExists(subquery(...)) for an uncorrelated or undeclared subquery.`,
			);
		let table = source.table;
		const names: string[] = [];
		for (const segment of segments) {
			const rel =
				model.getRelation(`${table}.${segment}`) ??
				(() => {
					const matches = model
						.getRelationsFrom(table)
						.filter((r) => r.target === segment);
					return matches.length === 1 ? matches[0] : undefined;
				})();
			if (!rel)
				throw new Error(
					kind === 'relationFilter'
						? segments.length === 1
							? `relationFilter('${segment}'): no relation '${segment}' declared on table '${table}'. Use rawExists(subquery(...)) for an uncorrelated or undeclared subquery.`
							: `relationFilter(${JSON.stringify(segments)}): no relation '${segment}' declared on table '${table}'. Use rawExists(subquery(...)) for an uncorrelated or undeclared subquery.`
						: `${kind}('${segments.join('.')}'): no relation '${segment}' is declared on table '${table}'. Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.`,
				);
			if (rel.type === 'belongsToMany')
				throw new Error(
					`WHERE ${kind}('${segments.join('.')}'): many-to-many traversal is not supported yet (#787).`,
				);
			names.push(rel.name);
			table = rel.target;
		}
		const path = resolveDeclaredRelationPath(model, source.table, names);
		if (!path.ok)
			throw new Error(`Unresolved condition relation '${segments.join('.')}'`);
		return path;
	};
	function body<U extends 'exists' | 'in' | 'scalar'>(
		query: QueryIntent,
		use: U,
		ranges: readonly ResolvedRange[],
		enclosing: readonly (readonly ResolvedRange[])[],
		isExpressionBody = false,
	): Extract<ResolvedSubqueryBody, { use: U }> {
		if (!isExpressionBody)
			assertNoUnsupportedSubqueryModifiers(
				query,
				use === 'exists' ? 'rawExists' : use === 'in' ? 'IN' : 'scalar',
			);
		else assertNoUnsupportedSubqueryModifiers(query, 'scalar');
		let alias: string;
		const expressionPrior = expressionNext.get(query.from) ?? 0;
		if (isExpressionBody) {
			let next = expressionPrior;
			const candidate = () =>
				next === 0
					? query.from
					: generated(query.from, next === 1 ? '_sq' : `_sq_${next - 1}`);
			alias = candidate();
			while (activeNames.has(alias) || allocator.hasReserved(alias)) {
				next++;
				alias = candidate();
			}
			expressionNext.set(query.from, next + 1);
		} else if (use === 'exists') {
			let next = rawNext.get(query.from) ?? 0;
			const candidate = () =>
				generated(query.from, next === 0 ? '_sq' : `_sq_${next}`);
			alias = candidate();
			while (allocator.hasReserved(alias) || activeNames.has(alias)) {
				next++;
				alias = candidate();
			}
			rawNext.set(query.from, next + 1);
		} else alias = generated(query.from, `_subq_${aliasCount++}`);
		const range = allocator.allocate(
			query.from,
			alias,
			`where-body-${scopeIndex++}`,
		);
		if (!isExpressionBody) allocator.reserve(range.alias);
		activeNames.add(range.alias);
		const innerEnclosing = [
			ranges === visible ? [...ranges, ...additionalOuterRanges] : ranges,
			...enclosing,
		];
		const where = query.where
			? visit(query.where, range, [range], innerEnclosing)
			: undefined;
		const columnProjection = (name: string): ResolvedColumnOperand =>
			column(name, range, [range], innerEnclosing);
		const select = query.select;
		let projection: ResolvedProjection =
			use === 'exists'
				? { kind: 'expression', expression: { kind: 'literal', value: 1 } }
				: { kind: 'column', operand: columnProjection('*') };
		if (select?.type === 'fields' && select.fields[0])
			projection = {
				kind: 'column',
				operand: columnProjection(select.fields[0]),
			};
		else if (select?.type === 'aggregate' && select.aggregates[0]) {
			const agg = select.aggregates[0];
			projection = {
				kind: 'aggregate',
				function: agg.function,
				argument:
					!agg.field || agg.field === '*' ? '*' : columnProjection(agg.field),
				distinct: agg.distinct === true,
			};
		} else if (select?.type === 'expressions' && use !== 'exists')
			throw new Error('Resolved scalar subquery requires a single projection');
		if (
			select?.type === 'aggregate' &&
			use === 'exists' &&
			select.aggregates.length > 1
		) {
			projection = {
				kind: 'list',
				projections: select.aggregates.map((agg) => ({
					kind: 'aggregate',
					function: agg.function,
					argument:
						!agg.field || agg.field === '*' ? '*' : columnProjection(agg.field),
					distinct: agg.distinct === true,
				})),
			};
		}
		if (
			!isExpressionBody &&
			use === 'scalar' &&
			(!select || select.type === 'all')
		)
			projection = {
				kind: 'expression',
				expression: { kind: 'literal', value: 1 },
			};
		const orderBy: ResolvedOrder[] = (query.orderBy ?? []).map((o) => ({
			expression:
				'field' in o
					? { kind: 'ref', operand: columnProjection(o.field) }
					: expression(o.expression, range, [range], innerEnclosing),
			direction: o.direction ?? 'asc',
			// Expression-body ORDER BY already emits explicit null placement. Legacy
			// predicate-body ordering uses database defaults; preserve that output.
			...(isExpressionBody && o.nulls && { nulls: o.nulls }),
		}));
		activeNames.delete(range.alias);
		if (isExpressionBody) expressionNext.set(query.from, expressionPrior);
		const result: ResolvedSubqueryBody =
			use === 'exists'
				? {
						use: 'exists',
						range,
						...(select && { select: projection }),
						...(where && { where }),
					}
				: use === 'in'
					? {
							use: 'in',
							range,
							select:
								projection.kind === 'column'
									? projection.operand
									: columnProjection('*'),
							orderBy,
							...(where && { where }),
							...(query.limit !== undefined && {
								limit:
									typeof query.limit === 'number'
										? query.limit
										: parameter(query.limit),
							}),
						}
					: {
							use: 'scalar',
							range,
							select: projection,
							orderBy,
							...(where && { where }),
							...(query.limit !== undefined && {
								limit:
									typeof query.limit === 'number'
										? query.limit
										: parameter(query.limit),
							}),
						};
		return result as Extract<ResolvedSubqueryBody, { use: U }>;
	}
	const relation = (
		node: WhereIntent,
		source: ResolvedRange,
		ranges: readonly ResolvedRange[],
		enclosing: readonly (readonly ResolvedRange[])[],
		segments: readonly string[],
		nested?: WhereIntent,
		dotted?: { node: WhereIntent; field: string },
	): ResolvedCondition => {
		const trusted = getTrustedNqlRelationFilterFields(node);
		if (
			('recursive' in node && node.recursive !== undefined) ||
			trusted?.recursive
		)
			throw new Error(
				`WHERE ${node.kind}('${segments.join('.')}'): recursive relation predicates are not supported inside WHERE.`,
			);
		const path = trusted
			? {
					ok: true as const,
					logicalSegments: segments,
					relations: [],
					targetTable: trusted.targetTable,
					hops: trusted.hops.length
						? trusted.hops.map((hop, i) => ({
								segmentIndex: i,
								fromTable: i === 0 ? source.table : trusted.hops[i - 1]!.target,
								toTable: hop.target,
								pairs: hop.joinColumn.map((fromColumn, j) => ({
									fromColumn,
									toColumn: hop.fkColumn[j]!,
								})),
							}))
						: [
								{
									segmentIndex: 0,
									fromTable: source.table,
									toTable: trusted.targetTable,
									pairs: trusted.sourceColumn.map((fromColumn, i) => ({
										fromColumn,
										toColumn: trusted.targetColumn[i]!,
									})),
								},
							],
				}
			: pathFor(source, segments, node.kind);
		const mode =
			node.kind === 'notExists'
				? 'none'
				: node.kind === 'relationFilter'
					? node.mode
					: 'some';
		const vacuous =
			mode === 'every' &&
			(!nested || (nested.kind === 'and' && nested.conditions.length === 0));
		let from = source;
		const hopRanges = path.hops.map((hop) => {
			let alias = generated(hop.toTable, `_exists_${aliasCount++}`);
			while (allocator.hasReserved(alias))
				alias = generated(hop.toTable, `_exists_${aliasCount++}`);
			const to = allocator.allocate(
				hop.toTable,
				alias,
				`where-relation-${scopeIndex++}`,
			);
			allocator.reserve(to.alias);
			const result = { from, to };
			from = to;
			return result;
		});
		const target = from;
		const includes: Extract<
			ResolvedCondition,
			{ kind: 'relation' }
		>['joins'][number][] = [];
		if ('include' in node && node.include) {
			for (const [name, options] of Object.entries(node.include)) {
				let includeSource = target;
				for (const prior of includes)
					if (model?.getRelation(`${prior.range.table}.${name}`)) {
						includeSource = prior.range;
						break;
					}
				const includePath = pathFor(includeSource, [name], 'include');
				const range = allocator.allocate(
					includePath.targetTable,
					name,
					`where-include-${scopeIndex++}`,
				);
				allocator.reserve(range.alias);
				includes.push({
					path: includePath,
					source: includeSource,
					range,
					type: options.join ?? 'inner',
				});
			}
		}
		const innerRanges = [target, ...includes.map((i) => i.range)];
		return {
			kind: 'relation',
			path,
			quantifier: mode,
			source,
			hops: hopRanges,
			target,
			vacuous,
			joins: includes,
			...(!vacuous &&
				(nested || dotted) && {
					predicate: dotted
						? visit(
								dotted.node,
								target,
								innerRanges,
								[ranges, ...enclosing],
								dotted.field,
							)
						: visit(nested!, target, innerRanges, [ranges, ...enclosing]),
				}),
		};
	};
	const expression = (
		input: ExpressionIntent,
		current: ResolvedRange,
		ranges: readonly ResolvedRange[],
		enclosing: readonly (readonly ResolvedRange[])[],
	): ResolvedExpression => {
		const ref = (name: string): ResolvedExpression => ({
			kind: 'ref',
			operand: column(name, current, ranges, enclosing),
		});
		const expr = (value: ExpressionIntent) =>
			expression(value, current, ranges, enclosing);
		const arg = (
			value: unknown,
			stringsAreColumns = false,
		): ResolvedExpression => {
			if (isParamIntent(value))
				return { kind: 'parameter', value: value.value };
			if (isExpression(value)) return expr(value.intent);
			if (isRef(value)) return ref(value.target);
			if (value !== null && typeof value === 'object' && 'kind' in value)
				return expr(value as ExpressionIntent);
			return stringsAreColumns && typeof value === 'string'
				? ref(value)
				: { kind: 'parameter', value };
		};
		const caseValue = (value: unknown): ResolvedExpression => {
			if (value == null) return { kind: 'literal', value: null };
			if (typeof value === 'string') return ref(value);
			if (
				value &&
				typeof value === 'object' &&
				'kind' in value &&
				value.kind === 'literal' &&
				'value' in value
			) {
				const literal = value;
				return typeof literal.value === 'string'
					? { kind: 'parameter', value: literal.value }
					: { kind: 'literal', value: literal.value };
			}
			return arg(value);
		};
		switch (input.kind) {
			case 'ref':
				return {
					kind: 'ref',
					operand: column(
						input.column,
						current,
						ranges,
						enclosing,
						'outer' in input && input.outer === true,
					),
				};
			case 'column':
			case 'columnAlias':
				return ref(input.column);
			case 'relationColumn':
				return ref(`${input.relation}.${input.column}`);
			case 'param':
				return { kind: 'parameter', value: input.value };
			case 'literal':
				return { kind: 'literal', value: input.value };
			case 'raw':
				throw new Error(
					"compileExpressionIntent: unsupported expression kind 'raw'",
				);
			case 'star':
				return { kind: 'star' };
			case 'subquery':
				return {
					kind: 'subquery',
					body: body(input.query, 'scalar', ranges, enclosing, true),
				};
			case 'cast':
				return {
					kind: 'cast',
					expression: expr(input.expr),
					typeName: input.typeName,
				};
			case 'namedArg':
				return { kind: 'namedArg', name: input.name, value: expr(input.value) };
			case 'array':
				return { kind: 'array', elements: input.elements.map(expr) };
			case 'unary':
				return {
					kind: 'operator',
					syntax: 'unary',
					operator: input.operator,
					operands: [expr(input.operand)],
				};
			case 'customOp':
				return {
					kind: 'operator',
					syntax: 'custom',
					operator: input.operator,
					operands: [
						input.operator === '@@@' && input.left.kind === 'ref'
							? {
									kind: 'wholeRow',
									range: column(
										input.left.column + '.*',
										current,
										ranges,
										enclosing,
									).range,
								}
							: expr(input.left),
						expr(input.right),
					],
				};
			case 'arithmetic':
				return {
					kind: 'operator',
					syntax: 'arithmetic',
					operator: input.operator,
					operands: [arg(input.left, true), arg(input.right, true)],
				};
			case 'comparison':
				return {
					kind: 'operator',
					syntax: 'comparison',
					operator: input.operator,
					operands: [ref(input.column), arg(input.value)],
				};
			case 'coalesce':
				return { kind: 'call', name: 'coalesce', args: input.fields.map(ref) };
			case 'function':
				return {
					kind: 'call',
					name: input.name,
					args: input.args.map((v) => arg(v, true)),
				};
			case 'customFn':
				return {
					kind: 'call',
					name: input.name,
					args: input.args.map(expr),
					...(input.distinct !== undefined && { distinct: input.distinct }),
					...(input.filter && {
						filter: visit(input.filter, current, ranges, enclosing),
					}),
					...(input.aggOrderBy && {
						orderBy: input.aggOrderBy.map((o) => ({
							expression: ref(o.field),
							direction: o.direction,
						})),
					}),
				};
			case 'aggregate':
				return {
					kind: 'call',
					name: input.function.toLowerCase(),
					args: [
						input.field === '*' ? { kind: 'star' } : ref(input.field),
						...(input.extraArgs ?? []).map((v) => arg(v)),
					],
					...(input.distinct !== undefined && { distinct: input.distinct }),
					...(input.filter && {
						filter: visit(input.filter, current, ranges, enclosing),
					}),
				};
			case 'case':
				return {
					kind: 'case',
					branches: input.when.map((b) => ({
						condition: visit(b.condition, current, ranges, enclosing),
						result: caseValue(b.result),
					})),
					...(input.else !== undefined && { fallback: caseValue(input.else) }),
				};
			default:
				throw new Error(
					`compileExpressionIntent: unsupported expression kind '${input.kind}'`,
				);
		}
	};
	const parameter = (
		value: unknown,
		cast: ResolvedCast = 'none',
	): ResolvedParameter => ({
		kind: 'parameter',
		value: isParamIntent(value) ? value.value : value,
		cast,
		bound: isParamIntent(value),
	});
	const rangeParameter = (value: unknown): ResolvedParameter => {
		const authored = parameter(value, 'range');
		if (authored.bound) return authored;
		if (
			value !== null &&
			typeof value === 'object' &&
			('lower' in value || 'upper' in value)
		) {
			const range = value as { lower?: unknown; upper?: unknown };
			return {
				...authored,
				value: `[${range.lower ?? ''},${range.upper ?? ''})`,
			};
		}
		if (typeof value === 'string' && /^\[.*,.*[)\]]$/.test(value))
			return authored;
		return { ...authored, cast: 'range-element' };
	};

	const normalizeList = (value: unknown): unknown => {
		if (isParamIntent(value)) return value;
		if (!Array.isArray(value)) return value;
		if (
			value.length === 1 &&
			isParamIntent(value[0]) &&
			Array.isArray(value[0].value)
		)
			return value[0];
		return value.map((v) => (isParamIntent(v) ? v.value : v));
	};
	const visit = (
		node: WhereIntent,
		current: ResolvedRange,
		ranges: readonly ResolvedRange[],
		enclosing: readonly (readonly ResolvedRange[])[],
		fieldOverride?: string,
	): ResolvedCondition => {
		if (node.kind === 'and' || node.kind === 'or')
			return {
				kind: node.kind,
				conditions: node.conditions.map((c) =>
					visit(c, current, ranges, enclosing),
				),
			};
		if (node.kind === 'not')
			return {
				kind: 'not',
				condition: visit(node.condition, current, ranges, enclosing),
			};
		if (
			node.kind === 'exists' ||
			node.kind === 'notExists' ||
			node.kind === 'relationFilter'
		) {
			const name =
				getTrustedNqlRelationFilterFields(node)?.relation ?? node.relation;
			return relation(
				node,
				current,
				ranges,
				enclosing,
				typeof name === 'string' ? name.split('.') : name,
				node.where,
			);
		}
		if (
			fieldOverride === undefined &&
			'field' in node &&
			node.field.includes('.')
		) {
			const parts = node.field.split('.');
			const qualifier = parts[0]!;
			const candidates = ranges.filter((r) => r.table === qualifier);
			const exact = ranges.find(
				(r) =>
					r.alias === qualifier &&
					(r !== ranges[0] || r.alias !== r.table || candidates.length < 2),
			);
			if (!exact && candidates.length > 1)
				column(node.field, current, ranges, enclosing);
			const source = exact ?? candidates[0] ?? current;
			if (exact || candidates.length) parts.shift();
			if (parts.length > 1) {
				const field = parts.pop()!;
				return relation(
					{ kind: 'exists', relation: parts.join('.') },
					source,
					ranges,
					enclosing,
					parts,
					undefined,
					{ node, field },
				);
			}
		}
		const left = () => {
			if (!('field' in node)) throw new Error('Condition requires a column');
			return column(fieldOverride ?? node.field, current, ranges, enclosing);
		};
		const rhs = (value: unknown, cast: ResolvedCast): ResolvedRhs => {
			if (isParamIntent(value)) return parameter(value, cast);
			if (isFieldRef(value))
				return column(
					value.alias ? `${value.alias}.${value.column}` : value.column,
					current,
					ranges,
					enclosing,
					value.scope === 'outer',
				);
			if (isRef(value)) return column(value.target, current, ranges, enclosing);
			if (isExpression(value))
				return expression(value.intent, current, ranges, enclosing);
			if (isSubqueryRef(value))
				return column(
					value.column,
					current,
					ranges,
					enclosing,
					value.outer === true,
				);
			return parameter(value, cast);
		};
		switch (node.kind) {
			case 'comparison':
				return {
					kind: 'comparison',
					left: left(),
					operator: node.operator,
					right: rhs(node.value, node.jsonPath ? 'none' : 'column-db-type'),
					...(node.jsonPath && {
						jsonPath: node.jsonPath.map((v) => parameter(v)),
					}),
					...(node.jsonMode && { jsonMode: node.jsonMode }),
				};
			case 'like':
				return {
					kind: 'like',
					left: left(),
					pattern: parameter(node.pattern),
					caseInsensitive: node.caseInsensitive === true,
					...(node.escape !== undefined && { escape: parameter(node.escape) }),
				};
			case 'in':
				return {
					kind: 'in',
					left: left(),
					negated: node.not === true,
					operand: node.subquery
						? {
								kind: 'subquery',
								body: body(node.subquery, 'in', ranges, enclosing),
							}
						: {
								kind: 'values',
								parameter: parameter(
									normalizeList(node.values),
									'column-array',
								),
							},
				};
			case 'any':
				return {
					kind: 'any',
					left: left(),
					values: parameter(node.values, 'any-array'),
				};
			case 'null':
				return { kind: 'null', left: left(), operator: node.operator };
			case 'range':
				return {
					kind: 'range',
					left: left(),
					operator: node.operator,
					value:
						node.operator === 'between'
							? parameter(node.value)
							: rangeParameter(node.value),
				};
			case 'jsonContains':
				return {
					kind: 'jsonContains',
					left: left(),
					value: parameter(node.value),
					reversed: node.reversed,
				};
			case 'jsonExists':
				return { kind: 'jsonExists', left: left(), key: parameter(node.key) };
			case 'rawExists':
			case 'rawNotExists':
				return {
					kind: 'subquery',
					use: 'exists',
					negated: node.kind === 'rawNotExists',
					body: body(node.subquery, 'exists', ranges, enclosing),
				};
			case 'subquery':
				return {
					kind: 'subquery',
					use: 'scalar',
					left: left(),
					operator: node.operator,
					body: body(node.subquery, 'scalar', ranges, enclosing),
				};
			case 'expression':
				return {
					kind: 'expression',
					expression: expression(node.expr, current, ranges, enclosing),
					...(node.operator !== undefined && {
						comparison: {
							operator: node.operator,
							right: rhs(node.value, 'none'),
						},
					}),
				};
		}
	};
	return where ? visit(where, root, visible, []) : undefined;
}
