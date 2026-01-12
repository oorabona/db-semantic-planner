/**
 * CLI-015: Enhanced Text Input with keyboard shortcuts
 *
 * Supports standard terminal shortcuts:
 * - Home / Ctrl+A: Move to beginning
 * - End / Ctrl+E: Move to end
 * - Ctrl+W: Delete word backward
 * - Ctrl+U: Delete to beginning
 * - Ctrl+K: Delete to end
 * - Ctrl+Left / Alt+B: Move word backward
 * - Ctrl+Right / Alt+F: Move word forward
 */

import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';

interface EnhancedTextInputProps {
	/** Current value (controlled) */
	value?: string;
	/** Default value (uncontrolled) */
	defaultValue?: string;
	/** Placeholder text */
	placeholder?: string;
	/** Called when value changes */
	onChange?: (value: string) => void;
	/** Called when Enter is pressed */
	onSubmit?: (value: string) => void;
	/** Whether input is disabled */
	isDisabled?: boolean;
	/** Focus state (for multi-input forms) */
	isFocused?: boolean;
}

/**
 * Find the start of the previous word
 */
function findPrevWordStart(text: string, cursor: number): number {
	if (cursor <= 0) return 0;

	let pos = cursor - 1;

	// Skip trailing spaces
	while (pos > 0 && text[pos] === ' ') {
		pos--;
	}

	// Find start of word
	while (pos > 0 && text[pos - 1] !== ' ') {
		pos--;
	}

	return pos;
}

/**
 * Find the end of the next word
 */
function findNextWordEnd(text: string, cursor: number): number {
	if (cursor >= text.length) return text.length;

	let pos = cursor;

	// Skip leading spaces
	while (pos < text.length && text[pos] === ' ') {
		pos++;
	}

	// Find end of word
	while (pos < text.length && text[pos] !== ' ') {
		pos++;
	}

	return pos;
}

export function EnhancedTextInput({
	value: controlledValue,
	defaultValue = '',
	placeholder = '',
	onChange,
	onSubmit,
	isDisabled = false,
	isFocused = true,
}: EnhancedTextInputProps) {
	const [internalValue, setInternalValue] = useState(defaultValue);
	const [cursor, setCursor] = useState(defaultValue.length);

	// Support both controlled and uncontrolled modes
	const value = controlledValue ?? internalValue;

	// Sync cursor when value changes externally
	useEffect(() => {
		if (controlledValue !== undefined) {
			setCursor(Math.min(cursor, controlledValue.length));
		}
	}, [controlledValue, cursor]);

	// Reset when defaultValue changes (for history navigation)
	useEffect(() => {
		if (controlledValue === undefined) {
			setInternalValue(defaultValue);
			setCursor(defaultValue.length);
		}
	}, [defaultValue, controlledValue]);

	const updateValue = (newValue: string, newCursor?: number) => {
		if (controlledValue === undefined) {
			setInternalValue(newValue);
		}
		setCursor(newCursor ?? newValue.length);
		onChange?.(newValue);
	};

	useInput(
		(input, key) => {
			if (isDisabled || !isFocused) return;

			// Submit on Enter
			if (key.return) {
				onSubmit?.(value);
				return;
			}

			// Escape - could be used to clear or cancel
			if (key.escape) {
				return;
			}

			// === CURSOR MOVEMENT ===

			// Home key - move to beginning
			// Detect via escape sequences: \x1b[H, \x1b[1~, \x1bOH
			// or via extended key object (ink may expose it at runtime)
			if (
				input === '\x1b[H' ||
				input === '\x1b[1~' ||
				input === '\x1bOH' ||
				(key as Record<string, boolean>).home
			) {
				setCursor(0);
				return;
			}

			// End key - move to end
			// Detect via escape sequences: \x1b[F, \x1b[4~, \x1bOF
			if (
				input === '\x1b[F' ||
				input === '\x1b[4~' ||
				input === '\x1bOF' ||
				(key as Record<string, boolean>).end
			) {
				setCursor(value.length);
				return;
			}

			// Left arrow
			if (key.leftArrow) {
				if (key.ctrl || key.meta) {
					// Ctrl+Left: Move to previous word
					setCursor(findPrevWordStart(value, cursor));
				} else {
					// Simple left
					setCursor(Math.max(0, cursor - 1));
				}
				return;
			}

			// Right arrow
			if (key.rightArrow) {
				if (key.ctrl || key.meta) {
					// Ctrl+Right: Move to next word
					setCursor(findNextWordEnd(value, cursor));
				} else {
					// Simple right
					setCursor(Math.min(value.length, cursor + 1));
				}
				return;
			}

			// Home (Ctrl+A in terminal) - move to beginning
			if (key.ctrl && input === 'a') {
				setCursor(0);
				return;
			}

			// End (Ctrl+E in terminal) - move to end
			if (key.ctrl && input === 'e') {
				setCursor(value.length);
				return;
			}

			// Alt+B - move word backward (like Ctrl+Left)
			if (key.meta && input === 'b') {
				setCursor(findPrevWordStart(value, cursor));
				return;
			}

			// Alt+F - move word forward (like Ctrl+Right)
			if (key.meta && input === 'f') {
				setCursor(findNextWordEnd(value, cursor));
				return;
			}

			// === DELETION ===

			// Backspace
			if (key.backspace) {
				if (cursor > 0) {
					const newValue = value.slice(0, cursor - 1) + value.slice(cursor);
					updateValue(newValue, cursor - 1);
				}
				return;
			}

			// Delete
			if (key.delete) {
				if (cursor < value.length) {
					const newValue = value.slice(0, cursor) + value.slice(cursor + 1);
					updateValue(newValue, cursor);
				}
				return;
			}

			// Ctrl+W - delete word backward
			if (key.ctrl && input === 'w') {
				const wordStart = findPrevWordStart(value, cursor);
				const newValue = value.slice(0, wordStart) + value.slice(cursor);
				updateValue(newValue, wordStart);
				return;
			}

			// Ctrl+U - delete from cursor to beginning
			if (key.ctrl && input === 'u') {
				const newValue = value.slice(cursor);
				updateValue(newValue, 0);
				return;
			}

			// Ctrl+K - delete from cursor to end
			if (key.ctrl && input === 'k') {
				const newValue = value.slice(0, cursor);
				updateValue(newValue, cursor);
				return;
			}

			// Ctrl+H - same as backspace (terminal convention)
			if (key.ctrl && input === 'h') {
				if (cursor > 0) {
					const newValue = value.slice(0, cursor - 1) + value.slice(cursor);
					updateValue(newValue, cursor - 1);
				}
				return;
			}

			// === CHARACTER INPUT ===

			// Tab - ignore (could be used for completion)
			if (key.tab) {
				return;
			}

			// Regular character input
			if (input && !key.ctrl && !key.meta) {
				const newValue = value.slice(0, cursor) + input + value.slice(cursor);
				updateValue(newValue, cursor + input.length);
			}
		},
		{ isActive: isFocused && !isDisabled },
	);

	// Render the input with cursor
	const showPlaceholder = value.length === 0;

	// Build the display with cursor
	const beforeCursor = value.slice(0, cursor);
	const atCursor = value[cursor] ?? ' ';
	const afterCursor = value.slice(cursor + 1);

	return (
		<Box>
			{showPlaceholder ? (
				<Text dimColor>{placeholder}</Text>
			) : (
				<>
					<Text>{beforeCursor}</Text>
					<Text inverse>{atCursor}</Text>
					<Text>{afterCursor}</Text>
				</>
			)}
		</Box>
	);
}
