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
	for (const value of values) identifier(value, rule);
}

/** Validate semantic sibling constraints after a v3 declaration is shaped. */
export function validateGeneratedPostconditionV3Declaration(
	declaration: GeneratedPostconditionDeclarationV3,
): void {
	switch (declaration.kind) {
		case 'table': {
			const names = declaration.columns.map((column) => column.name);
			identifiers(names, 'table column identifiers');
			unique(names, 'unique table column names');
			return;
		}
		case 'constraint': {
			const constraint = declaration.constraint;
			identifiers(constraint.columns, 'constraint column identifiers');
			if (constraint.columns.length === 0)
				refuse('non-empty constraint columns');
			unique(constraint.columns, 'unique constraint columns');
			if (constraint.initiallyDeferred && !constraint.deferrable)
				refuse('initially deferred constraint must be deferrable');
			if (constraint.type !== 'f') return;
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
			return;
		}
		case 'enum':
			unique(declaration.labels, 'unique enum labels');
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
	return snapshot(value, '$');
}
