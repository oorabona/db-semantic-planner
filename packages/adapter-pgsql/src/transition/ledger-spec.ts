import { validateIdentifier } from '../validate.js';
import {
	DBSP_LEDGER_EVENT_TABLE,
	DBSP_LEDGER_IDENTITY_TABLE,
	DBSP_LEDGER_MARKER_TABLE,
	DBSP_LEDGER_RESERVATION_TABLE,
	type DBSP_LEDGER_TABLES,
	DBSP_META_SCHEMA,
} from './constants.js';

/** This is the sole authored description of the durable PostgreSQL ledger. */
export type LedgerSpecTarget = Readonly<{
	scope: 'database' | 'schema';
	schema?: string;
}>;

export type LedgerColumnSpec = Readonly<{
	name: string;
	type: string;
	nullable: boolean;
	defaultSql?: string;
}>;
export type LedgerConstraintSpec = Readonly<{
	name: string;
	type: 'c' | 'f' | 'p' | 'u';
	sql: (target: LedgerSpecTarget) => string;
	columns?: readonly string[];
	referencedTable?: string;
	referencedColumns?: readonly string[];
	nullsNotDistinct?: boolean;
}>;
export type LedgerIndexSpec = Readonly<{
	name: string;
	columns: readonly string[];
	unique?: boolean;
	nullsNotDistinct?: boolean;
	valid: boolean;
	ready: boolean;
}>;
export type LedgerTableSpec = Readonly<{
	name: (typeof DBSP_LEDGER_TABLES)[number];
	columns: readonly LedgerColumnSpec[];
	constraints: readonly LedgerConstraintSpec[];
	indexes?: readonly LedgerIndexSpec[];
}>;

const events = [
	'adopt-intent',
	'adopt',
	'intent',
	'retire-intent',
	'readdress-intent',
	'refused',
	'executing',
	'observed',
	'absent',
	'indeterminate',
	'resolved',
	'readdressed-to',
	'readdressed-from',
	'released',
] as const;
const eventKindsSql = events.map((kind) => `'${kind}'`).join(', ');
const address = [
	'address_engine',
	'address_database',
	'address_schema',
	'address_parent',
	'address_kind',
	'address_name',
] as const;
export const PG_LEDGER_ADDRESS_COLUMNS = address;
export const PG_LEDGER_RELATION_KIND = 'r' as const;
export const PG_LEDGER_CONSTRAINT_PROPERTIES = {
	deferrable: false,
	initiallyDeferred: false,
	validated: true,
} as const;
const addressSql = () => address.join(', ');

function quote(value: string, type: 'schema' | 'table'): string {
	validateIdentifier(value, type);
	return `"${value.replaceAll('"', '""')}"`;
}
export function ledgerSpecSchema(target: LedgerSpecTarget): string {
	if (target.scope === 'database') return DBSP_META_SCHEMA;
	if (!target.schema)
		throw new Error('schema ledger target is missing its schema');
	return target.schema;
}
function table(target: LedgerSpecTarget, name: string): string {
	return `${quote(ledgerSpecSchema(target), 'schema')}.${quote(name, 'table')}`;
}
const cols = (
	items: readonly [string, string, boolean, string?][],
): LedgerColumnSpec[] =>
	items.map(([name, type, nullable, defaultSql]) => ({
		name,
		type,
		nullable,
		...(defaultSql ? { defaultSql } : {}),
	}));

export const PG_LEDGER_SPEC: readonly LedgerTableSpec[] = [
	{
		name: DBSP_LEDGER_EVENT_TABLE,
		columns: cols([
			['event_id', 'text', false],
			['address_engine', 'text', false],
			['address_database', 'text', false],
			['address_schema', 'text', false],
			['address_parent', 'jsonb', false],
			['address_kind', 'text', false],
			['address_name', 'text', false],
			['execution_id', 'text', true],
			['planned_claim_key', 'text', true],
			['claim_group_id', 'text', true],
			['root_claim_id', 'text', true],
			['catalogue_identity', 'jsonb', true],
			['event_kind', 'text', false],
			['predecessor', 'text', true],
			['pair_id', 'text', true],
			['declared', 'jsonb', true],
			['declared_digest', 'text', true],
			['observed', 'jsonb', true],
			['observed_digest', 'text', true],
			['refusal_code', 'text', true],
			['refusal_cause', 'text', true],
			['refusal_state', 'text', true],
			['refusal_withheld_authority', 'text', true],
			['refusal_resolving_command', 'text', true],
			['controller', 'name', false, 'current_user'],
			['controller_oid', 'oid', false, 'current_user::regrole::oid'],
			['recorded_at', 'timestamp with time zone', false, 'now()'],
		]),
		constraints: [
			{
				name: 'dbsp_ledger_event_pkey',
				type: 'p',
				columns: ['event_id'],
				sql: () => 'PRIMARY KEY (event_id)',
			},
			{
				name: 'dbsp_ledger_event_kind_closed',
				type: 'c',
				sql: () => `CHECK (event_kind IN (${eventKindsSql}))`,
			},
			{
				name: 'dbsp_ledger_declared_digest_pair',
				type: 'c',
				sql: () => 'CHECK ((declared IS NULL) = (declared_digest IS NULL))',
			},
			{
				name: 'dbsp_ledger_observed_digest_pair',
				type: 'c',
				sql: () => 'CHECK ((observed IS NULL) = (observed_digest IS NULL))',
			},
			{
				name: 'dbsp_ledger_refusal_payload',
				type: 'c',
				sql: () =>
					"CHECK ((event_kind = 'refused') = (refusal_code IS NOT NULL AND refusal_cause IS NOT NULL AND refusal_state IS NOT NULL AND refusal_withheld_authority IS NOT NULL AND refusal_resolving_command IS NOT NULL))",
			},
			{
				name: 'dbsp_ledger_event_address_event_unique',
				type: 'u',
				columns: [...address, 'event_id'],
				sql: () => `UNIQUE (${addressSql()}, event_id)`,
			},
			{
				name: 'dbsp_ledger_event_one_child',
				type: 'u',
				columns: [...address, 'predecessor'],
				nullsNotDistinct: true,
				sql: () => `UNIQUE NULLS NOT DISTINCT (${addressSql()}, predecessor)`,
			},
			{
				name: 'dbsp_ledger_event_same_address_predecessor',
				type: 'f',
				columns: [...address, 'predecessor'],
				referencedTable: DBSP_LEDGER_EVENT_TABLE,
				referencedColumns: [...address, 'event_id'],
				sql: (target) =>
					`FOREIGN KEY (${addressSql()}, predecessor) REFERENCES ${table(target, DBSP_LEDGER_EVENT_TABLE)} (${addressSql()}, event_id)`,
			},
		],
		indexes: [
			{
				name: 'dbsp_ledger_event_terminal_member',
				columns: ['predecessor'],
				unique: false,
				valid: true,
				ready: true,
			},
		],
	},
	{
		name: DBSP_LEDGER_RESERVATION_TABLE,
		columns: cols([
			['address_engine', 'text', false],
			['address_database', 'text', false],
			['address_schema', 'text', false],
			['address_parent', 'jsonb', false],
			['address_kind', 'text', false],
			['address_name', 'text', false],
			['claim_kind', 'text', false],
			['execution_id', 'text', false],
			['pair_id', 'text', true],
			['root_claim_id', 'text', false],
			['home_ledger_scope', 'text', false],
			['home_ledger_schema', 'text', true],
		]),
		constraints: [
			{
				name: 'dbsp_ledger_reservation_pkey',
				type: 'p',
				columns: address,
				sql: () => `PRIMARY KEY (${addressSql()})`,
			},
			{
				name: 'dbsp_ledger_reservation_claim_kind_check',
				type: 'c',
				sql: () =>
					"CHECK (claim_kind IN ('adopt-intent', 'intent', 'retire-intent', 'readdress-intent'))",
			},
			{
				name: 'dbsp_ledger_reservation_home_ledger_scope_check',
				type: 'c',
				sql: () => "CHECK (home_ledger_scope IN ('schema', 'database'))",
			},
			{
				name: 'dbsp_ledger_reservation_check',
				type: 'c',
				sql: () =>
					"CHECK ((home_ledger_scope = 'database' AND home_ledger_schema IS NULL) OR (home_ledger_scope = 'schema' AND home_ledger_schema IS NOT NULL))",
			},
		],
	},
	{
		name: DBSP_LEDGER_IDENTITY_TABLE,
		columns: cols([
			['id', 'boolean', false, 'true'],
			['cluster_system_identifier', 'text', false],
			['database_oid', 'text', false],
			['namespace_oid', 'text', true],
		]),
		constraints: [
			{
				name: 'dbsp_ledger_identity_pkey',
				type: 'p',
				columns: ['id'],
				sql: () => 'PRIMARY KEY (id)',
			},
			{
				name: 'dbsp_ledger_identity_id_check',
				type: 'c',
				sql: () => 'CHECK (id)',
			},
		],
	},
	{
		name: DBSP_LEDGER_MARKER_TABLE,
		columns: cols([
			['id', 'boolean', false, 'true'],
			['version', 'integer', false],
		]),
		constraints: [
			{
				name: 'dbsp_ledger_marker_pkey',
				type: 'p',
				columns: ['id'],
				sql: () => 'PRIMARY KEY (id)',
			},
			{
				name: 'dbsp_ledger_marker_id_check',
				type: 'c',
				sql: () => 'CHECK (id)',
			},
			{
				name: 'dbsp_ledger_marker_version_check',
				type: 'c',
				sql: () => 'CHECK (version >= 1)',
			},
		],
	},
];

export function renderCreateLedgerTableFromSpec(
	target: LedgerSpecTarget,
	definition: LedgerTableSpec,
): string {
	const columns = definition.columns.map(
		(column) =>
			`${column.name} ${column.type}${column.nullable ? '' : ' NOT NULL'}${column.defaultSql ? ` DEFAULT ${column.defaultSql}` : ''}`,
	);
	const constraints = definition.constraints.map(
		(constraint) =>
			`CONSTRAINT ${quote(constraint.name, 'table')} ${constraint.sql(target)}`,
	);
	return `CREATE TABLE IF NOT EXISTS ${table(target, definition.name)} (${[...columns, ...constraints].join(', ')})`;
}
export function renderCreateLedgerIndexFromSpec(
	target: LedgerSpecTarget,
	definition: LedgerTableSpec,
	index: LedgerIndexSpec,
): string {
	return `CREATE INDEX IF NOT EXISTS ${quote(index.name, 'table')} ON ${table(target, definition.name)} (${index.columns.join(', ')})`;
}
export const LEDGER_IMMUTABILITY_FUNCTION_NAME =
	'dbsp_ledger_reject_event_mutation';
export const LEDGER_IMMUTABILITY_FUNCTION_BODY =
	" BEGIN IF TG_OP = 'INSERT' THEN NEW.controller := current_user; NEW.controller_oid := current_user::regrole::oid; RETURN NEW; END IF; RAISE EXCEPTION 'dbsp ledger events are append-only for address %', OLD.address_name USING ERRCODE = '55000'; END; ";
export const PG_LEDGER_IMMUTABILITY_TRIGGER_SPEC = {
	name: 'dbsp_ledger_event_immutable',
	tableName: DBSP_LEDGER_EVENT_TABLE,
	enabled: 'O',
	type: '31',
	arguments: '',
	deferrable: false,
	initiallyDeferred: false,
	functionName: LEDGER_IMMUTABILITY_FUNCTION_NAME,
	functionIdentityArguments: '',
	functionResult: 'trigger',
	functionLanguage: 'plpgsql',
	functionKind: 'f',
	functionVolatility: 'v',
	functionIsStrict: false,
	functionIsSecurityDefiner: false,
	functionIsLeakproof: false,
	functionConfigIsNull: true,
	functionBody: LEDGER_IMMUTABILITY_FUNCTION_BODY,
} as const;
export function renderCreateLedgerImmutabilityFunctionFromSpec(
	target: LedgerSpecTarget,
): string {
	const spec = PG_LEDGER_IMMUTABILITY_TRIGGER_SPEC;
	return `CREATE OR REPLACE FUNCTION ${table(target, spec.functionName)}() RETURNS ${spec.functionResult} LANGUAGE ${spec.functionLanguage} AS $$${spec.functionBody}$$`;
}
export function renderCreateLedgerImmutabilityTriggerFromSpec(
	target: LedgerSpecTarget,
): string {
	const spec = PG_LEDGER_IMMUTABILITY_TRIGGER_SPEC;
	const schema = ledgerSpecSchema(target).replaceAll("'", "''");
	return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE t.tgname = '${spec.name}' AND n.nspname = '${schema}' AND c.relname = '${spec.tableName}') THEN CREATE TRIGGER ${spec.name} BEFORE INSERT OR UPDATE OR DELETE ON ${table(target, spec.tableName)} FOR EACH ROW EXECUTE FUNCTION ${table(target, spec.functionName)}(); END IF; END $$`;
}

export type LedgerExpectedManifest = Readonly<{
	tables: readonly LedgerTableSpec[];
	relationKind: typeof PG_LEDGER_RELATION_KIND;
	constraintProperties: typeof PG_LEDGER_CONSTRAINT_PROPERTIES;
	immutabilityTrigger: typeof PG_LEDGER_IMMUTABILITY_TRIGGER_SPEC;
}>;
export function generatePgLedgerExpectedManifest(): LedgerExpectedManifest {
	return {
		tables: PG_LEDGER_SPEC,
		relationKind: PG_LEDGER_RELATION_KIND,
		constraintProperties: PG_LEDGER_CONSTRAINT_PROPERTIES,
		immutabilityTrigger: PG_LEDGER_IMMUTABILITY_TRIGGER_SPEC,
	};
}
