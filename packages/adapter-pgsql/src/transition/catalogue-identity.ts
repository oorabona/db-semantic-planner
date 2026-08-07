import type { ResourceAddress } from '@dbsp/types';

export interface PgCatalogueIdentityQueryable {
	query(
		sql: string,
		params?: readonly unknown[],
	): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

function oid(row: Record<string, unknown>, field: string): string | undefined {
	const value = row[field];
	return typeof value === 'string' || typeof value === 'number'
		? String(value)
		: undefined;
}

function schemaOf(address: ResourceAddress): string {
	if (!address.schema)
		throw new Error(
			`catalogue identity for ${address.kind} ${address.name} requires a schema`,
		);
	return address.schema;
}

/**
 * Re-read the PostgreSQL catalogue identity for one managed address. The
 * adapter deliberately returns absence as undefined; callers decide whether an
 * absent object is legal for the lifecycle state they are admitting.
 */
export async function readPgCatalogueIdentity(
	executor: PgCatalogueIdentityQueryable,
	address: ResourceAddress,
): Promise<ResourceAddress | undefined> {
	let row: Record<string, unknown> | undefined;
	switch (address.kind) {
		case 'table':
			row = (
				await executor.query(
					`SELECT relation.oid::text AS oid FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = $2 AND relation.relkind IN ('r', 'p', 'f')`,
					[schemaOf(address), address.name],
				)
			).rows[0];
			break;
		case 'index':
			row = (
				await executor.query(
					`SELECT index_relation.oid::text AS oid FROM pg_catalog.pg_class index_relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = index_relation.relnamespace JOIN pg_catalog.pg_index index_definition ON index_definition.indexrelid = index_relation.oid JOIN pg_catalog.pg_class parent_relation ON parent_relation.oid = index_definition.indrelid WHERE namespace.nspname = $1 AND index_relation.relname = $2 AND index_relation.relkind = 'i' AND ($3::text IS NULL OR parent_relation.relname = $3)`,
					[schemaOf(address), address.name, address.parent?.name ?? null],
				)
			).rows[0];
			break;
		case 'sequence':
			row = (
				await executor.query(
					`SELECT relation.oid::text AS oid FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = $2 AND relation.relkind = 'S'`,
					[schemaOf(address), address.name],
				)
			).rows[0];
			break;
		case 'enum':
			row = (
				await executor.query(
					`SELECT type.oid::text AS oid FROM pg_catalog.pg_type type JOIN pg_catalog.pg_namespace namespace ON namespace.oid = type.typnamespace WHERE namespace.nspname = $1 AND type.typname = $2 AND type.typtype = 'e'`,
					[schemaOf(address), address.name],
				)
			).rows[0];
			break;
		case 'extension':
			row = (
				await executor.query(
					`SELECT extension.oid::text AS oid FROM pg_catalog.pg_extension extension WHERE extension.extname = $1`,
					[address.name],
				)
			).rows[0];
			break;
		case 'constraint':
			row = (
				await executor.query(
					`SELECT constraint_row.oid::text AS oid FROM pg_catalog.pg_constraint constraint_row JOIN pg_catalog.pg_class parent_relation ON parent_relation.oid = constraint_row.conrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = parent_relation.relnamespace WHERE namespace.nspname = $1 AND constraint_row.conname = $2 AND ($3::text IS NULL OR parent_relation.relname = $3)`,
					[schemaOf(address), address.name, address.parent?.name ?? null],
				)
			).rows[0];
			break;
		case 'column': {
			if (!address.parent)
				throw new Error(
					`catalogue identity for column ${address.name} requires a parent address`,
				);
			row = (
				await executor.query(
					`SELECT parent_relation.oid::text AS parent_oid FROM pg_catalog.pg_attribute attribute JOIN pg_catalog.pg_class parent_relation ON parent_relation.oid = attribute.attrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = parent_relation.relnamespace WHERE namespace.nspname = $1 AND parent_relation.relname = $2 AND attribute.attname = $3 AND attribute.attnum > 0 AND NOT attribute.attisdropped`,
					[schemaOf(address), address.parent.name, address.name],
				)
			).rows[0];
			if (!row) return undefined;
			const parentOid = oid(row, 'parent_oid');
			if (!parentOid)
				throw new Error(
					`PostgreSQL returned an invalid parent OID for column ${address.name}`,
				);
			return {
				...address,
				parent: {
					...address.parent,
					catalogueIdentity: {
						engine: 'postgresql',
						format: 1,
						value: { oid: parentOid },
					},
				},
				catalogueIdentity: {
					engine: 'postgresql',
					format: 1,
					value: { parentOid, name: address.name },
				},
			};
		}
		default:
			throw new Error(
				`catalogue identity is unsupported for resource kind ${address.kind}`,
			);
	}
	if (!row) return undefined;
	const value = oid(row, 'oid');
	if (!value)
		throw new Error(
			`PostgreSQL returned an invalid OID for ${address.kind} ${address.name}`,
		);
	return {
		...address,
		catalogueIdentity: {
			engine: 'postgresql',
			format: 1,
			value: { oid: value },
		},
	};
}
