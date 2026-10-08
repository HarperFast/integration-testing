import { test } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const RUN_SCRIPT = fileURLToPath(new URL('../src/run.ts', import.meta.url));

function fixture(name: string): string {
	return fileURLToPath(new URL(`./fixtures/run/${name}`, import.meta.url));
}

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
	strictEqual(await runCli(fixture('todo-fail.ts'), t.signal), 0);
});

test('a suite whose only failure is a skipped test exits 0', { timeout: 15_000 }, async (t) => {
	strictEqual(await runCli(fixture('skip-fail.ts'), t.signal), 0);
});

test('a suite whose only failure is a todo test with an empty reason exits 0', { timeout: 15_000 }, async (t) => {
	strictEqual(await runCli(fixture('empty-reason-todo-fail.ts'), t.signal), 0);
});

test('a suite with a real failure exits 1 (control)', { timeout: 15_000 }, async (t) => {
	strictEqual(await runCli(fixture('real-fail.ts'), t.signal), 1);
});
