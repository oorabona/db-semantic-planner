import { describe, expect, it } from 'vitest';
import type { DeclaredNameResolver } from '../declared-name-resolver.js';
import {
	catalogName,
	declaredColumn,
	declaredConstraint,
	declaredIndex,
	declaredTable,
	identifierText,
	queryLocal,
	type SqlIdentifier,
} from '../sql-identifier.js';

function resolver(entries: {
	table?: string;
	column?: string;
	constraint?: string;
	index?: string;
}): DeclaredNameResolver {
	return {
		physicalModel: undefined as never,
		table: () => entries.table,
		column: () => entries.column,
		logicalColumn: () => undefined,
		constraint: () => entries.constraint,
		index: () => entries.index,
		enum: () => undefined,
		uniqueIndex: () => undefined,
	};
}

function acceptsSqlIdentifier(_identifier: SqlIdentifier): void {}

describe('SqlIdentifier', () => {
	it('resolves declared addresses and preserves their physical spelling', () => {
		const names = resolver({
			table: 'order_lines',
			column: 'line_total',
			constraint: 'order_lines_pkey',
			index: 'order_lines_sku_idx',
		});

		expect(identifierText(declaredTable(names, 'orderLines'))).toBe(
			'order_lines',
		);
		expect(
			identifierText(declaredColumn(names, 'orderLines', 'lineTotal')),
		).toBe('line_total');
		expect(
			identifierText(declaredConstraint(names, 'orderLines', 'primary')),
		).toBe('order_lines_pkey');
		expect(identifierText(declaredIndex(names, 'orderLines', 'bySku'))).toBe(
			'order_lines_sku_idx',
		);
	});

	it('refuses absent declared addresses', () => {
		const names = resolver({});
		expect(() => declaredTable(names, 'orderLines')).toThrow(
			"table 'orderLines'",
		);
		expect(() => declaredColumn(names, 'orderLines', 'lineTotal')).toThrow(
			"column 'orderLines.lineTotal'",
		);
		expect(() => declaredConstraint(names, 'orderLines', 'primary')).toThrow(
			"constraint 'orderLines.primary'",
		);
		expect(() => declaredIndex(names, 'orderLines', 'bySku')).toThrow(
			"index 'orderLines.bySku'",
		);
	});

	it('keeps local and catalog spellings verbatim', () => {
		expect(identifierText(queryLocal('resultAlias'))).toBe('resultAlias');
		expect(identifierText(catalogName('runtime_hnsw_idx'))).toBe(
			'runtime_hnsw_idx',
		);
	});

	it('does not accept a raw string where an established identifier is required', () => {
		// @ts-expect-error A raw string has not crossed an identifier authority.
		acceptsSqlIdentifier('raw_identifier');
		acceptsSqlIdentifier(queryLocal('accepted_identifier'));
	});
});
