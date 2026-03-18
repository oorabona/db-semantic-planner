/**
 * @module model-ir
 * ModelIR (Model Intermediate Representation) - Schema definition format for db-semantic-planner.
 * Represents database tables, columns, and relations with planning metadata.
 *
 * Type definitions live in @dbsp/types. This module re-exports them
 * and provides runtime functions.
 */

// Re-export all types from @dbsp/types for backward compatibility
export type {
	AmbiguityCheckResult,
	Cardinality,
	CheckConstraintIR,
	ColumnIR,
	ColumnType,
	EnumIR,
	FilterStrategy,
	ForeignKeyIR,
	IncludeStrategy,
	IndexIR,
	JoinDefault,
	ModelIR,
	OnDeleteAction,
	Optionality,
	PartitionIR,
	PseudoColumnMetadata,
	RecursiveMetadata,
	RelationIR,
	RelationKind,
	RelationType,
	SequenceIR,
	TableIR,
} from '@dbsp/types';

import type {
	PseudoColumnMetadata,
	RecursiveMetadata,
	RelationIR,
	RelationKind,
} from '@dbsp/types';

// ============================================================================
// Runtime Functions (stay in @dbsp/core)
// ============================================================================

/**
 * Creates pseudo-column metadata from a self-referential FK.
 */
export function createPseudoColumnMetadata(
	table: string,
	foreignKeyColumn: string,
	targetColumn: string,
	parentRole: string,
	childRole: string,
): PseudoColumnMetadata {
	// For single self-ref FK: ascendant/descendant are direct keywords
	// For multi-FK: they become scoped (e.g., manager.ascendant)
	return {
		table,
		foreignKeyColumn,
		targetColumn,
		parentRole,
		childRole,
		ascendantKeyword: 'ascendant',
		descendantKeyword: 'descendant',
	};
}

/**
 * CLI-NQL: Convert ORM-style RelationType to database-style RelationKind.
 * Handles recursive relations when recursive metadata is present.
 */
export function getRelationKind(relation: RelationIR): RelationKind {
	// Check for recursive relation first
	if (relation.recursive) {
		return relation.recursive.direction === 'up'
			? 'recursive-up'
			: 'recursive-down';
	}

	// Map ORM types to database perspective
	switch (relation.type) {
		case 'belongsTo':
		case 'hasOne':
			return 'many-to-one';
		case 'hasMany':
			return 'one-to-many';
		case 'belongsToMany':
			return 'many-to-many';
	}
}

/**
 * CLI-NQL: Type guard to check if a relation has recursive metadata.
 */
export function isRecursiveRelation(
	relation: RelationIR,
): relation is RelationIR & { recursive: RecursiveMetadata } {
	return relation.recursive !== undefined;
}

/**
 * CLI-NQL: Check if a relation is self-referential (source === target).
 * Self-referential relations are candidates for recursive traversal.
 */
export function isSelfReferential(relation: RelationIR): boolean {
	return relation.source === relation.target;
}

/**
 * CLI-NQL: Create default recursive metadata for a self-referential relation.
 * Used when schema doesn't explicitly define recursive metadata.
 */
export function createRecursiveMetadata(
	direction: 'up' | 'down',
	throughRelation: string,
	maxDepth = 10,
): RecursiveMetadata {
	return {
		direction,
		maxDepth,
		through: throughRelation,
	};
}
