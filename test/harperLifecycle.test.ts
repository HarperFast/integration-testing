import { test, before, after } from 'node:test';
import { ok, strictEqual, match, rejects } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	killHarper,
	teardownHarper,
	markHarperNode,
	publishHarperNode,
	setupHarperWithFixture,
	startHarper,
	runHarperCommand,
	HarperStartupError,
	buildHarperChildEnv,
	type StartedHarperTestContext,
} from '../src/harperLifecycle.ts';

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

// On POSIX, children are spawned `detached` to mirror how Harper is spawned (a process-group
// leader), so killHarper's group signal (negative PID) targets the whole tree. Windows has no
// process groups — killHarper uses `taskkill /T` there — and no real POSIX signals, so the
// signal-specific assertions below are guarded to POSIX.
const isPosix = process.platform !== 'win32';

test('killHarper terminates a process that exits on SIGTERM, before the grace deadline', async () => {
	const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: isPosix });
	await once(child, 'spawn');
	// On Windows the SIGTERM-equivalent (taskkill without /F) won't stop a background node process,
	// so killHarper waits the full grace before force-killing; use a short grace there to avoid a
	// needless multi-second delay.
	await killHarper(fakeCtx(child), { graceMs: isPosix ? 2000 : 100 });
	ok(child.exitCode !== null || child.signalCode !== null, 'process should be dead after killHarper');
	if (isPosix) {
		// A SIGTERM signalCode proves it died from the SIGTERM, before killHarper escalated to SIGKILL
		// at the grace deadline — so this also covers "terminated before the grace deadline" without a
		// flaky wall-clock upper bound.
		strictEqual(child.signalCode, 'SIGTERM');
	}
});

test('killHarper escalates to SIGKILL when SIGTERM is ignored', { skip: !isPosix }, async () => {
	// POSIX-only: relies on the child trapping SIGTERM, which Windows has no real equivalent for.
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

test('killHarper kills the whole process tree, not just the direct child', { skip: !isPosix }, async () => {
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

test('teardownHarper rejects the node it published, and killHarper does too', async () => {
	const node = markHarperNode({ hostname: '127.0.0.2', operationsAPIURL: 'http://127.0.0.2:9925' });
	await rejects(
		() => teardownHarper(node as unknown as StartedHarperTestContext),
		(error: Error) => {
			ok(error instanceof TypeError, `expected a TypeError, got ${error.constructor.name}`);
			match(error.message, /expects the test context, but received the Harper node it holds/);
			match(error.message, /teardownHarper\(\{ harper: node \}\)/);
			return true;
		}
	);
	await rejects(() => killHarper(node as unknown as StartedHarperTestContext), /killHarper\(ctx\) expects the test context/);
});

// `startHarper(ctx.harper)` type-checks; unguarded it claimed a second install and loopback address.
test('the entry points reject the node too, before allocating anything', async () => {
	const node = markHarperNode({ hostname: '127.0.0.2', dataRootDir: '/tmp/already-installed' });
	// The remedy must NOT be "wrap it" here: doing that publishes a fresh node over the live one.
	for (const start of [
		() => startHarper(node as unknown as StartedHarperTestContext),
		() => setupHarperWithFixture(node as unknown as StartedHarperTestContext, fixtureDir),
	]) {
		await rejects(start, (error: Error) => {
			match(error.message, /expects the test context, but received the Harper node it holds/);
			match(error.message, /Pass the context the node came from/);
			ok(!/Wrap it:/.test(error.message), 'a start function must not advise wrapping a live node');
			return true;
		});
	}
});

test('teardownHarper still tears down a correctly wrapped context', async () => {
	const dataRootDir = mkdtempSync(join(tmpdir(), 'guard-teardown-'));
	await teardownHarper({ harper: markHarperNode({ dataRootDir }) } as unknown as StartedHarperTestContext);
	strictEqual(existsSync(dataRootDir), false, 'teardown should have removed the install directory');
});

test('the brand is not enumerable', () => {
	const node = markHarperNode({ hostname: '127.0.0.2' });
	strictEqual(Object.keys(node).length, 1);
	strictEqual(JSON.stringify(node), '{"hostname":"127.0.0.2"}');
});

test('killHarper rejects a live node unwrapped before signaling it, and reaps it once wrapped', async () => {
	const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
	const node = markHarperNode({ hostname: '127.0.0.2', process: child });
	try {
		await rejects(() => killHarper(node as unknown as StartedHarperTestContext), TypeError);
		strictEqual(child.exitCode, null, 'the guard must reject before any signal is sent');

		await killHarper({ harper: node } as unknown as StartedHarperTestContext, { graceMs: 200 });
		ok(child.exitCode !== null || child.signalCode !== null, 'the wrapped call must reap the child');
	} finally {
		child.kill('SIGKILL');
	}
});

test('an unbranded context is a no-op even when it carries node-like field names', async () => {
	await teardownHarper({} as unknown as StartedHarperTestContext);
	await teardownHarper({ name: 'suite-that-threw-in-before' } as unknown as StartedHarperTestContext);
	await teardownHarper({
		httpURL: 'http://127.0.0.2:3000',
		operationsAPIURL: 'http://127.0.0.2:9925',
		dataRootDir: '/tmp/a-caller-owned-path',
		admin: { username: 'admin' },
	} as unknown as StartedHarperTestContext);
});

// Every node reaches `ctx.harper` through publishHarperNode, so branding it there is what makes the
// guard apply to real nodes. Exercised directly: reaching the two call sites needs a loopback slot
// and a real install, which this suite deliberately never takes.
test('publishHarperNode brands what it assigns', async () => {
	const dataRootDir = mkdtempSync(join(tmpdir(), 'guard-publish-'));
	const ctx: { harper?: Partial<{ dataRootDir: string }> } = {};
	publishHarperNode(ctx, { dataRootDir });
	strictEqual(ctx.harper?.dataRootDir, dataRootDir);
	await rejects(
		() => teardownHarper(ctx.harper as unknown as StartedHarperTestContext),
		/received the Harper node it holds/
	);
	await teardownHarper(ctx as unknown as StartedHarperTestContext);
	strictEqual(existsSync(dataRootDir), false, 'the wrapped context must still tear down');
});

test('the shape guard rejects a non-object argument', async () => {
	await rejects(
		() => teardownHarper(undefined as unknown as StartedHarperTestContext),
		/requires a test context object, received undefined/
	);
	await rejects(
		() => teardownHarper(null as unknown as StartedHarperTestContext),
		/requires a test context object, received null/
	);
	// A suite that keeps its nodes in an array reaches the no-op this way: `[a, b].harper` is undefined.
	await rejects(
		() => teardownHarper([{ harper: markHarperNode({}) }] as unknown as StartedHarperTestContext),
		/requires a test context object, received an array\. Pass each context separately\./
	);
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

// Regression guard: the dataRootDir HOME isolation must take precedence over any caller-supplied env (or a
// spread of process.env, which contains HOME). If a caller could clobber HOME/USERPROFILE, Harper's global
// boot pointer would land in the developer's real ~/.harperdb and outlive the throwaway instance.
test('buildHarperChildEnv: HOME/USERPROFILE isolation wins over caller-supplied env', () => {
	const env = buildHarperChildEnv('/tmp/data-root', { logging: { level: 'debug' } }, {
		HOME: '/should/not/win',
		USERPROFILE: '/should/not/win',
		CUSTOM_VAR: 'kept',
	});
	strictEqual(env.HOME, '/tmp/data-root', 'isolated HOME must override caller env');
	strictEqual(env.USERPROFILE, '/tmp/data-root', 'isolated USERPROFILE must override caller env');
	strictEqual(env.CUSTOM_VAR, 'kept', 'non-isolation caller env is still passed through');
	strictEqual(env.HARPER_SET_CONFIG, JSON.stringify({ logging: { level: 'debug' } }));
});

test('buildHarperChildEnv: isolates HOME/USERPROFILE to dataRootDir by default', () => {
	const env = buildHarperChildEnv('/tmp/data-root', {});
	strictEqual(env.HOME, '/tmp/data-root');
	strictEqual(env.USERPROFILE, '/tmp/data-root');
});
