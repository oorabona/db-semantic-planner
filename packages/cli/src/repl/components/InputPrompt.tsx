import React from 'react';
/**
 * DX-030: REPL Input Prompt Component with History Support
 * CLI-015: Enhanced keyboard shortcuts
 * CLI-MUT: Ctrl+R reverse history search
 */

import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CommandHistory } from '../history.js';
import type { QueryMode } from '../types.js';
import { EnhancedTextInput } from './EnhancedTextInput.js';

interface InputPromptProps {
	onSubmit: (value: string) => void;
	mode: QueryMode;
	/** Key to reset the input (increment to clear) */
	resetKey?: number;
	/** Command history instance for up/down navigation */
	history?: CommandHistory;
	/** Callback when input value changes */
	onInputChange?: (value: string) => void;
	/** Currently selected completion text (from Tab navigation) */
	selectedCompletion?: string;
	/** Callback when a completion is accepted (Enter with selection) */
	onCompletionAccepted?: () => void;
	/** Function to apply completion to current input (replaces partial word) */
	applyCompletion?: (currentInput: string, completionText: string) => string;
}

export function InputPrompt({
	onSubmit,
	mode,
	resetKey = 0,
	history,
	onInputChange,
	selectedCompletion,
	onCompletionAccepted,
	applyCompletion,
}: InputPromptProps) {
	const promptSymbol = mode === 'natural' ? '>' : 'sql>';
	const promptColor = mode === 'natural' ? 'green' : 'yellow';

	// Track current input for history navigation
	const [currentInput, setCurrentInput] = useState('');
	const [historyKey, setHistoryKey] = useState(0);
	const [historyValue, setHistoryValue] = useState<string | undefined>(
		undefined,
	);

	// CLI-MUT: Reverse history search state (Ctrl+R)
	const [searchMode, setSearchMode] = useState(false);
	const [searchQuery, setSearchQuery] = useState('');
	const [searchMatchIndex, setSearchMatchIndex] = useState(0);

	// Compute search matches when query changes
	const searchMatches = useMemo(() => {
		if (!history || !searchQuery) return [];
		return history.reverseSearch(searchQuery);
	}, [history, searchQuery]);

	// Current match from search results
	const currentMatch = searchMatches[searchMatchIndex] ?? '';

	// Reset history navigation state when resetKey changes
	useEffect(() => {
		setCurrentInput('');
		setHistoryValue(undefined);
		setHistoryKey((k) => k + 1);
		setSearchMode(false);
		setSearchQuery('');
		setSearchMatchIndex(0);
		history?.resetIndex();
	}, [resetKey, history]);

	// Handle arrow keys for history navigation and Ctrl+R for reverse search
	useInput((input, key) => {
		if (!history) return;

		// CLI-MUT: Ctrl+R triggers reverse search mode
		if (key.ctrl && input === 'r') {
			if (searchMode) {
				// Already in search mode - go to next match
				if (searchMatches.length > 0) {
					setSearchMatchIndex((i) => (i + 1) % searchMatches.length);
				}
			} else {
				// Enter search mode
				setSearchMode(true);
				setSearchQuery('');
				setSearchMatchIndex(0);
			}
			return;
		}

		// In search mode, handle special keys
		if (searchMode) {
			// Escape cancels search
			if (key.escape) {
				setSearchMode(false);
				setSearchQuery('');
				setSearchMatchIndex(0);
				return;
			}

			// Enter accepts current match
			if (key.return) {
				if (currentMatch) {
					setHistoryValue(currentMatch);
					setHistoryKey((k) => k + 1);
					setCurrentInput(currentMatch);
					onInputChange?.(currentMatch);
				}
				setSearchMode(false);
				setSearchQuery('');
				setSearchMatchIndex(0);
				return;
			}

			// Don't process other keys here - let EnhancedTextInput handle them
			return;
		}

		// Normal mode: up/down arrow for history navigation
		if (key.upArrow) {
			const prev = history.previous(currentInput);
			if (prev !== undefined) {
				setHistoryValue(prev);
				setHistoryKey((k) => k + 1);
			}
		} else if (key.downArrow) {
			const next = history.next();
			if (next !== undefined) {
				setHistoryValue(next);
				setHistoryKey((k) => k + 1);
			}
		}
	});

	const handleSubmit = useCallback(
		(value: string) => {
			// If a completion is selected, accept it instead of executing
			if (selectedCompletion) {
				// Apply completion: replace partial word with completion text
				const newValue = applyCompletion
					? applyCompletion(value, selectedCompletion)
					: selectedCompletion; // Fallback to old behavior
				setHistoryValue(newValue);
				setHistoryKey((k) => k + 1);
				setCurrentInput(newValue);
				onInputChange?.(newValue);
				onCompletionAccepted?.();
				return;
			}

			if (history && value.trim()) {
				history.add(value);
			}
			setCurrentInput('');
			setHistoryValue(undefined);
			onSubmit(value);
		},
		[
			history,
			onSubmit,
			selectedCompletion,
			onCompletionAccepted,
			onInputChange,
			applyCompletion,
		],
	);

	const handleChange = useCallback(
		(value: string) => {
			setCurrentInput(value);
			onInputChange?.(value);
		},
		[onInputChange],
	);

	// Use combined key for resetting: resetKey (external) + historyKey (internal from history nav)
	const combinedKey = `${resetKey}-${historyKey}`;

	// CLI-MUT: Handle search query input changes
	const handleSearchChange = useCallback((value: string) => {
		setSearchQuery(value);
		setSearchMatchIndex(0); // Reset to first match when query changes
	}, []);

	// CLI-MUT: Search mode UI
	if (searchMode) {
		return (
			<Box flexDirection="column" marginTop={1}>
				{/* Show current match preview */}
				{currentMatch && (
					<Box>
						<Text color="gray">→ </Text>
						<Text color="cyan">{currentMatch}</Text>
					</Box>
				)}
				{/* Search input */}
				<Box>
					<Text color="magenta" bold>
						(reverse-i-search)`
					</Text>
					<EnhancedTextInput
						key={`search-${combinedKey}`}
						defaultValue={searchQuery}
						onChange={handleSearchChange}
						placeholder=""
					/>
					<Text color="magenta" bold>
						':
					</Text>
					{searchMatches.length > 0 && (
						<Text color="gray">
							{' '}
							({searchMatchIndex + 1}/{searchMatches.length})
						</Text>
					)}
				</Box>
			</Box>
		);
	}

	// Normal mode UI
	return (
		<Box marginTop={1}>
			<Text color={promptColor} bold>
				{promptSymbol}{' '}
			</Text>
			<EnhancedTextInput
				key={combinedKey}
				defaultValue={historyValue ?? ''}
				onSubmit={handleSubmit}
				onChange={handleChange}
				placeholder={
					mode === 'natural'
						? 'Enter query (e.g., users where active = true) or .help'
						: 'Enter SQL query or .natural to switch mode'
				}
			/>
		</Box>
	);
}
