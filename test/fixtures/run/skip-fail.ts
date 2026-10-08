import { test } from 'node:test';
import assert from 'node:assert';

// `t.skip()` from inside the body, not `{ skip: true }`: the option skips the body entirely, so the
// test never fails and never reaches the runner's `data.skip` branch.
test('a skipped test that fails', (t) => {
	t.skip('skipped for testing');
	assert.strictEqual(1, 2);
});
