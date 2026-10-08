import { test, before, after } from 'node:test';
import { strictEqual } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN_SCRIPT = fileURLToPath(new URL('../src/run.ts', import.meta.url));

// A todo-marked failure and a real failure, run through the actual CLI to exercise its exit-code
// semantics end to end (node:test's `test:fail` event fires for both; only the real one must fail the run).
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

test('a skipped test that fails', { skip: true }, () => {
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

let fixtureDir: string;
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
	rmSync(fixtureDir, { recursive: true, force: true });
});

async function runCli(globPattern: string): Promise<number> {
	const child = spawn(process.execPath, [RUN_SCRIPT, '--isolation=none', globPattern], {
		stdio: 'ignore',
	});
	const [code] = await once(child, 'exit');
	return code ?? 0;
}

test('a suite whose only failure is a todo test exits 0', async () => {
	strictEqual(await runCli(fixtures['todo-fail.test.mjs']), 0);
});

test('a suite whose only failure is a skipped test exits 0', async () => {
	strictEqual(await runCli(fixtures['skip-fail.test.mjs']), 0);
});

test('a suite with a real failure exits 1 (control)', async () => {
	strictEqual(await runCli(fixtures['real-fail.test.mjs']), 1);
});
