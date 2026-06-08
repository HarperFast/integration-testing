import { test, before, after } from 'node:test';
import { ok, strictEqual, match, rejects } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { killHarper, runHarperCommand, HarperStartupError, type StartedHarperTestContext } from '../src/harperLifecycle.ts';

// Standalone scripts used as a fake "Harper binary" (passed via harperBinPath) to drive
// runHarperCommand's startup watchdog through specific timing scenarios without a real Harper.
const FIXTURE_SOURCES: Record<string, string> = {
	// Reports ready, then stays alive like a server.
	'ready.cjs': "process.stdout.write('booting\\n');\nsetTimeout(() => process.stdout.write('successfully started\\n'), 50);\nsetInterval(() => {}, 1000);\n",
	// Emits one line, then goes silent forever (hung during startup).
	'idle-hang.cjs': "process.stdout.write('booting\\n');\nsetInterval(() => {}, 1000);\n",
	// Emits output continuously but never reports ready.
	'chatty.cjs': "setInterval(() => process.stdout.write('tick\\n'), 100);\n",
	// Emits progress every 100ms (each gap well under the idle window) and only reports ready
	// after ~800ms — longer than the idle window, so a single total-deadline would have failed.
	'idle-reset.cjs': "let n = 0;\nconst t = setInterval(() => {\n  n++;\n  process.stdout.write('progress ' + n + '\\n');\n  if (n >= 8) { clearInterval(t); process.stdout.write('successfully started\\n'); }\n}, 100);\nsetInterval(() => {}, 1000);\n",
	// Exits non-zero.
	'exit-nonzero.cjs': "process.stderr.write('boom\\n');\nprocess.exit(1);\n",
};

let fixtureDir: string;
const fixtures: Record<string, string> = {};

before(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), 'harper-it-fixtures-'));
	for (const [name, src] of Object.entries(FIXTURE_SOURCES)) {
		const path = join(fixtureDir, name);
		writeFileSync(path, src);
		fixtures[name] = path;
	}
});

after(() => {
	rmSync(fixtureDir, { recursive: true, force: true });
});

function fakeCtx(process?: ChildProcess): StartedHarperTestContext {
	return { harper: { process } } as unknown as StartedHarperTestContext;
}

/** Resolves once `needle` has appeared on the child's stdout. */
function waitForOutput(child: ChildProcess, needle: string): Promise<void> {
	return new Promise((resolve) => {
		let buffer = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			buffer += chunk.toString();
			if (buffer.includes(needle)) resolve();
		});
	});
}

/** Resolves with the regex match once it appears on the child's stdout. */
function waitForMatch(child: ChildProcess, regex: RegExp): Promise<RegExpMatchArray> {
	return new Promise((resolve) => {
		let buffer = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			buffer += chunk.toString();
			const matched = buffer.match(regex);
			if (matched) resolve(matched);
		});
	});
}

/** Polls (signal 0) until `pid` no longer exists, or the timeout elapses. */
async function waitProcessGone(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch {
			return true; // ESRCH — process is gone
		}
		if (Date.now() >= deadline) return false;
		await sleep(50);
	}
}

// --- Startup watchdog (Race 1) ---

test('runHarperCommand resolves when the completion message appears', async () => {
	const result = await runHarperCommand({
		args: [],
		env: {},
		completionMessage: 'successfully started',
		harperBinPath: fixtures['ready.cjs'],
		timeoutMs: 2000,
		maxMs: 10000,
	});
	try {
		match(result.stdout, /successfully started/);
	} finally {
		result.process.kill('SIGKILL');
	}
});

test('runHarperCommand rejects when output is silent past the idle timeout', async () => {
	await rejects(
		runHarperCommand({
			args: [],
			env: {},
			completionMessage: 'successfully started',
			harperBinPath: fixtures['idle-hang.cjs'],
			timeoutMs: 300,
			maxMs: 10000,
		}),
		(err: Error) => {
			ok(err instanceof HarperStartupError);
			match(err.message, /no startup output for 300ms/);
			return true;
		}
	);
});

test('runHarperCommand enforces the absolute max even while output keeps flowing', async () => {
	await rejects(
		runHarperCommand({
			args: [],
			env: {},
			completionMessage: 'successfully started',
			harperBinPath: fixtures['chatty.cjs'],
			timeoutMs: 2000,
			maxMs: 500,
		}),
		(err: Error) => {
			ok(err instanceof HarperStartupError);
			match(err.message, /maximum startup time of 500ms/);
			return true;
		}
	);
});

test('runHarperCommand keeps a slow-but-progressing boot alive past the idle window', async () => {
	const result = await runHarperCommand({
		args: [],
		env: {},
		completionMessage: 'successfully started',
		harperBinPath: fixtures['idle-reset.cjs'],
		timeoutMs: 400,
		maxMs: 10000,
	});
	try {
		match(result.stdout, /successfully started/);
	} finally {
		result.process.kill('SIGKILL');
	}
});

test('runHarperCommand rejects when the process exits non-zero', async () => {
	await rejects(
		runHarperCommand({
			args: [],
			env: {},
			completionMessage: 'successfully started',
			harperBinPath: fixtures['exit-nonzero.cjs'],
			timeoutMs: 5000,
			maxMs: 10000,
		}),
		(err: Error) => {
			ok(err instanceof HarperStartupError);
			match(err.message, /failed with exit code\/signal 1/);
			return true;
		}
	);
});

// --- Teardown kill (Race 2) ---

// Children are spawned `detached` to mirror how Harper is spawned: as a process-group leader,
// so killHarper's group signal (negative PID on POSIX) targets the whole tree.

test('killHarper terminates a process that exits on SIGTERM, before the grace deadline', async () => {
	const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true });
	await once(child, 'spawn');
	await killHarper(fakeCtx(child), { graceMs: 2000 });
	// A SIGTERM signalCode proves it died from the SIGTERM, before killHarper escalated to SIGKILL at
	// the grace deadline — so this also covers "terminated before the grace deadline" without a
	// flaky wall-clock upper bound.
	strictEqual(child.signalCode, 'SIGTERM');
});

test('killHarper escalates to SIGKILL when SIGTERM is ignored', async () => {
	// Announce 'ready' only after the SIGTERM handler is installed, so the parent doesn't race
	// the child's startup and send SIGTERM before the handler exists.
	const child = spawn(
		process.execPath,
		['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
		{ detached: true }
	);
	await waitForOutput(child, 'ready');
	const start = Date.now();
	await killHarper(fakeCtx(child), { graceMs: 200 });
	strictEqual(child.signalCode, 'SIGKILL');
	ok(Date.now() - start >= 150, 'should wait the grace period before escalating to SIGKILL');
});

test('killHarper kills the whole process tree, not just the direct child', { skip: process.platform === 'win32' }, async () => {
	// A detached parent that spawns its own (non-detached) child, so the child shares the parent's
	// process group. A group-targeted kill must reap the child too — the core of the fix.
	const parent = spawn(
		process.execPath,
		[
			'-e',
			"const{spawn}=require('node:child_process');" +
				"const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
				"process.stdout.write('child:'+c.pid+'\\n');" +
				'setInterval(()=>{},1000)',
		],
		{ detached: true }
	);
	const childPid = parseInt((await waitForMatch(parent, /child:(\d+)/))[1], 10);
	await killHarper(fakeCtx(parent), { graceMs: 200 });
	ok(parent.exitCode !== null || parent.signalCode !== null, 'parent should be dead');
	ok(await waitProcessGone(childPid, 2000), `grandchild ${childPid} should have been killed with the group`);
});

test('killHarper returns immediately when there is no process', async () => {
	await killHarper(fakeCtx(undefined));
	await killHarper({} as unknown as StartedHarperTestContext);
});

test('killHarper returns immediately for an already-exited process', async () => {
	const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
	await once(child, 'exit');
	const start = Date.now();
	await killHarper(fakeCtx(child), { graceMs: 5000 });
	// Generous ceiling, far under the 5s grace: proves it took the already-exited fast path rather
	// than waiting out the grace, while leaving plenty of headroom for a contended-CI stall.
	ok(Date.now() - start < 1000, 'should not wait the grace period for an already-dead process');
});
