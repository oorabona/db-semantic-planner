import React from 'react';
/**
 * DX-030: REPL Input Prompt Component with History Support
 */

import { TextInput } from '@inkjs/ui';
import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useState } from 'react';
import type { CommandHistory } from '../history.js';
import type { QueryMode } from '../types.js';

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
}

export function InputPrompt({
	onSubmit,
	mode,
	resetKey = 0,
	history,
	onInputChange,
	selectedCompletion,
	onCompletionAccepted,
}: InputPromptProps) {
	const promptSymbol = mode === 'natural' ? '>' : 'sql>';
	const promptColor = mode === 'natural' ? 'green' : 'yellow';

	// Track current input for history navigation
	const [currentInput, setCurrentInput] = useState('');
	const [historyKey, setHistoryKey] = useState(0);
	const [historyValue, setHistoryValue] = useState<string | undefined>(
		undefined,
	);

	// Reset history navigation state when resetKey changes
	useEffect(() => {
		setCurrentInput('');
		setHistoryValue(undefined);
		setHistoryKey((k) => k + 1);
		history?.resetIndex();
	}, [resetKey, history]);

	// Handle arrow keys for history navigation
	useInput((_input, key) => {
		if (!history) return;

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
				setHistoryValue(selectedCompletion);
				setHistoryKey((k) => k + 1);
				setCurrentInput(selectedCompletion);
				onInputChange?.(selectedCompletion);
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

	return (
		<Box marginTop={1}>
			<Text color={promptColor} bold>
				{promptSymbol}{' '}
			</Text>
			<TextInput
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
