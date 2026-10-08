import { test } from 'node:test';
import assert from 'node:assert';

test('a todo test that fails', { todo: true }, () => {
	assert.strictEqual(1, 2);
});
