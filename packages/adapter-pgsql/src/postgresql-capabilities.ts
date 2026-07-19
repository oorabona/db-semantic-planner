import { POSTGRESQL_CAPABILITIES, serverVersionNum } from '@dbsp/core';
import type { DialectCapabilities } from '@dbsp/types';
import {
	INDEX_INCLUDE_CAPABILITY,
	INDEX_NULLS_NOT_DISTINCT_CAPABILITY,
} from './transition/index-feature-capabilities.js';

const POSTGRESQL_CAPABILITY_FLOOR = serverVersionNum('10')!;
const STRICT_POSTGRESQL_VERSION_RE = /^\d+(\.\d+){0,2}$/;
const POSTGRESQL_CAPABILITY_TARGET_VERSIONS = new WeakMap<
	DialectCapabilities,
	string
>();
type MutableDialectCapabilities = {
	-readonly [K in keyof DialectCapabilities]: DialectCapabilities[K];
};

const INDEX_FEATURE_CAPABILITY_PROJECTIONS = [
	{
		descriptor: INDEX_INCLUDE_CAPABILITY,
		flag: 'supportsDDLIndexInclude',
	},
	{
		descriptor: INDEX_NULLS_NOT_DISTINCT_CAPABILITY,
		flag: 'supportsDDLIndexNullsNotDistinct',
	},
] as const satisfies readonly {
	readonly descriptor:
		| typeof INDEX_INCLUDE_CAPABILITY
		| typeof INDEX_NULLS_NOT_DISTINCT_CAPABILITY;
	readonly flag: keyof DialectCapabilities;
}[];

export function derivePostgresqlCapabilitiesForVersion(
	version: string,
): DialectCapabilities {
	const trimmed = version.trim();
	if (!STRICT_POSTGRESQL_VERSION_RE.test(trimmed)) {
		throw new Error(`Invalid PostgreSQL version "${version}"`);
	}
	if (/^\d{5,}$/.test(trimmed)) {
		throw new Error(
			`PostgreSQL version "${version}" must be a dotted or major version string, not server_version_num form`,
		);
	}
	// serverVersionNum packs non-major segments as (minor*100 + patch); a minor or
	// patch >= 100 overflows into the next major (e.g. "14.100" -> 150000 = PG15),
	// which would falsely enable a version-gated feature. A real PostgreSQL version
	// never has a minor/patch segment >= 100, so reject it rather than mis-gate.
	if (
		trimmed
			.split('.')
			.slice(1)
			.some((segment) => Number(segment) >= 100)
	) {
		throw new Error(
			`Invalid PostgreSQL version "${version}": minor/patch segments must be below 100`,
		);
	}

	const actual = serverVersionNum(trimmed);
	if (actual === undefined) {
		throw new Error(`Invalid PostgreSQL version "${version}"`);
	}
	if (actual < POSTGRESQL_CAPABILITY_FLOOR) {
		throw new Error(
			`Unsupported PostgreSQL version "${version}"; minimum supported major version is 10`,
		);
	}

	const caps: MutableDialectCapabilities = { ...POSTGRESQL_CAPABILITIES };
	for (const projection of INDEX_FEATURE_CAPABILITY_PROJECTIONS) {
		if (actual < projection.descriptor.predicate.minServerVersionNum) {
			caps[projection.flag] = false;
		}
	}
	POSTGRESQL_CAPABILITY_TARGET_VERSIONS.set(caps, trimmed);
	return caps;
}

export function getPostgresqlCapabilitiesTargetVersion(
	caps: DialectCapabilities,
): string | undefined {
	return POSTGRESQL_CAPABILITY_TARGET_VERSIONS.get(caps);
}
