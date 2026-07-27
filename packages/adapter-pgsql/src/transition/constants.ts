import type { OperationKindRef, SemanticArtifactRef } from '@dbsp/types';
import { semanticArtifactId } from './ids.js';

export const PG_OPERATION_PACK_ARTIFACT: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.postgresql.operations.pg18'),
	version: '0.1.0',
};

export const PG_RULE_PACK_ARTIFACT: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.postgresql.rules.pg18'),
	version: '0.1.0',
};

export const PG_EQUIVALENCE_ARTIFACT: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.postgresql.equivalence.pg18'),
	version: '0.1.0',
};

export const PG_DEPARSE_ARTIFACT: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.postgresql.deparser.pg18'),
	version: '0.1.0',
};

export const PG_INTROSPECTION_ARTIFACT: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.postgresql.introspection.pg18'),
	version: '0.1.0',
};

export const ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND: OperationKindRef = {
	artifact: PG_OPERATION_PACK_ARTIFACT,
	name: 'AlterColumnSetNotNull',
};

export const ALTER_TABLE_ADD_CHECK_OPERATION_KIND: OperationKindRef = {
	artifact: PG_OPERATION_PACK_ARTIFACT,
	name: 'AlterTableAddCheck',
};

export const ALTER_TYPE_ADD_VALUE_OPERATION_KIND: OperationKindRef = {
	artifact: PG_OPERATION_PACK_ARTIFACT,
	name: 'AlterTypeAddValue',
};

export const CREATE_UNIQUE_INDEX_CONCURRENTLY_OPERATION_KIND: OperationKindRef =
	{
		artifact: PG_OPERATION_PACK_ARTIFACT,
		name: 'CreateUniqueIndexConcurrently',
	};

export const ATTACH_LOGICAL_IDENTITY_OPERATION_KIND: OperationKindRef = {
	artifact: PG_OPERATION_PACK_ARTIFACT,
	name: 'AttachLogicalIdentity',
};

export const MANUAL_SQL_OPERATION_KIND: OperationKindRef = {
	artifact: PG_OPERATION_PACK_ARTIFACT,
	name: 'ManualSql',
};

export const SET_NOT_NULL_RULE_ID = 'postgresql.column.set-not-null';
export const ADD_CHECK_RULE_ID = 'postgresql.table.add-check';
export const ENUM_ADD_VALUE_RULE_ID = 'postgresql.enum.add-value';
export const CREATE_UNIQUE_INDEX_CONCURRENTLY_RULE_ID =
	'postgresql.index.create-unique-concurrently';
export const LOGICAL_IDENTITY_ADOPTION_RULE_ID =
	'postgresql.logical-identity.adopt';
export const ALTER_COLUMN_SET_NOT_NULL_CAPABILITY = 'alter-column-set-not-null';
export const ALTER_COLUMN_SET_NOT_NULL_MIN_SERVER_VERSION_NUM = 180000;
export const ALTER_TABLE_ADD_CHECK_CAPABILITY = 'alter-table-add-check';
export const ALTER_TABLE_ADD_CHECK_MIN_SERVER_VERSION_NUM = 180000;
export const ALTER_TYPE_ADD_VALUE_CAPABILITY = 'alter-type-add-value';
export const ALTER_TYPE_ADD_VALUE_MIN_SERVER_VERSION_NUM = 120000;
export const CREATE_UNIQUE_INDEX_CONCURRENTLY_CAPABILITY =
	'create-unique-index-concurrently';
export const CREATE_UNIQUE_INDEX_CONCURRENTLY_MIN_SERVER_VERSION_NUM = 120000;
export const PG_SCHEMA_USAGE_PRIVILEGE = 'postgresql.schema.usage';
export const PG_TABLE_ALTER_AUTHORITY_PRIVILEGE =
	'postgresql.table.alter-authority';
export const PG_TYPE_ALTER_AUTHORITY_PRIVILEGE =
	'postgresql.type.alter-authority';
export const PG_SET_NOT_NULL_AUTHORITY_PRIVILEGE =
	'postgresql.column.set-not-null.authority';

export const DBSP_META_SCHEMA = 'dbsp_meta';
export const DBSP_TRANSITION_RUN_TABLE = 'dbsp_transition_run';
export const DBSP_TRANSITION_RUN_PLAN_TABLE = 'dbsp_transition_run_plan';
export const DBSP_TRANSITION_JOURNAL_TABLE = 'dbsp_transition_journal';
export const DBSP_LOGICAL_IDENTITY_TABLE = 'dbsp_logical_identity';
export const DBSP_LOGICAL_IDENTITY_MARKER_COLUMN = 'dbsp_managed_by';
export const DBSP_LOGICAL_IDENTITY_MARKER_VALUE = `${PG_OPERATION_PACK_ARTIFACT.id}@${PG_OPERATION_PACK_ARTIFACT.version}`;

export const COLUMN_EXISTS_OBSERVATION = 'postgresql.column.exists';
export const TABLE_CHECK_CONSTRAINTS_OBSERVATION =
	'postgresql.table.check-constraints';
export const CHECK_CONSTRAINT_ABSENT_OBSERVATION =
	'postgresql.table.check-constraint.absent';
export const TABLE_INDEXES_OBSERVATION = 'postgresql.table.indexes';
export const INDEX_ABSENT_OBSERVATION = 'postgresql.index.absent';
export const ENUM_TYPE_EXISTS_OBSERVATION = 'postgresql.enum-type.exists';
export const ENUM_LABEL_VISIBLE_OBSERVATION = 'postgresql.enum-label.visible';
export const SET_NOT_NULL_RELATION_KIND_SUPPORTED_OBSERVATION =
	'postgresql.column.set-not-null.relation-kind-supported';
export const SET_NOT_NULL_PARTITIONED_TABLE_UNSUPPORTED_DETAIL =
	'partitioned tables are not yet supported by the SET NOT NULL transition';
export const ALTER_AUTHORITY_OBSERVATION = 'postgresql.table.alter-authority';
export const ALTER_TYPE_AUTHORITY_OBSERVATION =
	'postgresql.type.alter-authority';
export const ENGINE_VERSION_OBSERVATION = 'postgresql.engine.version-supported';
export const EXPRESSION_DEPARSE_OBSERVATION = 'postgresql.expression.deparse';
export const LOGICAL_IDENTITY_CARRIER_OBSERVATION =
	'postgresql.logical-identity.carrier-state';

export const NO_NULLS_GUARD = 'NO_NULLS';
export const CHECK_ROWS_SATISFY_GUARD = 'CHECK_ROWS_SATISFY';
export const NO_DUPLICATES_FOR_UNIQUE_INDEX_BUILD_GUARD =
	'NO_DUPLICATES_FOR_UNIQUE_INDEX_BUILD';
