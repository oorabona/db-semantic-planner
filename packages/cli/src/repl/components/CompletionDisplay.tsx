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
	/** Index of the currently selected suggestion (-1 = none) */
	selectedIndex?: number;
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
	selectedIndex = -1,
}: CompletionDisplayProps) {
	if (suggestions.length === 0) {
		return null;
	}

	// Calculate sliding window to keep selected item visible
	let startIndex = 0;
	if (selectedIndex >= 0) {
		// Center the selected item in the window when possible
		const halfWindow = Math.floor(maxItems / 2);
		startIndex = Math.max(
			0,
			Math.min(selectedIndex - halfWindow, suggestions.length - maxItems),
		);
	}
	// Ensure startIndex doesn't go negative for small lists
	startIndex = Math.max(0, startIndex);

	const endIndex = Math.min(startIndex + maxItems, suggestions.length);
	const items = suggestions.slice(startIndex, endIndex);
	const hasBefore = startIndex > 0;
	const hasAfter = endIndex < suggestions.length;

	return (
		<Box flexDirection="row" flexWrap="wrap" marginTop={0}>
			<Text color="gray" dimColor>
				[Tab]{' '}
			</Text>
			{hasBefore && (
				<Text color="gray" dimColor>
					◀{' '}
				</Text>
			)}
			{items.map((suggestion, idx) => {
				// Convert local index to global index for selection check
				const globalIndex = startIndex + idx;
				const isSelected = globalIndex === selectedIndex;
				return (
					<Box key={globalIndex} marginRight={1}>
						<Text>{TYPE_ICONS[suggestion.type]} </Text>
						<Text
							color={isSelected ? 'white' : TYPE_COLORS[suggestion.type]}
							{...(isSelected && { backgroundColor: 'blue' as const })}
							bold={isSelected}
						>
							{suggestion.label}
						</Text>
					</Box>
				);
			})}
			{hasAfter && (
				<Text color="gray" dimColor>
					▶ +{suggestions.length - endIndex}
				</Text>
			)}
		</Box>
	);
}
