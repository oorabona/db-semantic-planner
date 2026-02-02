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

import { Box, Text, useInput, useStdin } from 'ink';
import React, { useEffect, useRef, useState } from 'react';

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

	// Refs mirror state for synchronous access during paste batches.
	// React batches useState updates, so within a single stdin chunk (paste),
	// each useInput callback sees the stale closure value. Refs update
	// immediately, letting each keystroke build on the previous one.
	const valueRef = useRef(defaultValue);
	const cursorRef = useRef(defaultValue.length);

	// Track raw input to distinguish Delete (\x1b[3~) from Backspace (\x7f)
	// Ink's parser maps BOTH to key.delete, but we need to differentiate
	const lastRawInputRef = useRef<string>('');
	const { stdin } = useStdin();

	// Listen to raw stdin to capture the actual escape sequence
	useEffect(() => {
		if (!stdin || isDisabled || !isFocused) return;

		const handleRawData = (data: Buffer) => {
			lastRawInputRef.current = data.toString();
		};

		stdin.on('data', handleRawData);
		return () => {
			stdin.off('data', handleRawData);
		};
	}, [stdin, isDisabled, isFocused]);

	// Support both controlled and uncontrolled modes
	const value = controlledValue ?? internalValue;

	// Sync cursor when value changes externally
	useEffect(() => {
		if (controlledValue !== undefined) {
			const synced = Math.min(cursorRef.current, controlledValue.length);
			cursorRef.current = synced;
			setCursor(synced);
			valueRef.current = controlledValue;
		}
	}, [controlledValue]);

	// Reset when defaultValue changes (for history navigation)
	useEffect(() => {
		if (controlledValue === undefined) {
			setInternalValue(defaultValue);
			setCursor(defaultValue.length);
			valueRef.current = defaultValue;
			cursorRef.current = defaultValue.length;
		}
	}, [defaultValue, controlledValue]);

	const updateValue = (newValue: string, newCursor?: number) => {
		const nc = newCursor ?? newValue.length;
		// Update refs synchronously (critical for paste batches)
		valueRef.current = newValue;
		cursorRef.current = nc;
		// Update state for rendering
		if (controlledValue === undefined) {
			setInternalValue(newValue);
		}
		setCursor(nc);
		onChange?.(newValue);
	};

	useInput(
		(input, key) => {
			if (isDisabled || !isFocused) return;

			// Read from refs for correct values during paste batches
			const val = valueRef.current;
			const cur = cursorRef.current;

			// Submit on Enter (with multiline support)
			if (key.return) {
				// Shift+Enter → insert newline (terminals that support distinct sequence)
				if (key.shift) {
					const newValue = `${val.slice(0, cur)}\n${val.slice(cur)}`;
					updateValue(newValue, cur + 1);
					return;
				}
				// Backslash continuation: if line ends with \, replace \ with newline
				if (val.endsWith('\\')) {
					const newValue = `${val.slice(0, -1)}\n`;
					updateValue(newValue, newValue.length);
					return;
				}
				// Normal Enter → submit, then reset refs immediately so next
				// pasted line starts fresh (before React re-renders)
				const submitted = val;
				valueRef.current = '';
				cursorRef.current = 0;
				onSubmit?.(submitted);
				return;
			}

			// Escape - could be used to clear or cancel
			if (key.escape) {
				return;
			}

			// === CURSOR MOVEMENT ===

			// Home key - move to beginning (native in Ink 6.6.0+)
			if (key.home) {
				cursorRef.current = 0;
				setCursor(0);
				return;
			}

			// End key - move to end (native in Ink 6.6.0+)
			if (key.end) {
				cursorRef.current = val.length;
				setCursor(val.length);
				return;
			}

			// Left arrow
			if (key.leftArrow) {
				if (key.ctrl || key.meta) {
					const nc = findPrevWordStart(val, cur);
					cursorRef.current = nc;
					setCursor(nc);
				} else {
					const nc = Math.max(0, cur - 1);
					cursorRef.current = nc;
					setCursor(nc);
				}
				return;
			}

			// Right arrow
			if (key.rightArrow) {
				if (key.ctrl || key.meta) {
					const nc = findNextWordEnd(val, cur);
					cursorRef.current = nc;
					setCursor(nc);
				} else {
					const nc = Math.min(val.length, cur + 1);
					cursorRef.current = nc;
					setCursor(nc);
				}
				return;
			}

			// Home (Ctrl+A in terminal) - move to beginning
			if (key.ctrl && input === 'a') {
				cursorRef.current = 0;
				setCursor(0);
				return;
			}

			// End (Ctrl+E in terminal) - move to end
			if (key.ctrl && input === 'e') {
				cursorRef.current = val.length;
				setCursor(val.length);
				return;
			}

			// Alt+B - move word backward (like Ctrl+Left)
			if (key.meta && input === 'b') {
				const nc = findPrevWordStart(val, cur);
				cursorRef.current = nc;
				setCursor(nc);
				return;
			}

			// Alt+F - move word forward (like Ctrl+Right)
			if (key.meta && input === 'f') {
				const nc = findNextWordEnd(val, cur);
				cursorRef.current = nc;
				setCursor(nc);
				return;
			}

			// === DELETION ===
			// Use raw input ref to distinguish Delete from Backspace
			// Ink maps BOTH \x7f and \x1b[3~ to key.delete, but we need to differentiate
			const rawInput = lastRawInputRef.current;

			// Delete key (forward delete) - Check RAW input for \x1b[3~ sequence
			// This MUST come before backspace check since both trigger key.delete
			if (rawInput === '\x1b[3~' || rawInput.startsWith('\x1b[3~')) {
				if (cur < val.length) {
					const newValue = val.slice(0, cur) + val.slice(cur + 1);
					updateValue(newValue, cur);
				}
				return;
			}

			// Backspace - delete character BEFORE cursor
			const isBackspace =
				key.backspace ||
				rawInput === '\x7f' ||
				rawInput === '\x08' ||
				input === '\x7f' ||
				input === '\x08';
			if (isBackspace) {
				if (cur > 0) {
					const newValue = val.slice(0, cur - 1) + val.slice(cur);
					updateValue(newValue, cur - 1);
				}
				return;
			}

			// Ctrl+W - delete word backward
			if (key.ctrl && input === 'w') {
				const wordStart = findPrevWordStart(val, cur);
				const newValue = val.slice(0, wordStart) + val.slice(cur);
				updateValue(newValue, wordStart);
				return;
			}

			// Ctrl+U - delete from cursor to beginning
			if (key.ctrl && input === 'u') {
				const newValue = val.slice(cur);
				updateValue(newValue, 0);
				return;
			}

			// Ctrl+K - delete from cursor to end
			if (key.ctrl && input === 'k') {
				const newValue = val.slice(0, cur);
				updateValue(newValue, cur);
				return;
			}

			// Ctrl+H - same as backspace (terminal convention)
			if (key.ctrl && input === 'h') {
				if (cur > 0) {
					const newValue = val.slice(0, cur - 1) + val.slice(cur);
					updateValue(newValue, cur - 1);
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
				// Detect multiline paste: input string contains line breaks.
				// Submit every non-empty line immediately — the user pasted
				// a block of text and expects all lines to execute.
				if (input.includes('\n') || input.includes('\r')) {
					const fullText = val.slice(0, cur) + input + val.slice(cur);
					const parts = fullText.split(/\r\n|\r|\n/);
					const toSubmit = parts.map((l) => l.trim()).filter(Boolean);

					if (toSubmit.length > 0) {
						valueRef.current = '';
						cursorRef.current = 0;
						for (const line of toSubmit) {
							onSubmit?.(line);
						}
						return;
					}

					// All lines were blank — clear buffer
					updateValue('', 0);
					return;
				}
				const newValue = val.slice(0, cur) + input + val.slice(cur);
				updateValue(newValue, cur + input.length);
			}
		},
		{ isActive: isFocused && !isDisabled },
	);

	// Render the input with cursor (supports multiline)
	const showPlaceholder = value.length === 0;
	const isMultiline = value.includes('\n');

	if (showPlaceholder) {
		return (
			<Box>
				<Text inverse> </Text>
				<Text dimColor>{placeholder}</Text>
			</Box>
		);
	}

	// Multiline rendering: split by newlines, show cursor on correct line
	if (isMultiline) {
		const lines = value.split('\n');
		let charsSoFar = 0;

		return (
			<Box flexDirection="column">
				{lines.map((line, lineIdx) => {
					const lineStart = charsSoFar;
					charsSoFar += line.length + 1; // +1 for the \n

					const cursorInThisLine =
						cursor >= lineStart && cursor < lineStart + line.length + 1;

					if (!cursorInThisLine) {
						return (
							<Text key={lineIdx}>
								{lineIdx > 0 && <Text color="gray">... </Text>}
								{line}
							</Text>
						);
					}

					const cursorInLine = cursor - lineStart;
					const before = line.slice(0, cursorInLine);
					const at = line[cursorInLine] ?? ' ';
					const after = line.slice(cursorInLine + 1);

					return (
						<Text key={lineIdx}>
							{lineIdx > 0 && <Text color="gray">... </Text>}
							{before}
							<Text inverse>{at}</Text>
							{after}
						</Text>
					);
				})}
			</Box>
		);
	}

	// Single-line rendering (original)
	const beforeCursor = value.slice(0, cursor);
	const atCursor = value[cursor] ?? ' ';
	const afterCursor = value.slice(cursor + 1);

	return (
		<Box>
			<Text>{beforeCursor}</Text>
			<Text inverse>{atCursor}</Text>
			<Text>{afterCursor}</Text>
		</Box>
	);
}
