/**
 * DX-030 Block 7: Split View Component
 *
 * Shows schema browser on the left and query/output on the right.
 */

import { Box, Text } from 'ink';
import React, { useState } from 'react';
import type { LoadedSchema } from '../../utils/schema-loader.js';

interface SplitViewProps {
	schema: LoadedSchema;
	rightContent: React.ReactNode;
	width?: number;
}

/**
 * Schema browser panel
 * ARCH-005: Uses LoadedSchema with schema.model (ModelIR)
 */
function SchemaPanel({ schema }: { schema: LoadedSchema }) {
	const [expandedTable] = useState<string | null>(null);
	const tables = schema.tableNames;

	return (
		<Box flexDirection="column" padding={1}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					📊 Schema
				</Text>
			</Box>

			{/* Tables list */}
			<Box flexDirection="column">
				<Text color="gray" dimColor>
					Tables ({tables.length}):
				</Text>
				{tables.map((tableName) => {
					const isExpanded = expandedTable === tableName;
					const table = schema.model.tables.get(tableName);

					return (
						<Box key={tableName} flexDirection="column" marginLeft={1}>
							<Text color={isExpanded ? 'cyan' : 'white'} bold={isExpanded}>
								{isExpanded ? '▼' : '▶'} {tableName}
							</Text>
							{isExpanded && table && (
								<Box flexDirection="column" marginLeft={2}>
									{table.columns.map((col) => (
										<Text key={col.name} color="gray">
											{col.name}: {col.type}
											{col.nullable ? '' : ' (NOT NULL)'}
										</Text>
									))}
								</Box>
							)}
						</Box>
					);
				})}
			</Box>

			{/* Relations */}
			<Box flexDirection="column" marginTop={1}>
				<Text color="gray" dimColor>
					Relations ({schema.model.relations.size}):
				</Text>
				{Array.from(schema.model.relations.entries()).map(([name, rel]) => (
					<Box key={name} marginLeft={1}>
						<Text color="gray">
							• {name}: {rel.type} → {rel.target}
						</Text>
					</Box>
				))}
			</Box>

			<Box marginTop={1}>
				<Text color="gray" dimColor>
					Click table to expand
				</Text>
			</Box>
		</Box>
	);
}

/**
 * Vertical border component
 */
function VerticalBorder({ height }: { height: number }) {
	return (
		<Box flexDirection="column">
			{Array.from({ length: height }, (_, i) => (
				<Text key={i} color="gray">
					│
				</Text>
			))}
		</Box>
	);
}

export function SplitView({
	schema,
	rightContent,
	width = 80,
}: SplitViewProps) {
	const leftWidth = Math.floor(width * 0.35);
	const rightWidth = width - leftWidth - 1; // -1 for border

	return (
		<Box flexDirection="row" height="100%">
			{/* Left panel - Schema */}
			<Box
				width={leftWidth}
				flexDirection="column"
				borderStyle="single"
				borderColor="gray"
			>
				<SchemaPanel schema={schema} />
			</Box>

			{/* Separator */}
			<Box flexDirection="column">
				<VerticalBorder height={20} />
			</Box>

			{/* Right panel - Query/Output */}
			<Box width={rightWidth} flexDirection="column" padding={1}>
				{rightContent}
			</Box>
		</Box>
	);
}

/**
 * Simple schema sidebar (more compact version)
 * ARCH-005: Uses LoadedSchema with schema.model (ModelIR)
 */
export function SchemaSidebar({ schema }: { schema: LoadedSchema }) {
	const tables = schema.tableNames;
	// Find max table name length for consistent width
	const maxLen = Math.max(...tables.map((t) => t.length), 10);
	// Sidebar width: padding(2) + bullet(2) + name + border(2)
	const sidebarWidth = maxLen + 8;

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor="gray"
			paddingX={1}
			width={sidebarWidth}
		>
			<Text bold color="cyan" underline>
				Schema
			</Text>
			<Box flexDirection="column" marginTop={1}>
				{tables.map((tableName) => (
					<Text key={tableName} color="white">
						{'• '}
						{tableName}
					</Text>
				))}
			</Box>
			<Box marginTop={1}>
				<Text color="gray" dimColor>
					{schema.model.relations.size} relations
				</Text>
			</Box>
		</Box>
	);
}
