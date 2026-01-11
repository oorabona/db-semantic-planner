import React from 'react';
/**
 * DX-030 Block 6: Completion Display Component
 *
 * Shows inline completion suggestions as the user types.
 */

import { Box, Text } from 'ink';
import type { CompletionSuggestion } from '../completion.js';

interface CompletionDisplayProps {
	suggestions: CompletionSuggestion[];
	maxItems?: number;
}

/**
 * Type icons for visual distinction
 */
const TYPE_ICONS: Record<CompletionSuggestion['type'], string> = {
	table: '🗃️',
	column: '📋',
	keyword: '🔑',
	command: '⚡',
	relation: '🔗',
};

/**
 * Type colors for visual distinction
 */
const TYPE_COLORS: Record<CompletionSuggestion['type'], string> = {
	table: 'cyan',
	column: 'blue',
	keyword: 'yellow',
	command: 'magenta',
	relation: 'green',
};

export function CompletionDisplay({
	suggestions,
	maxItems = 8,
}: CompletionDisplayProps) {
	if (suggestions.length === 0) {
		return null;
	}

	const items = suggestions.slice(0, maxItems);
	const hasMore = suggestions.length > maxItems;

	return (
		<Box flexDirection="row" flexWrap="wrap" marginTop={0}>
			<Text color="gray" dimColor>
				[Tab]{' '}
			</Text>
			{items.map((suggestion, idx) => (
				<Box key={idx} marginRight={1}>
					<Text>{TYPE_ICONS[suggestion.type]} </Text>
					<Text color={TYPE_COLORS[suggestion.type]}>{suggestion.label}</Text>
				</Box>
			))}
			{hasMore && (
				<Text color="gray" dimColor>
					+{suggestions.length - maxItems} more
				</Text>
			)}
		</Box>
	);
}
