import { identityNaming } from '../naming-plugin.js';
import { validateCheckExpression, validateIdentifier } from '../validate.js';
import { generateCreateIndex } from './ddl-generator.js';
import type { GeneratedPostconditionDeclarationV3 } from './managed-step-manifest.js';

/**
 * A dependency-free v3 declaration domain check.  It intentionally knows no
 * catalogue addresses or PostgreSQL sessions, so producers and readers accept
 * exactly the same address-free declaration domain.
 */
export class GeneratedPostconditionV3DeclarationError extends Error {
	constructor(
		readonly rule: string,
		/** A sanitized JSON structural path, never an authored declaration value. */
		readonly structuralPath: string | undefined = undefined,
	) {
		super(`generated postcondition v3 declaration violates ${rule}`);
		this.name = 'GeneratedPostconditionV3DeclarationError';
	}
}

function refuse(rule: string, structuralPath?: string): never {
	throw new GeneratedPostconditionV3DeclarationError(rule, structuralPath);
}

export function generatedPostconditionSnapshotStructuralPath(
	error: unknown,
): string | undefined {
	if (!(error instanceof Error)) return;
	const path = /^\$(?:\.[^.[\]:\s]+|\[[0-9]+\])*/u.exec(error.message)?.[0];
	return path === '$' && !error.message.startsWith('$:') ? undefined : path;
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

function sequenceInteger(
	value: string | undefined,
	rule: string,
): bigint | undefined {
	if (value === undefined) return;
	if (!/^-?[0-9]+$/u.test(value)) refuse(rule);
	try {
		return BigInt(value);
	} catch {
		refuse(rule);
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): void {
	const allowed = new Set(keys);
	if (!Object.keys(value).every((key) => allowed.has(key)))
		refuse('declaration shape');
}

function string(value: unknown): asserts value is string {
	if (typeof value !== 'string') refuse('declaration shape');
}

function boolean(value: unknown): asserts value is boolean {
	if (typeof value !== 'boolean') refuse('declaration shape');
}

function identifierField(
	value: unknown,
	type: 'table' | 'column' | 'schema' | 'alias',
): void {
	string(value);
	try {
		validateIdentifier(value, type);
	} catch {
		refuse('declaration shape');
	}
}

function strings(
	value: unknown,
	identifierType?: 'table' | 'column' | 'schema' | 'alias',
): void {
	if (!Array.isArray(value)) refuse('declaration shape');
	for (const item of value) {
		string(item);
		if (identifierType) identifierField(item, identifierType);
	}
}

function stringMap(value: unknown, keysMustBeIdentifiers = false): void {
	if (!record(value)) refuse('declaration shape');
	for (const [key, item] of Object.entries(value)) {
		if (keysMustBeIdentifiers) identifierField(key, 'alias');
		string(item);
	}
}

function exactCanonicalSqlFact(value: unknown): void {
	if (!record(value)) refuse('declaration shape');
	exactKeys(value, ['canonicalFormVersion', 'sql']);
	if (value.canonicalFormVersion !== 1) refuse('declaration shape');
	string(value.sql);
}

function exactDefault(value: unknown): void {
	if (!record(value)) refuse('declaration shape');
	if (value.defaultKind === 'authored') {
		exactKeys(value, [
			'defaultKind',
			'hasDefault',
			'identity',
			'defaultExpression',
		]);
		boolean(value.hasDefault);
		exactCanonicalSqlFact(value.defaultExpression);
		return;
	}
	exactKeys(value, ['defaultKind', 'hasDefault', 'identity']);
	boolean(value.hasDefault);
}

function exactColumn(value: unknown, named: boolean): void {
	if (!record(value)) refuse('declaration shape');
	exactKeys(value, [
		...(named ? ['name'] : []),
		'type',
		'nullable',
		'authoredCollation',
		'default',
	]);
	if (named) string(value.name);
	if (value.type !== undefined) string(value.type);
	if (value.nullable !== undefined) boolean(value.nullable);
	if (value.authoredCollation !== undefined && value.authoredCollation !== null)
		string(value.authoredCollation);
	if (value.default !== undefined) exactDefault(value.default);
}

/** Exact wire decoding belongs to the declaration parser, never a reader-only arm. */
function exactDeclaration(value: Record<string, unknown>): void {
	if (value.canonicalFormVersion !== 1 || typeof value.kind !== 'string')
		refuse('declaration shape');
	switch (value.kind) {
		case 'table':
			exactKeys(value, ['canonicalFormVersion', 'kind', 'columns']);
			if (!Array.isArray(value.columns)) refuse('declaration shape');
			for (const column of value.columns) exactColumn(column, true);
			return;
		case 'column':
			exactKeys(value, ['canonicalFormVersion', 'kind', 'column']);
			exactColumn(value.column, false);
			return;
		case 'check':
			exactKeys(value, ['canonicalFormVersion', 'kind', 'check']);
			if (!record(value.check)) refuse('declaration shape');
			exactKeys(value.check, ['expression', 'notValid']);
			exactCanonicalSqlFact(value.check.expression);
			boolean(value.check.notValid);
			return;
		case 'constraint': {
			exactKeys(value, ['canonicalFormVersion', 'kind', 'constraint']);
			if (!record(value.constraint)) refuse('declaration shape');
			const constraint = value.constraint;
			if (constraint.type === 'p' || constraint.type === 'u') {
				exactKeys(constraint, [
					'type',
					'columns',
					'deferrable',
					'initiallyDeferred',
					'enforced',
				]);
				strings(constraint.columns);
				boolean(constraint.deferrable);
				boolean(constraint.initiallyDeferred);
				boolean(constraint.enforced);
				return;
			}
			exactKeys(constraint, [
				'type',
				'columns',
				'references',
				'onDelete',
				'onUpdate',
				'deferrable',
				'initiallyDeferred',
				'enforced',
				'notValid',
			]);
			strings(constraint.columns);
			if (!record(constraint.references)) refuse('declaration shape');
			exactKeys(constraint.references, ['schema', 'table', 'columns']);
			string(constraint.references.schema);
			string(constraint.references.table);
			strings(constraint.references.columns);
			string(constraint.onDelete);
			string(constraint.onUpdate);
			boolean(constraint.deferrable);
			boolean(constraint.initiallyDeferred);
			boolean(constraint.enforced);
			boolean(constraint.notValid);
			return;
		}
		case 'index': {
			exactKeys(value, ['canonicalFormVersion', 'kind', 'index']);
			if (!record(value.index)) refuse('declaration shape');
			const index = value.index;
			exactKeys(index, [
				'method',
				'unique',
				'valid',
				'ready',
				'live',
				'columns',
				'expressions',
				'include',
				'nullsNotDistinct',
				'opclass',
				'with',
				'where',
			]);
			string(index.method);
			boolean(index.unique);
			if (index.valid !== true || index.ready !== true || index.live !== true)
				refuse('declaration shape');
			strings(index.columns);
			boolean(index.nullsNotDistinct);
			if (index.expressions !== undefined) {
				if (!Array.isArray(index.expressions)) refuse('declaration shape');
				for (const expression of index.expressions)
					exactCanonicalSqlFact(expression);
			}
			if (index.include !== undefined) strings(index.include);
			if (index.opclass !== undefined) stringMap(index.opclass, true);
			if (index.with !== undefined) stringMap(index.with, true);
			if (index.where !== undefined) exactCanonicalSqlFact(index.where);
			return;
		}
		case 'enum':
			exactKeys(value, ['canonicalFormVersion', 'kind', 'labels']);
			strings(value.labels);
			return;
		case 'sequence':
			exactKeys(value, [
				'canonicalFormVersion',
				'kind',
				'startValue',
				'incrementBy',
				'minValue',
				'maxValue',
				'cycle',
			]);
			for (const key of [
				'startValue',
				'incrementBy',
				'minValue',
				'maxValue',
			] as const)
				if (value[key] !== undefined) string(value[key]);
			if (value.cycle !== undefined) boolean(value.cycle);
			return;
		case 'extension':
			exactKeys(value, ['canonicalFormVersion', 'kind', 'version']);
			if (value.version !== undefined) string(value.version);
			return;
		case 'absent':
			exactKeys(value, ['canonicalFormVersion', 'kind']);
			return;
		default:
			refuse('declaration shape');
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
			if (
				index.columns.length === 0 &&
				(index.expressions === undefined || index.expressions.length === 0)
			)
				refuse('non-empty index keys');
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
			if (
				new Set((index.expressions ?? []).map((expression) => expression.sql))
					.size !== (index.expressions ?? []).length
			)
				refuse('unique index expressions');
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
			if (
				sequenceInteger(declaration.incrementBy, 'sequence increment value') ===
				0n
			)
				refuse('non-zero sequence increment');
			sequenceInteger(declaration.minValue, 'sequence minimum value');
			sequenceInteger(declaration.maxValue, 'sequence maximum value');
			return;
	}
}

/**
 * Copy an input into a plain own-data JSON graph before either hashing or
 * decoding it. Accessors, holes, symbols, extra array properties, and exotic
 * prototypes are refused instead of being interpreted differently by either
 * side of the persisted digest boundary.
 */
/** The fixed v3 wire envelope and declaration grammar reach at most five container edges. */
export const GENERATED_POSTCONDITION_MAX_JSON_DEPTH = 5;
/**
 * Durable declarations are capped at 64 KiB of serialized UTF-8 JSON.  This
 * caps both the persisted payload and the amount of graph we can copy before
 * exact-key decoding rejects a hostile wide declaration.
 */
export const GENERATED_POSTCONDITION_MAX_JSON_BYTES = 64 * 1024;
const GENERATED_POSTCONDITION_MAX_CONTAINER_MEMBERS = 4_096;

function serializedJsonStringUtf8Bytes(value: string): number {
	let bytes = 2;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code === 0x22 || code === 0x5c || code <= 0x1f) {
			bytes +=
				code === 0x08 ||
				code === 0x09 ||
				code === 0x0a ||
				code === 0x0c ||
				code === 0x0d
					? 2
					: 6;
			continue;
		}
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else bytes += 6;
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) {
			bytes += 6;
			continue;
		}
		bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
	}
	return bytes;
}

export function snapshotGeneratedPostconditionJson(value: unknown): unknown {
	if (
		value !== null &&
		typeof value === 'object' &&
		immutableGeneratedPostconditionSnapshots.has(value)
	)
		return value;
	let bytes = 0;
	const nonPrimitive = Symbol('nonPrimitive');
	const seen = new WeakSet<object>();
	const addBytes = (amount: number, path: string): void => {
		bytes += amount;
		if (bytes > GENERATED_POSTCONDITION_MAX_JSON_BYTES)
			throw new TypeError(
				`${path}: serialized JSON exceeds ${GENERATED_POSTCONDITION_MAX_JSON_BYTES} UTF-8 bytes`,
			);
	};
	const primitive = (
		item: unknown,
		path: string,
	): unknown | typeof nonPrimitive => {
		if (item === null) {
			addBytes(4, path);
			return null;
		}
		if (typeof item === 'string') {
			addBytes(serializedJsonStringUtf8Bytes(item), path);
			return item;
		}
		if (typeof item === 'boolean') {
			addBytes(item ? 4 : 5, path);
			return item;
		}
		if (typeof item === 'number') {
			if (!Number.isFinite(item))
				throw new TypeError(`${path}: expected a finite JSON number`);
			addBytes(String(Object.is(item, -0) ? 0 : item).length, path);
			return item;
		}
		return nonPrimitive;
	};
	type Frame = {
		readonly source: object;
		readonly target: object;
		readonly path: string;
		readonly depth: number;
	};
	const root = primitive(value, '$');
	if (root !== nonPrimitive) return root;
	if (value === null || value === undefined || typeof value !== 'object')
		throw new TypeError('$: expected an own JSON value');
	const stack: Frame[] = [];
	const copiedContainers: object[] = [];
	const copyContainer = (
		source: object,
		path: string,
		depth: number,
	): object => {
		if (depth > GENERATED_POSTCONDITION_MAX_JSON_DEPTH)
			throw new TypeError(
				`${path}: declaration exceeds JSON depth ${GENERATED_POSTCONDITION_MAX_JSON_DEPTH}`,
			);
		if (seen.has(source))
			throw new TypeError(`${path}: declaration graph must be a tree`);
		seen.add(source);
		if (Array.isArray(source)) {
			if (Object.getPrototypeOf(source) !== Array.prototype)
				throw new TypeError(`${path}: array has an exotic prototype`);
			if (source.length > GENERATED_POSTCONDITION_MAX_CONTAINER_MEMBERS)
				throw new TypeError(
					`${path}: array exceeds ${GENERATED_POSTCONDITION_MAX_CONTAINER_MEMBERS} members`,
				);
			if (Object.getOwnPropertySymbols(source).length > 0)
				throw new TypeError(`${path}: array has symbol members`);
			const copied: unknown[] = new Array(source.length);
			copiedContainers.push(copied);
			stack.push({ source, target: copied, path, depth });
			return copied;
		}
		if (Object.getPrototypeOf(source) !== Object.prototype)
			throw new TypeError(`${path}: object has an exotic prototype`);
		if (Object.getOwnPropertySymbols(source).length > 0)
			throw new TypeError(`${path}: object has symbol members`);
		let members = 0;
		for (const key in source) {
			if (!Object.hasOwn(source, key)) continue;
			members += 1;
			if (members > GENERATED_POSTCONDITION_MAX_CONTAINER_MEMBERS)
				throw new TypeError(
					`${path}: object exceeds ${GENERATED_POSTCONDITION_MAX_CONTAINER_MEMBERS} members`,
				);
		}
		const copied: Record<string, unknown> = {};
		copiedContainers.push(copied);
		stack.push({ source, target: copied, path, depth });
		return copied;
	};
	const snapshot = copyContainer(value, '$', 0);
	while (stack.length > 0) {
		const frame = stack.pop();
		if (!frame) break;
		if (Array.isArray(frame.source)) {
			addBytes(2 + Math.max(0, frame.source.length - 1), frame.path);
			for (let index = frame.source.length - 1; index >= 0; index -= 1) {
				if (!Object.hasOwn(frame.source, index))
					throw new TypeError(
						`${frame.path}[${index}]: array holes are unsupported`,
					);
				const descriptor = Object.getOwnPropertyDescriptor(
					frame.source,
					String(index),
				);
				if (!descriptor || !('value' in descriptor))
					throw new TypeError(
						`${frame.path}[${index}]: accessor members are unsupported`,
					);
				if (descriptor.value === undefined)
					throw new TypeError(
						`${frame.path}[${index}]: expected an own JSON value`,
					);
				const copied = primitive(descriptor.value, `${frame.path}[${index}]`);
				(frame.target as unknown[])[index] =
					copied === nonPrimitive
						? copyContainer(
								descriptor.value as object,
								`${frame.path}[${index}]`,
								frame.depth + 1,
							)
						: copied;
			}
			for (const key of Object.getOwnPropertyNames(frame.source)) {
				if (key === 'length') continue;
				if (!/^(?:0|[1-9][0-9]*)$/u.test(key))
					throw new TypeError(`${frame.path}: array has a non-index member`);
				if (BigInt(key) > 4294967294n)
					throw new TypeError(
						`${frame.path}: array has an out-of-range index member`,
					);
			}
			continue;
		}
		const keys: string[] = [];
		for (const key in frame.source) {
			if (!Object.hasOwn(frame.source, key)) continue;
			keys.push(key);
		}
		addBytes(2 + Math.max(0, keys.length - 1), frame.path);
		for (let index = keys.length - 1; index >= 0; index -= 1) {
			const key = keys[index];
			if (key === undefined) continue;
			const descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
			if (
				!descriptor ||
				!('value' in descriptor) ||
				descriptor.enumerable !== true
			)
				throw new TypeError(
					`${frame.path}.${key}: own data members are required`,
				);
			if (descriptor.value === undefined)
				throw new TypeError(`${frame.path}.${key}: expected an own JSON value`);
			addBytes(serializedJsonStringUtf8Bytes(key) + 1, frame.path);
			const copied = primitive(descriptor.value, `${frame.path}.${key}`);
			Object.defineProperty(frame.target, key, {
				value:
					copied === nonPrimitive
						? copyContainer(
								descriptor.value as object,
								`${frame.path}.${key}`,
								frame.depth + 1,
							)
						: copied,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		for (const key of Object.getOwnPropertyNames(frame.source))
			if (!Object.hasOwn(frame.target, key))
				throw new TypeError(
					`${frame.path}.${key}: non-enumerable members are unsupported`,
				);
	}
	for (const item of copiedContainers.reverse()) {
		Object.freeze(item);
		immutableGeneratedPostconditionSnapshots.add(item);
	}
	return snapshot;
}

/** Branded by identity, not a forgeable property, once it crossed the JSON gate. */
const immutableGeneratedPostconditionSnapshots = new WeakSet<object>();

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
	} catch (error) {
		return refuse(
			'own JSON declaration graph',
			generatedPostconditionSnapshotStructuralPath(error),
		);
	}
	if (!record(snapshot)) refuse('declaration shape');
	try {
		exactDeclaration(snapshot);
		validateGeneratedPostconditionV3Declaration(snapshot);
	} catch (error) {
		if (error instanceof GeneratedPostconditionV3DeclarationError) throw error;
		refuse('declaration shape');
	}
	return snapshot;
}
