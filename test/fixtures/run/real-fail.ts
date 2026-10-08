import { test } from 'node:test';
import assert from 'node:assert';

test('a real failure', () => {
	assert.strictEqual(1, 2);
});
