import { test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN_SCRIPT = fileURLToPath(new URL('../src/run.ts', import.meta.url));

// The skip fixture calls `t.skip()` from inside the body instead of passing `{ skip: true }`, which
// skips the body entirely and would never reach the `data.skip` branch under test.
const FIXTURE_SOURCES: Record<string, string> = {
	'todo-fail.test.mjs': `
import { test } from 'node:test';
import assert from 'node:assert';

test('a todo test that fails', { todo: true }, () => {
	assert.strictEqual(1, 2);
});
`,
	'skip-fail.test.mjs': `
import { test } from 'node:test';
import assert from 'node:assert';

test('a skipped test that fails', (t) => {
	t.skip('skipped for testing');
	assert.strictEqual(1, 2);
});
`,
	'empty-reason-todo-fail.test.mjs': `
import { test } from 'node:test';
import assert from 'node:assert';

test('a todo test with a falsy reason that fails', { todo: '' }, () => {
	assert.strictEqual(1, 2);
});
`,
	'real-fail.test.mjs': `
import { test } from 'node:test';
import assert from 'node:assert';

test('a real failure', () => {
	assert.strictEqual(1, 2);
});
`,
};

let fixtureDir: string | undefined;
const fixtures: Record<string, string> = {};

before(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), 'harper-it-run-fixtures-'));
	for (const [name, src] of Object.entries(FIXTURE_SOURCES)) {
		const path = join(fixtureDir, name);
		writeFileSync(path, src);
		fixtures[name] = path;
	}
});

after(() => {
	if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HARPER_INTEGRATION_TEST_')));

async function runCli(globPattern: string, signal: AbortSignal): Promise<number> {
	const child = spawn(process.execPath, [RUN_SCRIPT, '--isolation=none', globPattern], {
		stdio: 'ignore',
		env: cleanEnv,
		signal,
	});
	const [code, exitSignal] = await once(child, 'exit');
	ok(exitSignal === null, `run.ts was killed by signal ${exitSignal}`);
	return code;
}

test('a suite whose only failure is a todo test exits 0', { timeout: 15_000 }, async (t) => {
	strictEqual(await runCli(fixtures['todo-fail.test.mjs'], t.signal), 0);
});

test('a suite whose only failure is a skipped test exits 0', { timeout: 15_000 }, async (t) => {
	strictEqual(await runCli(fixtures['skip-fail.test.mjs'], t.signal), 0);
});

test('a suite whose only failure is a todo test with a falsy reason exits 0', { timeout: 15_000 }, async (t) => {
	strictEqual(await runCli(fixtures['empty-reason-todo-fail.test.mjs'], t.signal), 0);
});

test('a suite with a real failure exits 1 (control)', { timeout: 15_000 }, async (t) => {
	strictEqual(await runCli(fixtures['real-fail.test.mjs'], t.signal), 1);
});
