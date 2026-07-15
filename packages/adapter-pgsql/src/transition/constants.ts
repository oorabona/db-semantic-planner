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

export const PG_INTROSPECTION_ARTIFACT: SemanticArtifactRef = {
	id: semanticArtifactId('dbsp.postgresql.introspection.pg18'),
	version: '0.1.0',
};

export const ALTER_COLUMN_SET_NOT_NULL_OPERATION_KIND: OperationKindRef = {
	artifact: PG_OPERATION_PACK_ARTIFACT,
	name: 'AlterColumnSetNotNull',
};

export const SET_NOT_NULL_RULE_ID = 'postgresql.column.set-not-null';

export const COLUMN_EXISTS_OBSERVATION = 'postgresql.column.exists';
export const ALTER_AUTHORITY_OBSERVATION = 'postgresql.table.alter-authority';
export const ENGINE_VERSION_OBSERVATION = 'postgresql.engine.version-supported';

export const NO_NULLS_GUARD = 'NO_NULLS';
