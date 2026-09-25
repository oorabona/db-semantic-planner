import { expect, it } from 'vitest';
import { generatedSequenceDefaultPredicate } from './generated-sequence-default.js';

it('preserves the verifier generated-sequence evidence SQL byte-for-byte', () => {
	const predicate = generatedSequenceDefaultPredicate({
		relation: 'relation',
		attribute: 'attribute',
		attrdef: 'default_value',
	});

	expect(`${predicate} AS generated_sequence_default`).toBe(
		"(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, false) ~ $dbsp_serial$^nextval\\('([^']|'')*'::regclass\\)$dbsp_serial$ AND EXISTS (SELECT 1 FROM pg_catalog.pg_depend default_sequence JOIN pg_catalog.pg_class sequence_relation ON sequence_relation.oid = default_sequence.refobjid WHERE default_sequence.classid = 'pg_catalog.pg_attrdef'::pg_catalog.regclass AND default_sequence.objid = default_value.oid AND default_sequence.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND default_sequence.deptype = 'n' AND sequence_relation.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_catalog.pg_depend ownership WHERE ownership.classid = 'pg_catalog.pg_class'::pg_catalog.regclass AND ownership.objid = sequence_relation.oid AND ownership.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass AND ownership.refobjid = relation.oid AND ownership.refobjsubid = attribute.attnum AND ownership.deptype = 'a'))) AS generated_sequence_default",
	);
});
