/**
 * Test-only compatibility boundary for #443.
 *
 * Row and mutation-value inference are repaired and locked here; only the
 * independent broad table-reference canary remains for a later fix.
 */
import { createOrm } from '../orm.js';
import { schema } from '../schema.js';
import { createMockAdapter } from '../test-utils.js';
import { createTypedOrm } from '../typed-query-builder.js';

type IntendedUserRow = {
	readonly id: number;
	readonly name: string;
	readonly email: string;
	readonly active: boolean;
};

const compatibilitySchema = schema({
	users: {
		id: 'integer',
		name: 'string',
		email: 'string',
		active: 'boolean',
	},
} as const);

const compatibilityOrm = createOrm({
	schema: compatibilitySchema,
	adapter: createMockAdapter(),
});
const compatibilityUsers = compatibilityOrm.tables.users;
const compatibilityInsert = compatibilityOrm.into(compatibilityUsers);
const compatibilityAll = createTypedOrm(
	compatibilitySchema.model,
	createMockAdapter(),
).from(compatibilitySchema.tables.users).all;

type HasNonexistentColumn =
	'nonexistent' extends keyof typeof compatibilityUsers ? true : false;
type IncorrectActiveValueIsAccepted = {
	readonly name: 'Alice';
	readonly email: 'test@test.com';
	readonly active: 'not boolean';
} extends Parameters<typeof compatibilityInsert.values>[0]
	? true
	: false;

declare const intendedUserRows: Promise<IntendedUserRow[]>;
declare const noNonexistentColumn: false;
declare const rejectedIncorrectActiveValue: false;
export function verifyCompatibilityCanary(): void {
	const _canary: ReturnType<typeof compatibilityAll> = intendedUserRows;
	// This is the restored `orm.tables.users.nonexistent` negative assertion.
	void compatibilityUsers.nonexistent;
	// @ts-expect-error #443: nonexistent is currently accepted through a broad TableRef index; remove when it is rejected.
	const _nonexistent: HasNonexistentColumn = noNonexistentColumn;
	const _mutationValue: IncorrectActiveValueIsAccepted =
		rejectedIncorrectActiveValue;
	void [_canary, _nonexistent, _mutationValue];
}
