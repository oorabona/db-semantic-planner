import {
	EXPRESSION_BRAND,
	isParamIntent,
	type ModelIR,
	type QueryIntent,
} from '@dbsp/types';
import { getTrustedNqlRelationFilterFields } from '@dbsp/types/internal';
import type { DefaultFilters } from './schema.js';

/** Legacy read issuers do not carry resolved scan predicates yet. */
export function findDefaultFilterScan(
	intent: unknown,
	model: ModelIR,
	filters: DefaultFilters | undefined,
	path: string,
	skipRoot = false,
): { table: string; path: string } | undefined {
	if (!filters || !Object.keys(filters).length) return;
	const root = intent as QueryIntent;
	let found: { table: string; path: string } | undefined;
	const refuse = (table: string, location: string): void => {
		if (filters[table] && !found) found = { table, path: location };
	};
	const visit = (value: unknown, source: string, location: string): void => {
		if (!value || typeof value !== 'object' || isParamIntent(value)) return;
		if (Array.isArray(value)) {
			value.forEach((v, i) => {
				visit(v, source, `${location}[${i}]`);
			});
			return;
		}
		const node = value as Record<string, unknown>;
		if (
			node.kind === 'param' ||
			node.kind === 'literal' ||
			node.kind === 'parameter'
		)
			return;
		if (typeof node.from === 'string') {
			source = node.from;
			if (!(skipRoot && value === intent) && !node.batchValuesSource)
				refuse(source, `${location}.from`);
		}
		const trusted = getTrustedNqlRelationFilterFields(value);
		if (trusted) {
			refuse(trusted.targetTable, `${location}.relation`);
			for (const hop of trusted.hops)
				refuse(hop.target, `${location}.relation`);
			if (trusted.through) refuse(trusted.through, `${location}.junction`);
		}
		if (typeof node.targetTable === 'string')
			refuse(node.targetTable, `${location}.targetTable`);
		if (typeof node.table === 'string' && !node.batchValues)
			refuse(node.table, `${location}.table`);
		if (typeof node.relation === 'string' || Array.isArray(node.relation)) {
			const segments = Array.isArray(node.relation)
				? node.relation
				: (typeof node.via === 'string' ? node.via : node.relation).split('.');
			for (const segment of segments) {
				const relation = model.getRelation(`${source}.${segment}`);
				if (!relation) break;
				source = relation.target;
				refuse(source, `${location}.relation`);
				if (relation.through) refuse(relation.through, `${location}.junction`);
			}
		}
		if (node.kind === 'pseudoColumn')
			refuse(source, `${location}.pseudoColumn`);
		if (typeof node.field === 'string' && node.field.includes('.')) {
			let table = source;
			for (const segment of node.field.split('.').slice(0, -1)) {
				const relation = model.getRelation(`${table}.${segment}`);
				if (!relation) break;
				table = relation.target;
				refuse(table, `${location}.field`);
			}
		}
		for (const [key, child] of Object.entries(node)) {
			// Bound and literal payloads are data, never query structure.
			if (
				(key === 'value' || key === 'values') &&
				(!child || typeof child !== 'object' || !(EXPRESSION_BRAND in child))
			)
				continue;
			visit(child, source, `${location}.${key}`);
		}
	};
	visit(intent, root.from ?? '', path);
	return found;
}

export function assertUnplannedDefaultFilters(
	intent: unknown,
	model: ModelIR,
	filters: DefaultFilters | undefined,
	path: string,
	skipRoot = false,
): void {
	const scan = findDefaultFilterScan(intent, model, filters, path, skipRoot);
	if (scan)
		throw new Error(
			`Default filter for table '${scan.table}' is not supported at ${scan.path}.`,
		);
}

/** NQL reads use planned scan predicates; only legacy scan issuers refuse. */
export function assertUnsupportedNqlDefaultFilters(
	intent: unknown,
	model: ModelIR,
	filters: DefaultFilters | undefined,
	path: string,
): void {
	if (!filters || !Object.keys(filters).length) return;
	const bundle = intent as {
		bindings?: ReadonlyMap<string, unknown>;
		cteQuery?: { ctes: readonly { name: string }[] };
	};
	const locals = new Set([
		...(bundle.bindings?.keys() ?? []),
		...(bundle.cteQuery?.ctes.map((cte) => cte.name) ?? []),
	]);
	const refuse = (table: string, location: string): void => {
		if (filters[table])
			throw new Error(
				`Default filter for table '${table}' is not supported at ${location}.`,
			);
	};
	const visit = (value: unknown, source: string, location: string): void => {
		if (!value || typeof value !== 'object' || isParamIntent(value)) return;
		if (value instanceof Map) {
			for (const [name, child] of value)
				visit(child, source, `${location}.${name}`);
			return;
		}
		if (Array.isArray(value)) {
			value.forEach((child, index) => {
				visit(child, source, `${location}[${index}]`);
			});
			return;
		}
		const node = value as Record<string, unknown>;
		if (['literal', 'param', 'parameter'].includes(String(node.kind))) return;
		// Mutation targets and payloads retain their existing unfiltered contract.
		if (
			[
				'insert',
				'insert_from',
				'update',
				'delete',
				'upsert',
				'upsert_from',
			].includes(String(node.type))
		)
			return;
		if (typeof node.from === 'string') source = node.from;
		const trusted = getTrustedNqlRelationFilterFields(value);
		if (trusted?.through) refuse(trusted.through, `${location}.junction`);
		if (node.kind === 'relationColumn' && trusted) {
			// Binding projections bypass include lowering and emit their own scans.
			refuse(trusted.targetTable, `${location}.relation`);
			for (const hop of trusted.hops)
				refuse(hop.target, `${location}.relation`);
		}
		if (
			node.kind === 'subquery' ||
			node.kind === 'in' ||
			node.kind === 'rawExists' ||
			node.kind === 'rawNotExists'
		) {
			const query = (node.query ?? node.subquery) as QueryIntent | undefined;
			if (query && locals.has(query.from))
				refuse(query.from, `${location}.subquery.from`);
		}
		if (node.kind === 'pseudoColumn')
			refuse(trusted?.targetTable ?? source, `${location}.pseudoColumn`);
		if (typeof node.relation === 'string' || Array.isArray(node.relation)) {
			const segments = Array.isArray(node.relation)
				? node.relation
				: (typeof node.via === 'string' ? node.via : node.relation).split('.');
			for (const segment of segments) {
				const relation = model.getRelation(`${source}.${segment}`);
				if (!relation) break;
				if (locals.has(relation.target))
					refuse(relation.target, `${location}.relation`);
				if (relation.through) refuse(relation.through, `${location}.junction`);
				source = relation.target;
			}
		}
		for (const [key, child] of Object.entries(node)) {
			if (
				(key === 'value' || key === 'values') &&
				(!child || typeof child !== 'object' || !(EXPRESSION_BRAND in child))
			)
				continue;
			visit(child, source, `${location}.${key}`);
		}
	};
	visit(intent, '', path);
}
