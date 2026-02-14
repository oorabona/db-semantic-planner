import { useEffect } from 'react';
import { useEffectiveTheme } from './useEffectiveTheme';

/**
 * Applies the `.dark` class on `<html>` reactively based on
 * the user's theme preference and the OS color scheme.
 *
 * GUI-013: Must be called once at app root.
 */
export function useThemeEffect() {
	const theme = useEffectiveTheme();

	useEffect(() => {
		document.documentElement.classList.toggle('dark', theme === 'dark');
	}, [theme]);
}
