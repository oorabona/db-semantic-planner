import type {
	DeclarableResourceAddress,
	LedgerClaimKind,
	NormalizedManagedStep,
} from '@dbsp/types';
import {
	classifyGeneratedMutation,
	type GeneratedMutationClassification,
} from './destructive-classification.js';
import type { ChangeKind, SchemaChange } from './schema-diff.js';

type Address = DeclarableResourceAddress & {
	readonly scope: 'schema' | 'database';
};

type Meta = Readonly<Record<string, unknown>>;

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
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
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
		parent: tableAddress(database, schema, table),
	};
}

function addressForChange(input: {
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
	const fkName = () => {
		const fk = meta?.fk;
		if (!fk || typeof fk !== 'object' || Array.isArray(fk))
			throw new Error(
				`generator planning refuses ${change.kind}: missing typed foreign key`,
			);
		return `fk_${change.table}_${stringList((fk as Record<string, unknown>).columns, change.kind).join('_')}`;
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
		case 'validate_constraint':
			return constraint(
				meta?.check ? nestedName(meta, 'check', change.kind) : fkName(),
			);
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
	assertDeclarableChangeKind(input.change.kind);
	const address = addressForChange(input);
	if (input.statements.length === 0 && input.change.kind !== 'readdress_table')
		throw new Error(
			`generator planning refuses ${input.change.kind}: adapter produced an empty statement bundle`,
		);
	const classification: GeneratedMutationClassification =
		classifyGeneratedMutation(input.change.kind, input.change);
	const claimKind: LedgerClaimKind =
		classification === 'removal' ? 'retire-intent' : 'intent';
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
		replayPolicy: classification === 'removal' ? 'fresh-live-only' : 'recorded',
	};
}
