/** A normalized include alias must identify exactly one declared relation. */
export class AmbiguousIncludeError extends Error {
	readonly sourceTable: string;
	readonly relation: string;
	readonly candidates: readonly string[];
	readonly includePath: string | undefined;

	constructor(
		sourceTable: string,
		relation: string,
		candidates: readonly string[],
		includePath?: string,
	) {
		super(
			`Ambiguous include relation "${relation}" from table "${sourceTable}"${includePath ? ` at "${includePath}"` : ''}. Use the exact relation name or "via" to specify one of: ${candidates.join(', ')}`,
		);
		this.name = 'AmbiguousIncludeError';
		this.sourceTable = sourceTable;
		this.relation = relation;
		this.candidates = candidates;
		this.includePath = includePath;
	}
}
