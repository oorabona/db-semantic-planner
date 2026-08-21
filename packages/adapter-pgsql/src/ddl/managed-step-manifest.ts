import { createHash } from 'node:crypto';
import type {
	DeclarableResourceAddress,
	LedgerClaimKind,
	NormalizedManagedStep,
} from '@dbsp/types';
import { canonicalResourceParent } from '@dbsp/types';
import {
	renderCheckConstraintClause,
	splitCheckConstraintState,
} from '../check-expression.js';
import { renderColumnDbType } from '../db-type.js';
import { identityNaming } from '../naming-plugin.js';
import { generateCreateIndex } from './ddl-generator.js';
import {
	classifyGeneratedMutation,
	type GeneratedMutationClassification,
} from './destructive-classification.js';
import { formatSqlDefault } from './phases/utils.js';
import type { ChangeKind, SchemaChange } from './schema-diff.js';

type Address = DeclarableResourceAddress & {
	readonly scope: 'schema' | 'database';
};

type Meta = Readonly<Record<string, unknown>>;

type GeneratedColumnPostcondition = {
	readonly name: string;
	readonly type?: string;
	readonly nullable?: boolean;
	readonly hasDefault?: boolean;
	readonly default?: string;
	readonly collation?: string | null;
	readonly identity?: 'always' | 'byDefault' | null;
};

export type GeneratedConstraintPostcondition =
	| { readonly type: 'p' | 'u'; readonly columns: readonly string[] }
	| {
			readonly type: 'f';
			readonly columns: readonly string[];
			readonly references: {
				readonly schema?: string;
				readonly table: string;
				readonly columns: readonly string[];
			};
			readonly onDelete: string;
			readonly onUpdate: string;
			readonly deferred: boolean;
			readonly notValid: boolean;
	  }
	| {
			readonly type: 'c';
			readonly definition: string;
			readonly notValid: boolean;
	  };

/** ModelIR-derived, digest-covered catalogue projection for a generated step. */
export type GeneratedPostcondition =
	| {
			readonly kind: 'table';
			readonly columns: readonly GeneratedColumnPostcondition[];
	  }
	| { readonly kind: 'column'; readonly column: GeneratedColumnPostcondition }
	| {
			readonly kind: 'constraint';
			readonly constraint: GeneratedConstraintPostcondition;
	  }
	| { readonly kind: 'index'; readonly definition: string }
	| { readonly kind: 'enum'; readonly labels: readonly string[] }
	| {
			readonly kind: 'sequence';
			readonly startValue?: string;
			readonly incrementBy?: string;
			readonly minValue?: string;
			readonly maxValue?: string;
			readonly cycle?: boolean;
	  }
	| { readonly kind: 'extension'; readonly version?: string }
	| { readonly kind: 'absent' }
	| { readonly kind: 'exempt'; readonly reason: string };

function postconditionPayload(
	value: GeneratedPostcondition,
): import('@dbsp/types').LedgerPayload {
	return {
		value,
		digest: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
	};
}

function requiredColumn(
	value: unknown,
	label: string,
): import('@dbsp/types').ColumnIR {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error(
			`generator planning refuses ${label}: missing typed column`,
		);
	const column = value as import('@dbsp/types').ColumnIR;
	if (typeof column.name !== 'string' || typeof column.nullable !== 'boolean')
		throw new Error(
			`generator planning refuses ${label}: missing typed column`,
		);
	return column;
}

function columnPostcondition(
	column: import('@dbsp/types').ColumnIR,
	schema: string,
	primaryKey = false,
): GeneratedColumnPostcondition {
	const hasDefault = column.default !== undefined;
	return {
		name: column.name,
		type: renderColumnDbType(column, schema),
		nullable: primaryKey ? false : column.nullable,
		hasDefault,
		...(hasDefault
			? { default: formatSqlDefault(column.default, 'generator postcondition') }
			: {}),
	};
}

function requiredRecord(
	value: unknown,
	label: string,
): Readonly<Record<string, unknown>> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error(
			`generator planning refuses ${label}: missing typed declaration`,
		);
	return value as Readonly<Record<string, unknown>>;
}

function requiredList(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
		throw new Error(
			`generator planning refuses ${label}: missing typed columns`,
		);
	return value as readonly string[];
}

function requiredColumnList(value: unknown, label: string): readonly string[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some((item) => typeof item !== 'string' || item.trim().length === 0)
	)
		throw new Error(
			`generator planning refuses ${label}: missing typed columns`,
		);
	return value as readonly string[];
}

type ValidateConstraintTarget =
	| {
			readonly kind: 'check';
			readonly check: Readonly<Record<string, unknown>>;
	  }
	| {
			readonly kind: 'foreign-key';
			readonly fk: Readonly<Record<string, unknown>>;
			readonly references: Readonly<Record<string, unknown>>;
	  };

/**
 * `validate_constraint` has exactly one branch discriminator. A defined
 * `check` is always a check declaration (and must therefore be a record);
 * only an absent `check` selects the foreign-key declaration and its keys.
 */
function validateConstraintTarget(
	change: SchemaChange,
): ValidateConstraintTarget {
	const meta = change.meta;
	if (meta?.check !== undefined)
		return {
			kind: 'check',
			check: requiredRecord(meta.check, change.kind),
		};
	const fk = requiredRecord(meta?.fk, change.kind);
	const references = requiredRecord(fk.references, change.kind);
	requiredColumnList(fk.columns, `${change.kind} columns`);
	requiredColumnList(references.columns, `${change.kind} references.columns`);
	return { kind: 'foreign-key', fk, references };
}

/**
 * Reject malformed key-column lists before any change-specific consumer can
 * derive an address, name, or postcondition from them.
 */
function validateChangeKeyLists(change: SchemaChange): void {
	const meta = change.meta;
	const foreignKey = () => {
		const fk = requiredRecord(meta?.fk, change.kind);
		const references = requiredRecord(fk.references, change.kind);
		requiredColumnList(fk.columns, `${change.kind} columns`);
		requiredColumnList(references.columns, `${change.kind} references.columns`);
	};
	switch (change.kind) {
		case 'create_table':
		case 'readdress_table': {
			const table = meta?.table;
			if (!table || typeof table !== 'object' || Array.isArray(table)) return;
			const primaryKey = (table as Record<string, unknown>).primaryKey;
			if (primaryKey === undefined) return;
			requiredColumnList(
				typeof primaryKey === 'string' ? [primaryKey] : primaryKey,
				`${change.kind} table.primaryKey`,
			);
			return;
		}
		case 'add_primary_key':
		case 'drop_primary_key':
			requiredColumnList(meta?.columns, `${change.kind} columns`);
			return;
		case 'add_foreign_key':
		case 'drop_foreign_key':
		case 'alter_foreign_key':
			foreignKey();
			return;
		case 'validate_constraint':
			validateConstraintTarget(change);
			return;
		default:
			return;
	}
}

function constraintPostcondition(
	change: SchemaChange,
): GeneratedConstraintPostcondition {
	const meta = change.meta;
	if (change.kind === 'add_primary_key')
		return {
			type: 'p',
			columns: requiredColumnList(meta?.columns, `${change.kind} columns`),
		};
	if (change.kind === 'alter_column_unique')
		return { type: 'u', columns: [text(change.column, change.kind)] };
	const target =
		change.kind === 'validate_constraint'
			? validateConstraintTarget(change)
			: undefined;
	const check = target?.kind === 'check' ? target.check : meta?.check;
	if (check !== undefined) {
		const value = requiredRecord(check, change.kind);
		const expression = text(value.expression, change.kind);
		const state = splitCheckConstraintState({
			expression,
			...(value.notValid === true ? { notValid: true } : {}),
		});
		return {
			type: 'c',
			definition: renderCheckConstraintClause({
				expression,
				...(state.notValid ? { notValid: true } : {}),
			}),
			notValid: state.notValid,
		};
	}
	const fk =
		target?.kind === 'foreign-key'
			? target.fk
			: requiredRecord(meta?.fk, change.kind);
	const references =
		target?.kind === 'foreign-key'
			? target.references
			: requiredRecord(fk.references, change.kind);
	return {
		type: 'f',
		columns: requiredColumnList(fk.columns, `${change.kind} columns`),
		references: {
			...(typeof references.schema === 'string'
				? { schema: references.schema }
				: {}),
			table: text(references.table, change.kind),
			columns: requiredColumnList(
				references.columns,
				`${change.kind} references.columns`,
			),
		},
		onDelete: typeof fk.onDelete === 'string' ? fk.onDelete : 'NO ACTION',
		onUpdate: typeof fk.onUpdate === 'string' ? fk.onUpdate : 'NO ACTION',
		deferred: fk.deferred === true,
		notValid: fk.notValid === true,
	};
}

/**
 * Capture the ModelIR/SchemaChange shape that the executor must read back.
 * This is deliberately assembled before SQL rendering becomes the only durable
 * source, and is therefore covered by the normalized managed-step digest.
 */
export function generatedPostconditionForChange(input: {
	readonly change: SchemaChange;
	readonly schema: string;
}): import('@dbsp/types').LedgerPayload | undefined {
	const { change, schema } = input;
	validateChangeKeyLists(change);
	if (change.kind === 'create_table' || change.kind === 'readdress_table') {
		const table = change.meta?.table;
		if (!table || typeof table !== 'object' || Array.isArray(table))
			throw new Error(
				`generator planning refuses ${change.kind}: missing typed table postcondition`,
			);
		const shape = table as import('@dbsp/types').TableIR;
		const primaryKey = new Set(
			shape.primaryKey === undefined
				? []
				: typeof shape.primaryKey === 'string'
					? [shape.primaryKey]
					: shape.primaryKey,
		);
		return postconditionPayload({
			kind: 'table',
			columns: shape.columns.map((column) =>
				columnPostcondition(column, schema, primaryKey.has(column.name)),
			),
		});
	}
	const column =
		change.kind === 'add_column'
			? requiredColumn(change.meta?.column, change.kind)
			: change.kind === 'alter_column_type' && change.meta?.column !== undefined
				? requiredColumn(change.meta.column, change.kind)
				: (change.kind === 'alter_column_collation' ||
							change.kind === 'alter_column_identity') &&
						change.meta?.column !== undefined
					? requiredColumn(change.meta.column, change.kind)
					: undefined;
	if (column) {
		const structural = columnPostcondition(column, schema);
		return postconditionPayload({
			kind: 'column',
			column: {
				...structural,
				...(change.kind === 'alter_column_collation'
					? { collation: column.collation ?? null }
					: {}),
				...(change.kind === 'alter_column_identity'
					? { identity: column.identity ?? null }
					: {}),
			},
		});
	}
	if (change.kind === 'alter_column_type') {
		// Older SchemaChange producers legitimately carry only the target SQL
		// bundle. Preserve that accepted planning surface; it is a deliberate
		// postcondition exemption because no trustworthy target type exists in
		// the change material to compare against catalogue state.
		return postconditionPayload({
			kind: 'exempt',
			reason: 'legacy alter_column_type has no typed target column',
		});
	}
	if (change.kind === 'alter_column_nullable') {
		const name = text(change.column, change.kind);
		const nullable = change.meta?.nullable;
		if (typeof nullable !== 'boolean')
			throw new Error(
				'generator planning refuses alter_column_nullable: missing typed nullable postcondition',
			);
		return postconditionPayload({
			kind: 'column',
			column: { name, nullable },
		});
	}
	if (change.kind === 'alter_column_default') {
		const name = text(change.column, change.kind);
		const hasDefault = change.meta?.default !== undefined;
		return postconditionPayload({
			kind: 'column',
			column: {
				name,
				hasDefault,
				...(hasDefault
					? {
							default: formatSqlDefault(
								change.meta?.default,
								'generator postcondition',
							),
						}
					: {}),
			},
		});
	}
	if (
		change.kind === 'add_primary_key' ||
		change.kind === 'add_foreign_key' ||
		change.kind === 'alter_foreign_key' ||
		change.kind === 'validate_constraint' ||
		change.kind === 'add_check_constraint' ||
		(change.kind === 'alter_column_unique' && change.destructive !== true)
	)
		return postconditionPayload({
			kind: 'constraint',
			constraint: constraintPostcondition(change),
		});
	if (change.kind === 'create_index') {
		const index = change.meta?.index as
			| import('@dbsp/types').IndexIR
			| undefined;
		if (!index)
			throw new Error(
				'generator planning refuses create_index: missing typed index postcondition',
			);
		return postconditionPayload({
			kind: 'index',
			definition: generateCreateIndex(
				change.table,
				index,
				schema,
				identityNaming,
			),
		});
	}
	if (change.kind === 'create_enum' || change.kind === 'alter_enum_add_value') {
		const enumDef = requiredRecord(change.meta?.enum, change.kind);
		return postconditionPayload({
			kind: 'enum',
			labels: requiredList(enumDef.values, change.kind),
		});
	}
	if (change.kind === 'create_sequence' || change.kind === 'alter_sequence') {
		const sequence = requiredRecord(change.meta?.sequence, change.kind);
		const numberProperty = (name: string): string | undefined =>
			typeof sequence[name] === 'number' ? String(sequence[name]) : undefined;
		const startValue = numberProperty('startWith');
		const incrementBy = numberProperty('incrementBy');
		const minValue = numberProperty('minValue');
		const maxValue = numberProperty('maxValue');
		return postconditionPayload({
			kind: 'sequence',
			...(startValue === undefined ? {} : { startValue }),
			...(incrementBy === undefined ? {} : { incrementBy }),
			...(minValue === undefined ? {} : { minValue }),
			...(maxValue === undefined ? {} : { maxValue }),
			...(typeof sequence.cycle === 'boolean' ? { cycle: sequence.cycle } : {}),
		});
	}
	if (change.kind === 'create_extension') {
		const version = change.meta?.extensionVersion;
		if (version !== undefined && typeof version !== 'string')
			throw new Error(
				'generator planning refuses create_extension: invalid typed extension version',
			);
		return postconditionPayload({
			kind: 'extension',
			...(typeof version === 'string' ? { version } : {}),
		});
	}
	if (
		change.kind === 'drop_table' ||
		change.kind === 'drop_column' ||
		change.kind === 'drop_primary_key' ||
		change.kind === 'drop_foreign_key' ||
		change.kind === 'drop_index' ||
		change.kind === 'drop_check_constraint' ||
		change.kind === 'drop_enum' ||
		change.kind === 'drop_extension' ||
		change.kind === 'drop_sequence' ||
		(change.kind === 'alter_column_unique' && change.destructive === true)
	)
		return postconditionPayload({ kind: 'absent' });
	throw new Error(
		`generator planning refuses ${change.kind}: no typed postcondition is available`,
	);
}

/**
 * The only change-kind boundary between diagnostic schema diffing and managed
 * execution.  Keep it at manifest construction: diagnostic-only controls must
 * never acquire an address, claim, reservation, or DDL bundle.
 */
export function assertDeclarableChangeKind(
	kind: ChangeKind,
): asserts kind is Exclude<
	ChangeKind,
	| 'enable_rls'
	| 'disable_rls'
	| 'create_policy'
	| 'drop_policy'
	| 'add_comment'
	| 'drop_comment'
> {
	switch (kind) {
		case 'enable_rls':
		case 'disable_rls':
		case 'create_policy':
		case 'drop_policy':
		case 'add_comment':
		case 'drop_comment':
			throw new Error(
				`generator planning refuses ${kind}: it is diagnostic-only and non-declarable`,
			);
		case 'create_table':
		case 'drop_table':
		case 'readdress_table':
		case 'add_column':
		case 'drop_column':
		case 'alter_column_type':
		case 'alter_column_nullable':
		case 'alter_column_default':
		case 'alter_column_unique':
		case 'add_primary_key':
		case 'drop_primary_key':
		case 'add_foreign_key':
		case 'drop_foreign_key':
		case 'alter_foreign_key':
		case 'validate_constraint':
		case 'create_index':
		case 'drop_index':
		case 'add_check_constraint':
		case 'drop_check_constraint':
		case 'create_enum':
		case 'alter_enum_add_value':
		case 'drop_enum':
		case 'alter_column_collation':
		case 'alter_column_identity':
		case 'create_extension':
		case 'drop_extension':
		case 'create_sequence':
		case 'alter_sequence':
		case 'drop_sequence':
			return;
	}
}

function text(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.length === 0)
		throw new Error(`generator planning refuses ${label}: missing typed name`);
	return value;
}

function stringList(value: unknown, label: string): readonly string[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some((item) => typeof item !== 'string' || item.trim().length === 0)
	)
		throw new Error(
			`generator planning refuses ${label}: missing typed columns`,
		);
	return value as readonly string[];
}

function named(meta: Meta | undefined, key: string, label: string): string {
	return text(meta?.[key], label);
}

function nestedName(
	meta: Meta | undefined,
	key: string,
	label: string,
): string {
	const item = meta?.[key];
	if (!item || typeof item !== 'object' || Array.isArray(item))
		throw new Error(
			`generator planning refuses ${label}: missing typed ${key}`,
		);
	return text((item as Record<string, unknown>).name, label);
}

function tableAddress(
	database: string,
	schema: string,
	table: string,
): Address {
	return {
		scope: 'schema',
		engine: 'postgresql',
		database,
		schema,
		kind: 'table',
		name: table,
	};
}

function childAddress(
	database: string,
	schema: string,
	kind: Extract<Address['kind'], 'column' | 'index' | 'constraint'>,
	name: string,
	table: string,
): Address {
	return {
		scope: 'schema',
		engine: 'postgresql',
		database,
		schema,
		kind,
		name,
		parent: canonicalResourceParent(tableAddress(database, schema, table)),
	};
}

export function addressForChange(input: {
	readonly change: SchemaChange;
	readonly database: string;
	readonly schema: string;
}): Address {
	const { change, database, schema } = input;
	const meta = change.meta;
	const column = () =>
		childAddress(
			database,
			schema,
			'column',
			text(change.column, change.kind),
			change.table,
		);
	const constraint = (name: string) =>
		childAddress(database, schema, 'constraint', name, change.table);
	const fkName = (fk: Readonly<Record<string, unknown>>) => {
		return `fk_${change.table}_${stringList(fk.columns, `${change.kind} columns`).join('_')}`;
	};
	switch (change.kind) {
		case 'create_table':
		case 'drop_table':
		case 'readdress_table':
		case 'enable_rls':
		case 'disable_rls':
			return tableAddress(database, schema, change.table);
		case 'add_column':
		case 'drop_column':
		case 'alter_column_type':
		case 'alter_column_nullable':
		case 'alter_column_default':
		case 'alter_column_collation':
		case 'alter_column_identity':
			return column();
		case 'alter_column_unique':
			return constraint(
				text(
					meta?.constraintName ??
						`${change.table}_${text(change.column, change.kind)}_key`,
					change.kind,
				),
			);
		case 'add_primary_key':
		case 'drop_primary_key':
			return constraint(`pk_${change.table}`);
		case 'add_foreign_key':
		case 'drop_foreign_key':
		case 'alter_foreign_key':
			return constraint(fkName(requiredRecord(meta?.fk, change.kind)));
		case 'validate_constraint': {
			const target = validateConstraintTarget(change);
			return constraint(
				target.kind === 'check'
					? text(target.check.name, change.kind)
					: fkName(target.fk),
			);
		}
		case 'create_index':
		case 'drop_index': {
			const index = meta?.index;
			if (!index || typeof index !== 'object' || Array.isArray(index))
				throw new Error(
					`generator planning refuses ${change.kind}: missing typed index`,
				);
			const record = index as Record<string, unknown>;
			const name =
				typeof record.name === 'string' && record.name.length > 0
					? record.name
					: `idx_${change.table}_${stringList(record.columns, change.kind).join('_')}`;
			return childAddress(database, schema, 'index', name, change.table);
		}
		case 'add_check_constraint':
		case 'drop_check_constraint':
			return constraint(nestedName(meta, 'check', change.kind));
		case 'create_enum':
		case 'alter_enum_add_value':
		case 'drop_enum':
			return {
				scope: 'schema',
				engine: 'postgresql',
				database,
				schema,
				kind: 'enum',
				name: nestedName(meta, 'enum', change.kind),
			};
		case 'create_extension':
		case 'drop_extension':
			return {
				scope: 'database',
				engine: 'postgresql',
				database,
				kind: 'extension',
				name: named(meta, 'extension', change.kind),
			};
		case 'create_sequence':
		case 'alter_sequence':
		case 'drop_sequence':
			return {
				scope: 'schema',
				engine: 'postgresql',
				database,
				schema,
				kind: 'sequence',
				name: nestedName(meta, 'sequence', change.kind),
			};
		case 'add_comment':
		case 'drop_comment':
		case 'create_policy':
		case 'drop_policy':
			throw new Error(
				`generator planning refuses ${change.kind}: it is diagnostic-only and non-declarable`,
			);
		default: {
			const exhaustive: never = change.kind;
			throw new Error(
				`generator planning refuses unsupported change kind ${exhaustive}`,
			);
		}
	}
}

function createsAddress(change: SchemaChange): boolean {
	if (change.kind === 'alter_column_unique') return change.destructive !== true;
	return new Set<ChangeKind>([
		'create_table',
		'add_column',
		'add_primary_key',
		'add_foreign_key',
		'create_index',
		'add_check_constraint',
		'create_enum',
		'create_extension',
		'create_sequence',
	]).has(change.kind);
}

/**
 * PostgreSQL's total ChangeKind-to-address producer.  The mapping is run at
 * plan time, so no executable generator step can later fall through to a
 * permissive "no managed address" branch.
 */
export function createPgsqlGeneratedManagedStep(input: {
	readonly change: SchemaChange;
	readonly database: string;
	readonly schema: string;
	readonly stepKey: string;
	readonly order: number;
	readonly dependencyOrder?: readonly string[];
	readonly statements: readonly string[];
}): NormalizedManagedStep {
	validateChangeKeyLists(input.change);
	assertDeclarableChangeKind(input.change.kind);
	const address = addressForChange(input);
	if (input.statements.length === 0 && input.change.kind !== 'readdress_table')
		throw new Error(
			`generator planning refuses ${input.change.kind}: adapter produced an empty statement bundle`,
		);
	const classification: GeneratedMutationClassification =
		classifyGeneratedMutation(input.change.kind, input.change);
	const claimKind: LedgerClaimKind =
		classification === 'removal'
			? 'retire-intent'
			: classification === 'paired-readdress'
				? 'readdress-intent'
				: 'intent';
	const expectedDeclaration = generatedPostconditionForChange({
		change: input.change,
		schema: input.schema,
	});
	return {
		stepKey: input.stepKey,
		order: input.order,
		segmentId: `generator-segment-${input.order}`,
		dependencyOrder: input.dependencyOrder ?? [],
		address,
		claimKind,
		plannedClaimKeys: [`${input.stepKey}:root`],
		statementBundle: {
			statements: input.statements.map((sql, ordinal) => ({ ordinal, sql })),
		},
		classification,
		requiresVacancy: createsAddress(input.change),
		...(expectedDeclaration === undefined ? {} : { expectedDeclaration }),
		replayPolicy: classification === 'removal' ? 'fresh-live-only' : 'recorded',
	};
}
