import { identityNaming } from '../naming-plugin.js';
import { validateCheckExpression } from '../validate.js';
import { generateCreateIndex } from './ddl-generator.js';
import type { GeneratedPostconditionDeclarationV3 } from './managed-step-manifest.js';

/**
 * A dependency-free v3 declaration domain check.  It intentionally knows no
 * catalogue addresses or PostgreSQL sessions, so producers and readers accept
 * exactly the same address-free declaration domain.
 */
export class GeneratedPostconditionV3DeclarationError extends Error {
	constructor(readonly rule: string) {
		super(`generated postcondition v3 declaration violates ${rule}`);
		this.name = 'GeneratedPostconditionV3DeclarationError';
	}
}

function refuse(rule: string): never {
	throw new GeneratedPostconditionV3DeclarationError(rule);
}

function identifier(value: string, rule: string): void {
	if (
		value.length === 0 ||
		value.length > 63 ||
		!/^[a-zA-Z_][a-zA-Z0-9_$]*$/u.test(value)
	)
		refuse(rule);
}

function unique(values: readonly string[], rule: string): void {
	if (new Set(values).size !== values.length) refuse(rule);
}

function identifiers(values: readonly string[], rule: string): void {
	for (const value of values) {
		if (typeof value !== 'string') refuse(rule);
		identifier(value, rule);
	}
}

function columnDefault(value: unknown): void {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		refuse('column default shape');
	const state = value as Record<string, unknown>;
	if (
		state.defaultKind === 'none' ||
		state.defaultKind === 'generated-sequence'
	) {
		if (
			state.hasDefault !== (state.defaultKind === 'generated-sequence') ||
			state.identity !== null
		)
			refuse('column default state');
		return;
	}
	if (state.defaultKind === 'identity') {
		if (
			state.hasDefault !== false ||
			(state.identity !== 'always' && state.identity !== 'byDefault')
		)
			refuse('column default state');
		return;
	}
	if (
		state.defaultKind !== 'authored' ||
		state.hasDefault !== true ||
		state.identity !== null
	)
		refuse('column default state');
	canonicalSql(state.defaultExpression, 'safe canonical SQL');
}

const indexMethods = new Set([
	'btree',
	'hash',
	'gist',
	'gin',
	'brin',
	'spgist',
	'hnsw',
	'ivfflat',
	'bm25',
	'bloom',
]);

function canonicalSql(value: unknown, rule: string): void {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		(value as Record<string, unknown>).canonicalFormVersion !== 1 ||
		typeof (value as Record<string, unknown>).sql !== 'string'
	)
		refuse(rule);
	try {
		validateCheckExpression(
			(value as { readonly sql: string }).sql,
			'generated canonical SQL fact',
		);
	} catch {
		refuse(rule);
	}
}

function sequenceInteger(value: string | undefined, rule: string): void {
	if (value === undefined) return;
	if (!/^-?[0-9]+$/u.test(value)) refuse(rule);
	try {
		BigInt(value);
	} catch {
		refuse(rule);
	}
}

/**
 * The single v3 declaration parser. It is intentionally catalogue/session
 * neutral: both the producer and persisted-reader use this exact domain gate.
 */
export function validateGeneratedPostconditionV3Declaration(
	declaration: GeneratedPostconditionDeclarationV3,
): void {
	switch (declaration.kind) {
		case 'table': {
			if (!Array.isArray(declaration.columns)) refuse('table columns shape');
			const names = declaration.columns.map((column) => column.name);
			identifiers(names, 'table column identifiers');
			unique(names, 'unique table column names');
			for (const column of declaration.columns) {
				if (column.default !== undefined) columnDefault(column.default);
			}
			return;
		}
		case 'column':
			if (declaration.column.default !== undefined)
				columnDefault(declaration.column.default);
			return;
		case 'check':
			canonicalSql(declaration.check.expression, 'safe canonical SQL');
			return;
		case 'constraint': {
			const constraint = declaration.constraint;
			if (
				constraint.type !== 'p' &&
				constraint.type !== 'u' &&
				constraint.type !== 'f'
			)
				refuse('constraint type');
			identifiers(constraint.columns, 'constraint column identifiers');
			if (constraint.columns.length === 0)
				refuse('non-empty constraint columns');
			unique(constraint.columns, 'unique constraint columns');
			if (constraint.initiallyDeferred && !constraint.deferrable)
				refuse('initially deferred constraint must be deferrable');
			if (constraint.type !== 'f') return;
			for (const action of [constraint.onDelete, constraint.onUpdate])
				if (
					![
						'NO ACTION',
						'RESTRICT',
						'CASCADE',
						'SET NULL',
						'SET DEFAULT',
					].includes(action)
				)
					refuse('foreign-key action allowlist');
			identifier(constraint.references.schema, 'foreign-key reference schema');
			identifier(constraint.references.table, 'foreign-key reference table');
			identifiers(
				constraint.references.columns,
				'foreign-key reference column identifiers',
			);
			if (constraint.references.columns.length === 0)
				refuse('non-empty foreign-key reference columns');
			unique(
				constraint.references.columns,
				'unique foreign-key reference columns',
			);
			if (constraint.columns.length !== constraint.references.columns.length)
				refuse('equal foreign-key column list lengths');
			return;
		}
		case 'index': {
			const index = declaration.index;
			if (!indexMethods.has(index.method)) refuse('index method allowlist');
			identifiers(index.columns, 'index column identifiers');
			unique(index.columns, 'unique index columns');
			identifiers(index.include ?? [], 'index include column identifiers');
			unique(index.include ?? [], 'unique index include columns');
			if (index.nullsNotDistinct && !index.unique)
				refuse('NULLS NOT DISTINCT requires a unique index');
			for (const [column, opclass] of Object.entries(index.opclass ?? {})) {
				identifier(column, 'index opclass column identifiers');
				identifier(opclass, 'index opclass identifiers');
				if (!index.columns.includes(column))
					refuse('index opclass keys name index columns');
			}
			for (const key of Object.keys(index.with ?? {}))
				identifier(key, 'index storage parameter identifiers');
			for (const expression of index.expressions ?? [])
				canonicalSql(expression, 'safe canonical SQL');
			if (index.where !== undefined)
				canonicalSql(index.where, 'safe canonical SQL');
			try {
				generateCreateIndex(
					'dbsp_postcondition_parser',
					{
						name: 'dbsp_postcondition_parser_index',
						columns: index.columns,
						method: index.method,
						unique: index.unique,
						nullsNotDistinct: index.nullsNotDistinct,
						...(index.expressions === undefined
							? {}
							: { expressions: index.expressions.map((fact) => fact.sql) }),
						...(index.include === undefined ? {} : { include: index.include }),
						...(index.opclass === undefined ? {} : { opclass: index.opclass }),
						...(index.with === undefined ? {} : { with: index.with }),
						...(index.where === undefined ? {} : { where: index.where.sql }),
					},
					undefined,
					identityNaming,
				);
			} catch {
				refuse('index renderer representability');
			}
			return;
		}
		case 'enum':
			if (declaration.labels.some((label) => typeof label !== 'string'))
				refuse('enum labels');
			unique(declaration.labels, 'unique enum labels');
			return;
		case 'sequence':
			sequenceInteger(declaration.startValue, 'sequence start value');
			sequenceInteger(declaration.incrementBy, 'sequence increment value');
			sequenceInteger(declaration.minValue, 'sequence minimum value');
			sequenceInteger(declaration.maxValue, 'sequence maximum value');
			if (declaration.incrementBy === '0')
				refuse('non-zero sequence increment');
			return;
		default:
			return;
	}
}

/**
 * Copy an input into a plain own-data JSON graph before either hashing or
 * decoding it. Accessors, holes, symbols, extra array properties, and exotic
 * prototypes are refused instead of being interpreted differently by either
 * side of the persisted digest boundary.
 */
export function snapshotGeneratedPostconditionJson(value: unknown): unknown {
	const snapshot = (item: unknown, path: string): unknown => {
		if (item === null || typeof item === 'string' || typeof item === 'boolean')
			return item;
		if (typeof item === 'number') {
			if (!Number.isFinite(item))
				throw new TypeError(`${path}: expected a finite JSON number`);
			return item;
		}
		if (typeof item !== 'object' || item === undefined)
			throw new TypeError(`${path}: expected an own JSON value`);
		if (Array.isArray(item)) {
			if (Object.getPrototypeOf(item) !== Array.prototype)
				throw new TypeError(`${path}: array has an exotic prototype`);
			if (Object.getOwnPropertySymbols(item).length > 0)
				throw new TypeError(`${path}: array has symbol members`);
			const names = Object.getOwnPropertyNames(item);
			for (const name of names) {
				if (name === 'length') continue;
				if (!/^(?:0|[1-9][0-9]*)$/u.test(name))
					throw new TypeError(`${path}: array has a non-index member`);
				const descriptor = Object.getOwnPropertyDescriptor(item, name);
				if (!descriptor || !('value' in descriptor))
					throw new TypeError(
						`${path}[${name}]: accessor members are unsupported`,
					);
			}
			const copied: unknown[] = [];
			for (let index = 0; index < item.length; index += 1) {
				if (!Object.hasOwn(item, index))
					throw new TypeError(`${path}[${index}]: array holes are unsupported`);
				copied.push(snapshot(item[index], `${path}[${index}]`));
			}
			return copied;
		}
		if (Object.getPrototypeOf(item) !== Object.prototype)
			throw new TypeError(`${path}: object has an exotic prototype`);
		if (Object.getOwnPropertySymbols(item).length > 0)
			throw new TypeError(`${path}: object has symbol members`);
		const copied: Record<string, unknown> = {};
		for (const key of Object.keys(item)) {
			const descriptor = Object.getOwnPropertyDescriptor(item, key);
			if (!descriptor || !('value' in descriptor))
				throw new TypeError(`${path}.${key}: accessor members are unsupported`);
			if (descriptor.enumerable !== true)
				throw new TypeError(
					`${path}.${key}: non-enumerable members are unsupported`,
				);
			Object.defineProperty(copied, key, {
				value: snapshot(descriptor.value, `${path}.${key}`),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		for (const key of Object.getOwnPropertyNames(item)) {
			if (!Object.hasOwn(copied, key))
				throw new TypeError(
					`${path}.${key}: non-enumerable members are unsupported`,
				);
		}
		return copied;
	};
	const freeze = (item: unknown): unknown => {
		if (item && typeof item === 'object') {
			for (const member of Object.values(item as Record<string, unknown>))
				freeze(member);
			Object.freeze(item);
		}
		return item;
	};
	return freeze(snapshot(value, '$'));
}

/**
 * Normalizes the producer's typed declaration through the same immutable JSON
 * boundary used by the persisted reader. Decoder shape validation feeds this
 * parser too, so semantic and renderer rules cannot drift by direction.
 */
export function parseGeneratedPostconditionV3Declaration(
	value: unknown,
): GeneratedPostconditionDeclarationV3 {
	let snapshot: GeneratedPostconditionDeclarationV3;
	try {
		snapshot = snapshotGeneratedPostconditionJson(
			value,
		) as GeneratedPostconditionDeclarationV3;
	} catch {
		return refuse('own JSON declaration graph');
	}
	if (
		!snapshot ||
		typeof snapshot !== 'object' ||
		Array.isArray(snapshot) ||
		snapshot.canonicalFormVersion !== 1 ||
		typeof snapshot.kind !== 'string'
	)
		refuse('declaration shape');
	try {
		validateGeneratedPostconditionV3Declaration(snapshot);
	} catch (error) {
		if (error instanceof GeneratedPostconditionV3DeclarationError) throw error;
		refuse('declaration shape');
	}
	return snapshot;
}
