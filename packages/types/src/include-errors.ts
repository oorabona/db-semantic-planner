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

/**
 * A construct that is meaningful in its position but whose code path does not
 * exist yet (ADR 0010). The class builds the message, choosing "an" before a
 * position that starts with a vowel and "a" otherwise; `issue` names the open
 * issue that tracks the missing path.
 */
export class NotYetSupportedError extends Error {
	readonly construct: string;
	readonly position: string;
	readonly issue: number;

	constructor(construct: string, position: string, issue: number) {
		if (!Number.isInteger(issue) || issue <= 0)
			throw new TypeError(
				'NotYetSupportedError requires the positive integer number of an open issue.',
			);
		const article = /^[aeiou]/i.test(position) ? 'an' : 'a';
		super(
			`${construct} in ${article} ${position} is not supported yet (#${issue}).`,
		);
		this.name = 'NotYetSupportedError';
		this.construct = construct;
		this.position = position;
		this.issue = issue;
	}
}
