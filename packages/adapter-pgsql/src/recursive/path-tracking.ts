/**
 * Path Tracking for Recursive CTEs
 *
 * Builds and appends path arrays for hierarchical traversals.
 * The path array contains text representations of PKs visited during traversal.
 *
 * Example output column:
 * - Anchor: ARRAY[pk::text] AS __path
 * - Recursive: __path || pk::text AS __path
 */

import type { Node } from '@pgsql/types';
import { binaryExpr, typeCast } from '../ast-helpers.js';

/**
 * Build initial path column for anchor SELECT.
 *
 * Produces: ARRAY[pk::text] AS __path
 */
export function buildPathColumn(alias: string, pkColumn: string): Node {
	return {
		ResTarget: {
			val: {
				A_ArrayExpr: {
					elements: [
						typeCast(
							{
								ColumnRef: {
									fields: [
										{ String: { sval: alias } },
										{ String: { sval: pkColumn } },
									],
								},
							},
							'text',
						),
					],
				},
			},
			name: '__path',
		},
	};
}

/**
 * Build appended path column for recursive SELECT.
 *
 * Produces: __path || pk::text AS __path
 */
export function appendPathColumn(
	cteAlias: string,
	innerAlias: string,
	pkColumn: string,
): Node {
	return {
		ResTarget: {
			val: binaryExpr(
				'||',
				{
					ColumnRef: {
						fields: [
							{ String: { sval: cteAlias } },
							{ String: { sval: '__path' } },
						],
					},
				},
				typeCast(
					{
						ColumnRef: {
							fields: [
								{ String: { sval: innerAlias } },
								{ String: { sval: pkColumn } },
							],
						},
					},
					'text',
				),
			),
			name: '__path',
		},
	};
}

/**
 * Build path as JSON array for more complex scenarios.
 *
 * Produces: json_agg(pk::text ORDER BY __depth) OVER () AS __json_path
 */
export function buildJsonPathColumn(
	alias: string,
	pkColumn: string,
	depthColumn = '__depth',
): Node {
	return {
		ResTarget: {
			val: {
				FuncCall: {
					funcname: [{ String: { sval: 'json_agg' } }],
					args: [
						typeCast(
							{
								ColumnRef: {
									fields: [
										{ String: { sval: alias } },
										{ String: { sval: pkColumn } },
									],
								},
							},
							'text',
						),
					],
					agg_order: [
						{
							SortBy: {
								node: {
									ColumnRef: {
										fields: [
											{ String: { sval: alias } },
											{ String: { sval: depthColumn } },
										],
									},
								},
								sortby_dir: 'SORTBY_ASC',
							},
						},
					],
					// Empty OVER () clause for window function
					over: {},
				},
			},
			name: '__json_path',
		},
	};
}

/**
 * Build path string using array_to_string.
 *
 * Produces: array_to_string(__path, '/') AS __path_string
 */
export function buildPathString(cteAlias: string, separator = '/'): Node {
	return {
		ResTarget: {
			val: {
				FuncCall: {
					funcname: [{ String: { sval: 'array_to_string' } }],
					args: [
						{
							ColumnRef: {
								fields: [
									{ String: { sval: cteAlias } },
									{ String: { sval: '__path' } },
								],
							},
						},
						{
							A_Const: {
								sval: { sval: separator },
							},
						},
					],
				},
			},
			name: '__path_string',
		},
	};
}
