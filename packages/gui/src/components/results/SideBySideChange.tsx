/**
 * Side-by-side comparison for alter_* schema changes.
 * Shows old value on the left, new value on the right with diff highlighting.
 */
import type { SchemaDiffChange } from '@/lib/ipc';

export interface SideBySideChangeProps {
	change: SchemaDiffChange;
}

/** Renders a single alter_* change as a two-column old vs new comparison. */
export function SideBySideChange({ change }: SideBySideChangeProps) {
	const pair = extractPair(change);
	if (!pair) return null;

	return (
		<div
			className="mt-1 grid grid-cols-2 gap-2 rounded border border-border bg-muted/30 px-2 py-1.5 text-xs"
			data-testid="side-by-side-change"
		>
			{/* Old value */}
			<div data-testid="sbs-old">
				<span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
					Old
				</span>
				<span
					className={`font-mono ${pair.oldValue === MISSING ? 'text-muted-foreground italic' : 'text-red-600 dark:text-red-400'}`}
				>
					{pair.oldValue}
				</span>
			</div>

			{/* New value */}
			<div data-testid="sbs-new">
				<span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
					New
				</span>
				<span
					className={`font-mono ${pair.newValue === MISSING ? 'text-muted-foreground italic' : 'text-green-600 dark:text-green-400'}`}
				>
					{pair.newValue}
				</span>
			</div>
		</div>
	);
}

// ── Value extraction ────────────────────────────────────────────

const MISSING = 'Unknown (missing metadata)';

interface ValuePair {
	oldValue: string;
	newValue: string;
}

function formatValue(value: unknown): string {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'string') return value;
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	return String(value);
}

function formatFk(fk: unknown): string {
	if (!fk || typeof fk !== 'object') return MISSING;
	const f = fk as Record<string, unknown>;
	const cols = Array.isArray(f.columns) ? f.columns.join(', ') : '?';
	const refTable =
		typeof f.referencedTable === 'string' ? f.referencedTable : '?';
	const refCols = Array.isArray(f.referencedColumns)
		? f.referencedColumns.join(', ')
		: '?';
	return `(${cols}) -> ${refTable}(${refCols})`;
}

function extractPair(change: SchemaDiffChange): ValuePair | null {
	const meta = change.meta;

	switch (change.kind) {
		case 'alter_column_type': {
			const fromType = meta?.fromType;
			const toType = meta?.toType;
			return {
				oldValue: fromType != null ? formatValue(fromType) : MISSING,
				newValue: toType != null ? formatValue(toType) : MISSING,
			};
		}

		case 'alter_column_nullable': {
			const oldNullable = meta?.oldNullable;
			const nullable = meta?.nullable;
			return {
				oldValue:
					oldNullable != null
						? oldNullable
							? 'NULLABLE'
							: 'NOT NULL'
						: MISSING,
				newValue:
					nullable != null ? (nullable ? 'NULLABLE' : 'NOT NULL') : MISSING,
			};
		}

		case 'alter_column_default': {
			const oldDefault = meta?.oldDefault;
			const newDefault = meta?.default;
			return {
				oldValue: oldDefault !== undefined ? formatValue(oldDefault) : MISSING,
				newValue: newDefault !== undefined ? formatValue(newDefault) : MISSING,
			};
		}

		case 'alter_foreign_key': {
			const oldFk = meta?.oldFk;
			const fk = meta?.fk;
			return {
				oldValue: oldFk ? formatFk(oldFk) : MISSING,
				newValue: fk ? formatFk(fk) : MISSING,
			};
		}

		default:
			// Non-alter changes have no side-by-side comparison
			return null;
	}
}
