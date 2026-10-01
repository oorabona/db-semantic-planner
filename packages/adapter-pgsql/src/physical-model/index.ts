import {
	type CheckConstraintIR,
	type ColumnIR,
	createPhysicalNameInventory,
	type DbCasing,
	type EnumIR,
	type ForeignKeyIR,
	type IndexIR,
	type ModelIR,
	type PhysicalNameEntry,
	type PhysicalNameInventory,
	type PolicyIR,
	type RelationIR,
	type SequenceIR,
	type TableIR,
} from '@dbsp/types';
import { shouldEmitAutoFkIndex } from '../ddl/fk-index-coverage.js';
import {
	getNamingPluginForDbCasing,
	identityNaming,
	type NamingPlugin,
} from '../naming-plugin.js';
import {
	physicalizeDeclaredSequences,
	SequenceNameMapKeyMismatchError,
} from '../sequence-name.js';
import { validateIdentifier } from '../validate.js';

export type PgPhysicalModelInput =
	| {
			readonly mode: 'logical';
			readonly model: ModelIR;
			readonly schema: string;
			readonly dbCasing?: DbCasing;
			readonly naming?: NamingPlugin;
			readonly fkAutoIndex?: boolean;
	  }
	| {
			readonly mode: 'physical';
			readonly model: ModelIR;
			readonly schema: string;
			readonly fkAutoIndex?: boolean;
	  };

export type PgPhysicalNamespace =
	| 'pg_class'
	| 'pg_type'
	| 'column'
	| 'constraint'
	| 'policy';

export interface PgPhysicalNameClaim {
	readonly namespace: PgPhysicalNamespace;
	readonly schema: string;
	readonly table?: string;
	readonly physicalName: string;
	readonly logicalOrigin: string;
}

export interface PgPhysicalNameCollision {
	readonly namespace: PgPhysicalNamespace;
	readonly schema: string;
	readonly table?: string;
	readonly physicalName: string;
	readonly first: PgPhysicalNameClaim;
	readonly second: PgPhysicalNameClaim;
}

export class PgPhysicalNameCollisionError extends Error {
	constructor(public readonly collision: PgPhysicalNameCollision) {
		const scope = collision.table
			? ` schema "${collision.schema}" table "${collision.table}"`
			: ` schema "${collision.schema}"`;
		super(
			`PostgreSQL physical name collision in ${collision.namespace}${scope}: ` +
				`"${collision.physicalName}" is claimed by ${collision.first.logicalOrigin} and ${collision.second.logicalOrigin}`,
		);
		this.name = 'PgPhysicalNameCollisionError';
	}

	get namespace(): PgPhysicalNamespace {
		return this.collision.namespace;
	}
	get schema(): string {
		return this.collision.schema;
	}
	get table(): string | undefined {
		return this.collision.table;
	}
	get physicalName(): string {
		return this.collision.physicalName;
	}
	get first(): PgPhysicalNameClaim {
		return this.collision.first;
	}
	get second(): PgPhysicalNameClaim {
		return this.collision.second;
	}
}

/** Refusal raised before a physical model starts inspecting its input model. */
export class PgPhysicalModelInputError extends Error {
	constructor(public readonly reason: 'schema' | 'mode-options') {
		super(
			reason === 'schema'
				? 'PgPhysicalModel schema must be a non-empty string.'
				: 'PgPhysicalModel input has incompatible naming options for its mode.',
		);
		this.name = 'PgPhysicalModelInputError';
	}
}

export interface PgPhysicalModel {
	readonly mode: 'logical' | 'physical';
	readonly schema: string;
	readonly fkAutoIndex: boolean;
	readonly model: ModelIR;
	readonly inventory: PhysicalNameInventory;
	readonly claims: readonly PgPhysicalNameClaim[];
}

/** The only PostgreSQL templates for dbsp-selected constraint names. */
export function pgPrimaryKeyName(table: string): string {
	return truncateIdentifier(`pk_${table}`);
}
export function pgForeignKeyName(
	table: string,
	columns: readonly string[],
): string {
	return truncateIdentifier(`fk_${table}_${columns.join('_')}`);
}
export function pgUniqueConstraintName(table: string, column: string): string {
	return makeObjectName(table, column, 'key');
}

function pgIndexName(
	table: string,
	columns: readonly string[],
	declaredName: string | undefined,
): string {
	return truncateIdentifier(
		declaredName ?? `idx_${table}_${columns.join('_')}`,
	);
}

function pgAutoFkIndexName(table: string, column: string): string {
	return truncateIdentifier(`idx_${table}_${column}`);
}

/** Builds the sole PostgreSQL physical spelling of one model without rendering SQL. */
export function createPgPhysicalModel(
	input: PgPhysicalModelInput,
): PgPhysicalModel {
	assertInput(input);
	const physical = input.mode === 'logical';
	const naming = physical
		? (input.naming ??
			(input.dbCasing
				? getNamingPluginForDbCasing(input.dbCasing)
				: identityNaming))
		: identityNaming;
	const mappedNames = new Map<string, string>();
	const name = (value: string): string => {
		if (!physical) return value;
		const existing = mappedNames.get(value);
		if (existing !== undefined) return existing;
		const mapped = truncateIdentifier(naming.toDatabase(value));
		mappedNames.set(value, mapped);
		return mapped;
	};
	const derived = (value: string): string => truncateIdentifier(value);
	const fkAutoIndex = input.fkAutoIndex ?? true;
	const entries: PhysicalNameEntry[] = [];
	const claims = new ClaimCollector();
	const tableNames = new Map<string, string>();
	for (const table of input.model.tables.values())
		tableNames.set(table.name, name(table.name));

	const tables = new Map<string, TableIR>();
	for (const [tableKey, table] of input.model.tables) {
		const physicalTable = tableNames.get(table.name)!;
		const tableSchema = input.schema;
		entries.push(entry('table', tableSchema, table.name, physicalTable));
		claims.add(
			'pg_class',
			tableSchema,
			undefined,
			physicalTable,
			`table ${table.name}`,
		);
		claims.add(
			'pg_type',
			tableSchema,
			undefined,
			physicalTable,
			`table row type ${table.name}`,
		);
		if (physical)
			claims.add(
				'pg_type',
				tableSchema,
				undefined,
				derived(`_${physicalTable}`),
				`table array type ${table.name}`,
			);

		const columnNames = new Map<string, string>();
		for (const column of table.columns)
			columnNames.set(column.name, name(column.name));
		const columns = table.columns.map((column) => {
			const physicalColumn = columnNames.get(column.name)!;
			let uniqueConstraintName: string | undefined;
			entries.push(
				entry('column', tableSchema, table.name, column.name, physicalColumn),
			);
			claims.add(
				'column',
				tableSchema,
				physicalTable,
				physicalColumn,
				`column ${table.name}.${column.name}`,
			);
			if (
				column.unique &&
				(physical || column.uniqueConstraintName !== undefined)
			) {
				const logicalUnique = physical
					? `${table.name}_${column.name}_key`
					: column.uniqueConstraintName!;
				const physicalUnique = physical
					? pgUniqueConstraintName(physicalTable, physicalColumn)
					: column.uniqueConstraintName!;
				uniqueConstraintName = physicalUnique;
				entries.push(
					entry(
						'constraint',
						tableSchema,
						table.name,
						logicalUnique,
						physicalUnique,
					),
				);
				claims.add(
					'constraint',
					tableSchema,
					physicalTable,
					physicalUnique,
					`column-UNIQUE ${table.name}.${column.name}`,
				);
				claims.add(
					'pg_class',
					tableSchema,
					undefined,
					physicalUnique,
					`column-UNIQUE backing index ${table.name}.${column.name}`,
				);
			}
			if (physical && (column.autoIncrement || column.identity)) {
				const logicalSequence = `${table.name}_${column.name}_seq`;
				const physicalSequence = makeObjectName(
					physicalTable,
					physicalColumn,
					'seq',
				);
				entries.push({
					...entry('sequence', tableSchema, logicalSequence, physicalSequence),
					sequenceProvenance: 'generated',
				});
				claims.add(
					'pg_class',
					tableSchema,
					undefined,
					physicalSequence,
					`generated sequence ${table.name}.${column.name}`,
				);
			}
			return physicalizeColumn(column, physicalColumn, uniqueConstraintName);
		});

		const primaryKey = mapColumnList(table.primaryKey, columnNames, name);
		if (
			primaryKey !== undefined &&
			(physical || table.primaryKeyName !== undefined)
		) {
			const logicalPk = physical ? `pk_${table.name}` : table.primaryKeyName!;
			const physicalPk = physical
				? pgPrimaryKeyName(physicalTable)
				: table.primaryKeyName!;
			entries.push(
				entry('constraint', tableSchema, table.name, logicalPk, physicalPk),
			);
			claims.add(
				'constraint',
				tableSchema,
				physicalTable,
				physicalPk,
				`primary key ${table.name}`,
			);
			claims.add(
				'pg_class',
				tableSchema,
				undefined,
				physicalPk,
				`primary-key index ${table.name}`,
			);
		}

		const foreignKeys = table.foreignKeys.map((foreignKey) => {
			const columnsForFk = foreignKey.columns.map(
				(column) => columnNames.get(column) ?? name(column),
			);
			const logicalFk = physical
				? `fk_${table.name}_${foreignKey.columns.join('_')}`
				: foreignKey.name;
			const physicalFk = physical
				? pgForeignKeyName(physicalTable, columnsForFk)
				: foreignKey.name;
			if (physicalFk !== undefined) {
				entries.push(
					entry('constraint', tableSchema, table.name, logicalFk!, physicalFk),
				);
				claims.add(
					'constraint',
					tableSchema,
					physicalTable,
					physicalFk,
					`foreign key ${table.name}.${foreignKey.columns.join(',')}`,
				);
			}
			const autoIndexName =
				physical &&
				fkAutoIndex &&
				columnsForFk.length === 1 &&
				columnsForFk[0] !== undefined &&
				shouldEmitAutoFkIndex(table, foreignKey.columns[0]!)
					? pgAutoFkIndexName(physicalTable, columnsForFk[0])
					: foreignKey.autoIndexName;
			return Object.freeze({
				...cloneRecord(foreignKey),
				columns: Object.freeze(columnsForFk),
				references: Object.freeze({
					...cloneRecord(foreignKey.references),
					table:
						tableNames.get(foreignKey.references.table) ??
						name(foreignKey.references.table),
					columns: Object.freeze(foreignKey.references.columns.map(name)),
				}),
				...(physicalFk === undefined ? {} : { name: physicalFk }),
				...(autoIndexName === undefined ? {} : { autoIndexName }),
			});
		});

		const indexes = table.indexes.map((index) => {
			const physicalColumns = index.columns.map(
				(column) => columnNames.get(column) ?? name(column),
			);
			const logicalIndex = physical
				? (index.name ?? `idx_${table.name}_${index.columns.join('_')}`)
				: index.name;
			const named = index.name === undefined ? undefined : name(index.name);
			const physicalIndex = physical
				? pgIndexName(physicalTable, physicalColumns, named)
				: named;
			if (physicalIndex !== undefined) {
				entries.push(
					entry('index', tableSchema, table.name, logicalIndex!, physicalIndex),
				);
				claims.add(
					'pg_class',
					tableSchema,
					undefined,
					physicalIndex,
					`declared index ${table.name}.${logicalIndex}`,
				);
			}
			return physicalizeIndex(
				index,
				physicalColumns,
				physicalIndex,
				columnNames,
				name,
			);
		});

		for (const [index, foreignKey] of foreignKeys.entries()) {
			if (foreignKey.autoIndexName === undefined) continue;
			const logicalColumn = table.foreignKeys[index]?.columns[0];
			if (logicalColumn === undefined) continue;
			entries.push(
				entry(
					'index',
					tableSchema,
					table.name,
					physical
						? `idx_${table.name}_${logicalColumn}`
						: foreignKey.autoIndexName,
					foreignKey.autoIndexName,
				),
			);
			claims.add(
				'pg_class',
				tableSchema,
				undefined,
				foreignKey.autoIndexName,
				`automatic foreign-key index ${table.name}.${foreignKey.columns[0]}`,
			);
		}

		const checkConstraints = table.checkConstraints?.map((check) => {
			const physicalCheck = name(check.name);
			entries.push(
				entry('constraint', tableSchema, table.name, check.name, physicalCheck),
			);
			claims.add(
				'constraint',
				tableSchema,
				physicalTable,
				physicalCheck,
				`CHECK ${table.name}.${check.name}`,
			);
			return Object.freeze({ ...cloneRecord(check), name: physicalCheck });
		});
		const policies = table.policies?.map((policy) => {
			const physicalPolicy = name(policy.name);
			entries.push(
				entry('policy', tableSchema, table.name, policy.name, physicalPolicy),
			);
			claims.add(
				'policy',
				tableSchema,
				physicalTable,
				physicalPolicy,
				`policy ${table.name}.${policy.name}`,
			);
			return Object.freeze({ ...cloneRecord(policy), name: physicalPolicy });
		});

		const partition = table.partition
			? Object.freeze({
					...cloneRecord(table.partition),
					columns: Object.freeze(
						table.partition.columns.map(
							(column) => columnNames.get(column) ?? name(column),
						),
					),
				})
			: undefined;
		const readdress = table.readdress
			? Object.freeze({
					from: Object.freeze({
						...cloneRecord(table.readdress.from),
						name: name(table.readdress.from.name),
					}),
					to: Object.freeze({
						...cloneRecord(table.readdress.to),
						name: name(table.readdress.to.name),
					}),
				})
			: undefined;
		const pseudoColumns = table.pseudoColumns?.map((pseudoColumn) =>
			Object.freeze({
				...cloneRecord(pseudoColumn),
				table: physicalTable,
				foreignKeyColumn:
					columnNames.get(pseudoColumn.foreignKeyColumn) ??
					name(pseudoColumn.foreignKeyColumn),
				targetColumn:
					columnNames.get(pseudoColumn.targetColumn) ??
					name(pseudoColumn.targetColumn),
			}),
		);
		const copiedTable: TableIR = {
			...cloneRecord(table),
			name: physicalTable,
			columns: Object.freeze(columns),
			foreignKeys: Object.freeze(foreignKeys),
			indexes: Object.freeze(indexes),
			...(primaryKey === undefined ? {} : { primaryKey }),
			...(primaryKey === undefined ||
			(!physical && table.primaryKeyName === undefined)
				? {}
				: {
						primaryKeyName: physical
							? pgPrimaryKeyName(physicalTable)
							: table.primaryKeyName,
					}),
			...(checkConstraints === undefined
				? {}
				: { checkConstraints: Object.freeze(checkConstraints) }),
			...(policies === undefined ? {} : { policies: Object.freeze(policies) }),
			...(partition === undefined ? {} : { partition }),
			...(readdress === undefined ? {} : { readdress }),
			...(pseudoColumns === undefined
				? {}
				: { pseudoColumns: Object.freeze(pseudoColumns) }),
		};
		tables.set(physical ? physicalTable : tableKey, Object.freeze(copiedTable));
	}

	const enums = new Map<string, EnumIR>();
	for (const [key, value] of input.model.enums ?? []) {
		const enumSchema = physical ? input.schema : (value.schema ?? input.schema);
		const copied = Object.freeze(cloneRecord(value));
		enums.set(key, copied);
		entries.push(entry('enum', enumSchema, value.name, value.name));
		claims.add(
			'pg_type',
			enumSchema,
			undefined,
			value.name,
			`enum ${value.name}`,
		);
		if (physical)
			claims.add(
				'pg_type',
				enumSchema,
				undefined,
				derived(`_${value.name}`),
				`enum array type ${value.name}`,
			);
	}
	const sequenceNaming: NamingPlugin = {
		resolve: (value) => truncateIdentifier(naming.resolve(value)),
		model: (value) => naming.model(value),
		toDatabase: (value) => truncateIdentifier(naming.toDatabase(value)),
		toModel: (value) => naming.toModel(value),
	};
	const authoredSequences = physicalizeDeclaredSequences(
		input.model.sequences,
		sequenceNaming,
	);
	const sequences = new Map<string, SequenceIR>();
	for (const [key, sequence] of input.model.sequences ?? []) {
		if (key !== sequence.name)
			throw new SequenceNameMapKeyMismatchError(key, sequence.name);
		const sequenceSchema = physical
			? input.schema
			: (sequence.schema ?? input.schema);
		const physicalSequence = name(sequence.name);
		const physicalSequenceDefinition = authoredSequences.get(physicalSequence);
		if (physicalSequenceDefinition === undefined)
			throw new Error(`physical sequence ${sequence.name} was not resolved`);
		const copied = Object.freeze({
			...cloneRecord(physicalSequenceDefinition),
		});
		sequences.set(physicalSequence, copied);
		entries.push({
			...entry('sequence', sequenceSchema, sequence.name, physicalSequence),
			sequenceProvenance: 'declared',
		});
		claims.add(
			'pg_class',
			sequenceSchema,
			undefined,
			physicalSequence,
			`standalone sequence ${sequence.name}`,
		);
	}

	// A logical model is dbsp's emitted vocabulary, so reject a claimed name
	// (schema or object) its renderers cannot represent before returning it.
	// Other identifiers the renderers read (referenced schemas, roles,
	// collations, opclasses, methods, storage keys) are validated when SQL is
	// rendered, before any statement runs.  Physical input is an
	// introspected PostgreSQL catalogue: building its model does not narrow
	// the quoted identifiers PostgreSQL accepted, so comparison can read any
	// catalogue.  Rendering SQL from such a model still applies the renderers'
	// identifier rule.
	if (physical) {
		validateIdentifier(input.schema, 'schema');
		for (const claim of claims.values) {
			validateIdentifier(claim.physicalName, 'alias');
		}
	}
	const copiedModel = createModel(
		input.model,
		tables,
		enums,
		sequences,
		physical ? name : (value) => value,
	);
	const inventory = createPhysicalNameInventory(entries);
	return Object.freeze({
		mode: input.mode,
		schema: input.schema,
		fkAutoIndex,
		model: copiedModel,
		inventory,
		claims: Object.freeze(claims.values),
	});
}

const tableFields = {
	name: 'map',
	readdress: 'map',
	adopt: 'preserve',
	replace: 'preserve',
	logicalIdentity: 'preserve',
	columns: 'map',
	primaryKey: 'map',
	primaryKeyName: 'map',
	foreignKeys: 'map',
	indexes: 'map',
	checkConstraints: 'map',
	pseudoColumns: 'map',
	comment: 'preserve',
	partition: 'map',
	rlsEnabled: 'preserve',
	policies: 'map',
} satisfies Record<keyof TableIR, 'map' | 'preserve'>;
const columnFields = {
	name: 'map',
	logicalIdentity: 'preserve',
	type: 'preserve',
	js: 'preserve',
	nullable: 'preserve',
	default: 'preserve',
	originalDbType: 'preserve',
	originalDbTypeSchema: 'preserve',
	originalDbTypeSchemaScope: 'preserve',
	unique: 'preserve',
	uniqueConstraintName: 'preserve',
	autoIncrement: 'preserve',
	collation: 'preserve',
	comment: 'preserve',
	identity: 'preserve',
} satisfies Record<keyof ColumnIR, 'map' | 'preserve'>;
const indexFields = {
	name: 'map',
	columns: 'map',
	unique: 'preserve',
	valid: 'preserve',
	ready: 'preserve',
	nullsNotDistinct: 'preserve',
	method: 'preserve',
	where: 'preserve',
	expressions: 'preserve',
	include: 'map',
	opclass: 'map',
	with: 'preserve',
} satisfies Record<keyof IndexIR, 'map' | 'preserve'>;
const foreignKeyFields = {
	name: 'map',
	autoIndexName: 'map',
	columns: 'map',
	references: 'map',
	onDelete: 'preserve',
	onUpdate: 'preserve',
	deferred: 'preserve',
	notValid: 'preserve',
} satisfies Record<keyof ForeignKeyIR, 'map' | 'preserve'>;
const checkConstraintFields = {
	name: 'map',
	expression: 'preserve',
	notValid: 'preserve',
	requiresEnumLabels: 'preserve',
} satisfies Record<keyof CheckConstraintIR, 'map' | 'preserve'>;
const policyFields = {
	name: 'map',
	command: 'preserve',
	roles: 'preserve',
	permissive: 'preserve',
	using: 'preserve',
	withCheck: 'preserve',
} satisfies Record<keyof PolicyIR, 'map' | 'preserve'>;
const sequenceFields = {
	name: 'map',
	adopt: 'preserve',
	startWith: 'preserve',
	incrementBy: 'preserve',
	minValue: 'preserve',
	maxValue: 'preserve',
	cycle: 'preserve',
	schema: 'preserve',
} satisfies Record<keyof SequenceIR, 'map' | 'preserve'>;
void [
	tableFields,
	columnFields,
	indexFields,
	foreignKeyFields,
	checkConstraintFields,
	policyFields,
	sequenceFields,
];

function assertInput(input: PgPhysicalModelInput): void {
	if (typeof input.schema !== 'string' || input.schema.length === 0)
		throw new PgPhysicalModelInputError('schema');
	if (
		(input.mode === 'physical' && ('naming' in input || 'dbCasing' in input)) ||
		(input.mode === 'logical' && 'naming' in input && 'dbCasing' in input)
	)
		throw new PgPhysicalModelInputError('mode-options');
}

function physicalizeColumn(
	column: ColumnIR,
	name: string,
	uniqueConstraintName: string | undefined,
): ColumnIR {
	return Object.freeze({
		...cloneRecord(column),
		name,
		...(uniqueConstraintName === undefined ? {} : { uniqueConstraintName }),
	});
}

function physicalizeIndex(
	index: IndexIR,
	columns: readonly string[],
	name: string | undefined,
	columnNames: ReadonlyMap<string, string>,
	map: (value: string) => string,
): IndexIR {
	const opclass = index.opclass
		? Object.freeze(
				Object.fromEntries(
					Object.entries(index.opclass).map(([key, value]) => [
						columnNames.get(key) ?? map(key),
						value,
					]),
				),
			)
		: undefined;
	return Object.freeze({
		...cloneRecord(index),
		...(name === undefined ? {} : { name }),
		columns: Object.freeze([...columns]),
		...(index.include === undefined
			? {}
			: {
					include: Object.freeze(
						index.include.map(
							(column) => columnNames.get(column) ?? map(column),
						),
					),
				}),
		...(opclass === undefined ? {} : { opclass }),
	});
}

function mapColumnList(
	primaryKey: TableIR['primaryKey'],
	columns: ReadonlyMap<string, string>,
	map: (value: string) => string,
): TableIR['primaryKey'] {
	if (primaryKey === undefined) return undefined;
	if (typeof primaryKey === 'string')
		return columns.get(primaryKey) ?? map(primaryKey);
	return Object.freeze(
		primaryKey.map((column) => columns.get(column) ?? map(column)),
	);
}

function createModel(
	model: ModelIR,
	tables: ReadonlyMap<string, TableIR>,
	enums: ReadonlyMap<string, EnumIR>,
	sequences: ReadonlyMap<string, SequenceIR>,
	map: (value: string) => string,
): ModelIR {
	const relations = new Map<string, RelationIR>();
	for (const [key, relation] of model.relations ?? []) {
		void key;
		const copiedRelation = Object.freeze({
			...cloneRecord(relation),
			source: map(relation.source),
			target: map(relation.target),
			...(relation.through === undefined
				? {}
				: { through: map(relation.through) }),
			...(relation.foreignKey === undefined
				? {}
				: { foreignKey: mapNameList(relation.foreignKey, map) }),
			...(relation.otherKey === undefined
				? {}
				: { otherKey: map(relation.otherKey) }),
			...(relation.sourceKey === undefined
				? {}
				: { sourceKey: mapNameList(relation.sourceKey, map) }),
			...(relation.targetKey === undefined
				? {}
				: { targetKey: mapNameList(relation.targetKey, map) }),
		});
		relations.set(
			`${copiedRelation.source}.${copiedRelation.name}`,
			copiedRelation,
		);
	}
	const readonlyTables = readOnlyMap(tables);
	const readonlyRelations = readOnlyMap(relations);
	const copied: ModelIR = {
		tables: readonlyTables,
		relations: readonlyRelations,
		...(model.extensions === undefined
			? {}
			: { extensions: Object.freeze([...model.extensions]) }),
		...(model.enums === undefined ? {} : { enums: readOnlyMap(enums) }),
		...(model.sequences === undefined
			? {}
			: { sequences: readOnlyMap(sequences) }),
		...(model.externalTables === undefined
			? {}
			: {
					externalTables: readOnlySet(
						new Set([...model.externalTables].map(map)),
					),
				}),
		getTable(name: string) {
			return readonlyTables.get(name);
		},
		getRelation(qualifiedName: string) {
			return readonlyRelations.get(qualifiedName);
		},
		getRelationsFrom(source: string) {
			return Object.freeze(
				[...relations.values()].filter(
					(relation) => relation.source === source,
				),
			);
		},
		getRelationsTo(target: string) {
			return Object.freeze(
				[...relations.values()].filter(
					(relation) => relation.target === target,
				),
			);
		},
		isAmbiguous(source: string, target: string) {
			const options = [...relations.values()]
				.filter(
					(relation) =>
						relation.source === source && relation.target === target,
				)
				.map((relation) => relation.name);
			return Object.freeze({
				ambiguous: options.length > 1,
				options: Object.freeze(options),
			});
		},
	};
	return Object.freeze(copied);
}

/** Map/Set objects cannot be frozen into immutability; expose mutation traps instead. */
function readOnlyMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
	const values = new Map(source);
	let facade: ReadonlyMap<K, V>;
	facade = Object.freeze(
		new Proxy(values, {
			get(target, property) {
				if (property === 'set' || property === 'delete' || property === 'clear')
					return () => {
						throw new TypeError('PgPhysicalModel collections are read-only');
					};
				if (property === 'forEach')
					return (
						callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
						thisArg?: unknown,
					) =>
						target.forEach((value, key) => {
							callback.call(thisArg, value, key, facade);
						});
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}),
	) as ReadonlyMap<K, V>;
	return facade;
}

function readOnlySet<T>(source: ReadonlySet<T>): ReadonlySet<T> {
	const values = new Set(source);
	let facade: ReadonlySet<T>;
	facade = Object.freeze(
		new Proxy(values, {
			get(target, property) {
				if (property === 'add' || property === 'delete' || property === 'clear')
					return () => {
						throw new TypeError('PgPhysicalModel collections are read-only');
					};
				if (property === 'forEach')
					return (
						callback: (value: T, key: T, set: ReadonlySet<T>) => void,
						thisArg?: unknown,
					) =>
						target.forEach((value, key) => {
							callback.call(thisArg, value, key, facade);
						});
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}),
	) as ReadonlySet<T>;
	return facade;
}

function mapNameList(
	value: string | readonly string[],
	map: (value: string) => string,
): string | readonly string[] {
	return typeof value === 'string' ? map(value) : Object.freeze(value.map(map));
}

function entry(
	kind: 'table' | 'enum' | 'sequence',
	schema: string,
	name: string,
	physical: string,
): PhysicalNameEntry;
function entry(
	kind: 'column' | 'index' | 'constraint' | 'policy',
	schema: string,
	table: string,
	name: string,
	physical: string,
): PhysicalNameEntry;
function entry(
	kind: PhysicalNameEntry['logical']['kind'],
	schema: string,
	a: string,
	b: string,
	c?: string,
): PhysicalNameEntry {
	return c === undefined
		? {
				logical: {
					kind: kind as 'table' | 'enum' | 'sequence',
					schema,
					name: a,
				},
				physical: b,
			}
		: {
				logical: {
					kind: kind as 'column' | 'index' | 'constraint' | 'policy',
					schema,
					table: a,
					name: b,
				},
				physical: c,
			};
}

class ClaimCollector {
	readonly values: PgPhysicalNameClaim[] = [];
	#seen = new Map<string, PgPhysicalNameClaim>();
	add(
		namespace: PgPhysicalNamespace,
		schema: string,
		table: string | undefined,
		physicalName: string,
		logicalOrigin: string,
	): void {
		const claim = Object.freeze({
			namespace,
			schema,
			...(table === undefined ? {} : { table }),
			physicalName,
			logicalOrigin,
		});
		const key = `${namespace}\u0000${schema}\u0000${table ?? ''}\u0000${physicalName}`;
		const first = this.#seen.get(key);
		if (first)
			throw new PgPhysicalNameCollisionError({
				namespace,
				schema,
				...(table === undefined ? {} : { table }),
				physicalName,
				first,
				second: claim,
			});
		this.#seen.set(key, claim);
		this.values.push(claim);
	}
}

/** PostgreSQL's NAMEDATALEN-1 byte truncation, without splitting UTF-8 code points. */
function truncateIdentifier(value: string): string {
	if (Buffer.byteLength(value, 'utf8') <= 63) return value;
	let bytes = 0;
	let result = '';
	for (const character of value) {
		const size = Buffer.byteLength(character, 'utf8');
		if (bytes + size > 63) break;
		result += character;
		bytes += size;
	}
	return result;
}

/** Faithful port of PostgreSQL makeObjectName's two-name-part shortening rule. */
function makeObjectName(name1: string, name2: string, label: string): string {
	let first = name1;
	let second = name2;
	while (Buffer.byteLength(`${first}_${second}_${label}`, 'utf8') > 63) {
		if (Buffer.byteLength(first, 'utf8') >= Buffer.byteLength(second, 'utf8'))
			first = truncateBytes(first, Buffer.byteLength(first, 'utf8') - 1);
		else second = truncateBytes(second, Buffer.byteLength(second, 'utf8') - 1);
	}
	return `${first}_${second}_${label}`;
}

function truncateBytes(value: string, maximum: number): string {
	let bytes = 0;
	let result = '';
	for (const character of value) {
		const size = Buffer.byteLength(character, 'utf8');
		if (bytes + size > maximum) break;
		result += character;
		bytes += size;
	}
	return result;
}

function cloneRecord<T extends object>(value: T): T {
	return clone(value) as T;
}
function clone(value: unknown): unknown {
	if (Array.isArray(value)) return Object.freeze(value.map(clone));
	if (value instanceof Map)
		return new Map([...value].map(([key, item]) => [clone(key), clone(item)]));
	if (value instanceof Set) return new Set([...value].map(clone));
	if (value !== null && typeof value === 'object')
		return Object.freeze(
			Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, clone(item)]),
			),
		);
	return value;
}
