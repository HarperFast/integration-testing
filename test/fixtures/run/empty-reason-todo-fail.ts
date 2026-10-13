import { test } from 'node:test';
import assert from 'node:assert';

test('a todo test with an empty reason that fails', { todo: '' }, () => {
	assert.strictEqual(1, 2);
});
