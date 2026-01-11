/**
 * DX-030: REPL Header Component
 */

import { Box, Text } from 'ink';
import React from 'react';
import type { QueryMode } from '../types.js';

interface HeaderProps {
	schemaPath: string;
	mode: QueryMode;
	tableCount: number;
	relationCount: number;
}

export function Header({
	schemaPath,
	mode,
	tableCount,
	relationCount,
}: HeaderProps) {
	return (
		<Box
			borderStyle="round"
			borderColor="cyan"
			paddingX={2}
			marginBottom={1}
			flexDirection="column"
		>
			<Box>
				<Text bold color="cyan">
					🔍 db-semantic-planner REPL
				</Text>
				<Text color="gray"> | </Text>
				<Text color="gray">.help for commands</Text>
				<Text color="gray"> | </Text>
				<Text color="gray">Ctrl+C to exit</Text>
			</Box>
			<Box>
				<Text color="gray">Schema: </Text>
				<Text color="white">{schemaPath}</Text>
				<Text color="gray">
					{' '}
					({tableCount} tables, {relationCount} relations)
				</Text>
				<Text color="gray"> | Mode: </Text>
				<Text color={mode === 'natural' ? 'green' : 'yellow'}>{mode}</Text>
			</Box>
		</Box>
	);
}
