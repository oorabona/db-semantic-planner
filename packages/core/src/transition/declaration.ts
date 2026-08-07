import { createHash } from 'node:crypto';
import type {
	CatalogueIdentity,
	DeclarableKind,
	DeclarableResourceAddress,
	DeclarationSet,
	JsonValue,
	ManagedDeclaration,
	ModelIR,
	ResourceAddress,
} from '@dbsp/types';
import type { InProcessProvenPlan } from './index.js';
import { mintInProcessPlan } from './minting.js';
import { stableJson } from './stable-json.js';

export interface DeclarationAddressContext {
	readonly engine: string;
	readonly database: string;
	readonly schema: string;
}

function jsonError(path: string, detail: string): Error {
	return new Error(
		`declaration is not canonicalizable JSON at ${path}: ${detail}`,
	);
}

function childPath(parent: string, key: string | number): string {
	if (typeof key === 'number') return `${parent}[${key}]`;
	return /^[A-Za-z_$][\w$]*$/u.test(key)
		? `${parent}.${key}`
		: `${parent}[${JSON.stringify(key)}]`;
}

/**
 * Reject every JavaScript value whose JSON representation is lossy or
 * host-dependent. JSON.stringify alone is unsuitable because it silently drops
 * functions and undefined object members, exactly the ColumnDef.default case.
 */
export function assertCanonicalizableJson(
	value: unknown,
	path = '$',
	seen = new WeakSet<object>(),
): asserts value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw jsonError(path, 'number must be finite');
		return;
	}
	if (typeof value !== 'object') {
		throw jsonError(path, `found ${typeof value}`);
	}
	if (seen.has(value)) throw jsonError(path, 'cyclic value');
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			for (let index = 0; index < value.length; index += 1) {
				if (!Object.hasOwn(value, index))
					throw jsonError(childPath(path, index), 'array hole');
				assertCanonicalizableJson(value[index], childPath(path, index), seen);
			}
			if (
				Reflect.ownKeys(value).some(
					(key) =>
						key !== 'length' &&
						!(typeof key === 'string' && /^(0|[1-9]\d*)$/u.test(key)),
				)
			)
				throw jsonError(path, 'array has a non-index property');
			return;
		}
		if (Object.getPrototypeOf(value) !== Object.prototype)
			throw jsonError(
				path,
				`found ${value.constructor?.name ?? 'non-plain object'}`,
			);
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== 'string') throw jsonError(path, 'symbol key');
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || 'get' in descriptor || 'set' in descriptor)
				throw jsonError(childPath(path, key), 'accessor property');
			if (!descriptor.enumerable)
				throw jsonError(childPath(path, key), 'non-enumerable property');
			assertCanonicalizableJson(descriptor.value, childPath(path, key), seen);
		}
	} finally {
		seen.delete(value);
	}
}

function canonicalJson(value: unknown, path: string): JsonValue {
	assertCanonicalizableJson(value, path);
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function digest(value: JsonValue): string {
	return createHash('sha256').update(stableJson(value)).digest('hex');
}

function address<K extends DeclarableKind>(
	context: DeclarationAddressContext,
	kind: K,
	name: string,
	parent?: ResourceAddress,
	identity?: CatalogueIdentity,
): DeclarableResourceAddress<K> {
	return {
		engine: context.engine,
		database: context.database,
		...(kind === 'extension' ? {} : { schema: context.schema }),
		...(parent === undefined ? {} : { parent }),
		kind,
		name,
		...(identity === undefined ? {} : { catalogueIdentity: identity }),
	};
}

function declaration<K extends DeclarableKind>(
	context: DeclarationAddressContext,
	kind: K,
	name: string,
	fragment: unknown,
	path: string,
	parent?: ResourceAddress,
): ManagedDeclaration<K> {
	const canonical = canonicalJson(fragment, path);
	return {
		address: address(context, kind, name, parent),
		fragment: canonical,
		digest: digest(canonical),
	};
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
	return value === undefined ? {} : { [key]: value };
}

function tableAddress(
	context: DeclarationAddressContext,
	name: string,
): ResourceAddress {
	return address(context, 'table', name);
}

/**
 * Slice only the declarable part of ModelIR. Deliberately absent are
 * logicalIdentity, pseudoColumns, comment, partition, rlsEnabled and policies;
 * their omission is encoded here once, rather than re-checked at every caller.
 */
export function declarationSetFromModel(
	model: ModelIR,
	context: DeclarationAddressContext,
): DeclarationSet {
	const declarations: ManagedDeclaration[] = [];
	for (const [tableKey, table] of [...model.tables].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	)) {
		const tablePath = `schema.tables[${JSON.stringify(tableKey)}]`;
		const parent = tableAddress(context, table.name);
		declarations.push(
			declaration(
				context,
				'table',
				table.name,
				{ name: table.name },
				tablePath,
			),
		);
		for (const [index, column] of table.columns.entries()) {
			const fragment = {
				name: column.name,
				type: column.type,
				nullable: column.nullable,
				...optional('js', column.js),
				...optional('default', column.default),
				...optional('originalDbType', column.originalDbType),
				...optional('originalDbTypeSchema', column.originalDbTypeSchema),
				...optional(
					'originalDbTypeSchemaScope',
					column.originalDbTypeSchemaScope,
				),
				...optional('unique', column.unique),
				...optional('uniqueConstraintName', column.uniqueConstraintName),
				...optional('autoIncrement', column.autoIncrement),
				...optional('collation', column.collation),
				...optional('identity', column.identity),
			};
			declarations.push(
				declaration(
					context,
					'column',
					column.name,
					fragment,
					`${tablePath}.columns[${index}]`,
					parent,
				),
			);
		}
		for (const [index, item] of table.indexes.entries()) {
			const name = item.name ?? `index:${index}`;
			declarations.push(
				declaration(
					context,
					'index',
					name,
					item,
					`${tablePath}.indexes[${index}]`,
					parent,
				),
			);
		}
		if (table.primaryKey !== undefined) {
			declarations.push(
				declaration(
					context,
					'constraint',
					'primary-key',
					{ kind: 'primary-key', columns: table.primaryKey },
					`${tablePath}.primaryKey`,
					parent,
				),
			);
		}
		for (const [index, item] of table.foreignKeys.entries()) {
			declarations.push(
				declaration(
					context,
					'constraint',
					`foreign-key:${index}`,
					{ kind: 'foreign-key', ...item },
					`${tablePath}.foreignKeys[${index}]`,
					parent,
				),
			);
		}
		for (const [index, item] of (table.checkConstraints ?? []).entries()) {
			declarations.push(
				declaration(
					context,
					'constraint',
					item.name,
					{ kind: 'check', ...item },
					`${tablePath}.checkConstraints[${index}]`,
					parent,
				),
			);
		}
	}
	for (const [name, item] of [...(model.enums ?? new Map())].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	)) {
		declarations.push(
			declaration(
				context,
				'enum',
				name,
				item,
				`schema.enums[${JSON.stringify(name)}]`,
			),
		);
	}
	for (const [name, item] of [...(model.sequences ?? new Map())].sort(
		([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
	)) {
		declarations.push(
			declaration(
				context,
				'sequence',
				name,
				item,
				`schema.sequences[${JSON.stringify(name)}]`,
			),
		);
	}
	for (const name of [...(model.extensions ?? [])].sort()) {
		declarations.push(
			declaration(
				context,
				'extension',
				name,
				{ name },
				`schema.extensions[${JSON.stringify(name)}]`,
			),
		);
	}
	const canonicalDeclarations = declarations.sort((left, right) => {
		const a = stableJson(left.address);
		const b = stableJson(right.address);
		return a < b ? -1 : a > b ? 1 : 0;
	});
	const setValue = canonicalJson(
		{ version: 1, declarations: canonicalDeclarations },
		'schema.declarations',
	);
	return {
		version: 1,
		declarations: canonicalDeclarations,
		digest: digest(setValue),
	};
}

/** Validate the complete declarable surface before comparison can short-circuit plan time. */
export function validateDeclarationModel(model: ModelIR): void {
	declarationSetFromModel(model, {
		engine: 'declaration-validation',
		database: 'declaration-validation',
		schema: 'declaration-validation',
	});
}

/** Compare only the recorded/live identity and retain the precise mismatch reason. */
export function admitRecordedIdentity(
	recorded: ResourceAddress,
	live: ResourceAddress,
): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
	if (recorded.catalogueIdentity === undefined)
		return {
			ok: false,
			detail: `recorded address ${recorded.kind} ${recorded.name} has no catalogue identity`,
		};
	if (live.catalogueIdentity === undefined)
		return {
			ok: false,
			detail: `live address ${live.kind} ${live.name} has no catalogue identity`,
		};
	if (
		stableJson(recorded.catalogueIdentity) !==
		stableJson(live.catalogueIdentity)
	)
		return {
			ok: false,
			detail: `identity drift for ${recorded.kind} ${recorded.name}: recorded ${stableJson(recorded.catalogueIdentity)} does not match live ${stableJson(live.catalogueIdentity)}`,
		};
	return { ok: true };
}

/** Attach the canonical declaration artifact before metadata/digest minting. */
export function bindDeclarationSet(
	plan: InProcessProvenPlan,
	declarations: DeclarationSet,
): InProcessProvenPlan {
	return mintInProcessPlan({ ...plan, declarations });
}
