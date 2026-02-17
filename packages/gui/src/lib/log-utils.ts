/**
 * Shared log display utilities — colors, time formatting.
 * Used by AppLogPopover, AppLogModal, and LogPanel.
 */

import type { LogLevel } from '@/stores/log-store';

export const LEVEL_COLORS: Record<LogLevel, string> = {
	info: 'text-blue-500',
	warn: 'text-yellow-500',
	error: 'text-red-500',
	debug: 'text-muted-foreground',
};

export function formatLogTime(ts: number): string {
	const d = new Date(ts);
	const h = String(d.getHours()).padStart(2, '0');
	const m = String(d.getMinutes()).padStart(2, '0');
	const s = String(d.getSeconds()).padStart(2, '0');
	return `${h}:${m}:${s}`;
}
