import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert';
import * as fsPromises from 'node:fs/promises';
import * as childProcess from 'node:child_process';
import * as timersPromises from 'node:timers/promises';
import { createServer, type AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarperTestContext, StartedHarperTestContext } from '../src/harperLifecycle.ts';
import * as portUtils from '../src/portUtils.ts';

const root = await fsPromises.mkdtemp(join(tmpdir(), 'harper-startup-deadline-'));
const poolPath = join(root, 'harper-integration-test-loopback-pool.json');
const logRoot = join(root, 'logs');
const readyScript = join(root, 'ready.cjs');
const chattyScript = join(root, 'chatty.cjs');
const exitScript = join(root, 'exit.cjs');
const cleanExitScript = join(root, 'clean-exit.cjs');
const descendantScript = join(root, 'descendant.cjs');
await fsPromises.writeFile(readyScript, "process.stdout.write('successfully started\\n'); setInterval(() => {}, 1000);\n");
await fsPromises.writeFile(chattyScript, "setInterval(() => process.stdout.write('booting\\n'), 10);\n");
await fsPromises.writeFile(exitScript, "process.stderr.write('boot failed\\n'); process.exit(1);\n");
await fsPromises.writeFile(cleanExitScript, "process.exit(0);\n");
await fsPromises.writeFile(descendantScript, `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', "require('node:net').createServer().listen(Number(process.env.TEST_PORT), '127.0.0.1', () => process.stdout.write('listening'))"], { stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.once('data', () => {
  process.stderr.write('descendant:' + child.pid + '\\n');
  process.exit(1);
});
`);

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const port = (server.address() as AddressInfo).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

const overrides = {
	TMPDIR: root,
	TMP: root,
	TEMP: root,
	HARPER_RUNTIME: 'node',
	HARPER_INTEGRATION_TEST_MONITOR: 'off',
	HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR: root,
	HARPER_INTEGRATION_TEST_LOG_DIR: logRoot,
	HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START: '1',
	HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT: '1',
	HARPER_INTEGRATION_TEST_CONFLICT_PROBE_PORT: String(await freePort()),
	HARPER_INTEGRATION_TEST_HTTP_CONFLICT_PROBE_PORT: String(await freePort()),
};
const savedEnv = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
Object.assign(process.env, overrides);
const testPort = await freePort();

let clock: number;
let setupElapsedMs = 0;
let publishElapsedMs = 0;
let poolWaitElapsedMs = 0;
let readinessElapsedMs = 0;
let exitElapsedMs = 0;
let setupError: Error | undefined;
let corruptDuringSetup = false;
let replaceDuringSetup = false;
let unconfirmedChild: childProcess.ChildProcess | undefined;
let portsRemainHeld = false;
let observeRelease = false;
let releasedWhileChildAlive = false;
const children: childProcess.ChildProcess[] = [];
let restoreClock: (() => void) | undefined;

mock.module('node:fs/promises', {
	namedExports: {
		...fsPromises,
		mkdir: async (...args: Parameters<typeof fsPromises.mkdir>) => {
			clock += setupElapsedMs;
			if (corruptDuringSetup) await fsPromises.writeFile(poolPath, '[torn');
			if (replaceDuringSetup) {
				await fsPromises.writeFile(poolPath, '[torn');
				const oldMtime = new Date(clock - 360001);
				await fsPromises.utimes(poolPath, oldMtime, oldMtime);
				await getNextAvailableLoopbackAddress();
			}
			if (setupError) throw setupError;
			return fsPromises.mkdir(...args);
		},
		rename: async (...args: Parameters<typeof fsPromises.rename>) => {
			await fsPromises.rename(...args);
			if (args[1] === poolPath) {
				clock += publishElapsedMs;
				publishElapsedMs = 0;
				if (observeRelease && await fsPromises.readFile(poolPath, 'utf-8') === '[null]') {
					releasedWhileChildAlive = !(await portUtils.isPortFree('127.0.0.1', testPort));
				}
			}
		},
	},
});
mock.module('../src/portUtils.ts', {
	namedExports: {
		...portUtils,
		waitForPortsFree: async (host: string, ports: number[], timeoutMs: number) => {
			deepStrictEqual(ports, [9925, 9926, 9927, 1883, 8883]);
			if (portsRemainHeld) return false;
			return portUtils.waitForPortsFree(host, [testPort], timeoutMs);
		},
	},
});
mock.module('node:timers/promises', {
	namedExports: {
		...timersPromises,
		setTimeout: async (...args: Parameters<typeof timersPromises.setTimeout>) => {
			if (poolWaitElapsedMs) {
				clock += poolWaitElapsedMs;
				poolWaitElapsedMs = 0;
				await fsPromises.writeFile(poolPath, '[null]');
				return;
			}
			return timersPromises.setTimeout(...args);
		},
	},
});
mock.module('node:child_process', {
	namedExports: {
		...childProcess,
		spawn: (...args: Parameters<typeof childProcess.spawn>) => {
			if (unconfirmedChild && args[0] !== 'taskkill') return unconfirmedChild;
			const child = childProcess.spawn(...args);
			if (args[0] !== 'taskkill') {
				children.push(child);
				child.stdout?.on('data', (chunk: Buffer) => {
					if (chunk.toString().includes('successfully started')) clock += readinessElapsedMs;
				});
				child.on('exit', () => { clock += exitElapsedMs; });
			}
			return child;
		},
	},
});

const { startHarper, setupHarperWithFixture, killHarper, teardownHarper, HarperStartupError, DEFAULT_STARTUP_MAX_MS } =
	await import('../src/harperLifecycle.ts');
const { readPoolFile, getNextAvailableLoopbackAddress } = await import('../src/loopbackAddressPool.ts');

beforeEach(async () => {
	restoreClock = undefined;
	clock = Date.now();
	const clockMock = mock.method(Date, 'now', () => clock);
	restoreClock = () => clockMock.mock.restore();
	setupElapsedMs = publishElapsedMs = poolWaitElapsedMs = readinessElapsedMs = exitElapsedMs = 0;
	setupError = undefined;
	corruptDuringSetup = false;
	replaceDuringSetup = false;
	unconfirmedChild = undefined;
	portsRemainHeld = observeRelease = releasedWhileChildAlive = false;
	children.length = 0;
	await fsPromises.writeFile(poolPath, '[null]');
});

afterEach(async () => {
	try {
		for (const child of children) {
			await killHarper({ harper: { process: child } } as StartedHarperTestContext, { graceMs: 0 });
		}
	} finally {
		restoreClock?.();
	}
});

after(async () => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await fsPromises.rm(root, { recursive: true, force: true });
});

async function assertCleanFailure(ctx: HarperTestContext): Promise<void> {
	deepStrictEqual(JSON.parse(await fsPromises.readFile(poolPath, 'utf-8')), [null], 'the claimed slot must be released');
	strictEqual(ctx.harper, undefined, 'an owned fixture install must be unpublished');
	deepStrictEqual((await fsPromises.readdir(root)).filter((name) => name.startsWith('harper-integration-test-') && !name.endsWith('.json')), [], 'owned installs must be removed');
}

function startupError(maxMs: number): (error: Error) => boolean {
	return (error) => {
		ok(error instanceof HarperStartupError);
		match(error.message, new RegExp(`maximum startup time of ${maxMs}ms`));
		return true;
	};
}

for (const maxMs of [0, 1000, DEFAULT_STARTUP_MAX_MS]) {
	test(`setup at the ${maxMs}ms ceiling refuses spawn and cleans up`, async () => {
		setupElapsedMs = maxMs;
		const ctx: HarperTestContext = {};
		await rejects(startHarper(ctx, {
			harperBinPath: readyScript,
			startupMaxMs: maxMs === DEFAULT_STARTUP_MAX_MS ? undefined : maxMs,
		}), startupError(maxMs));
		strictEqual(children.length, 0, 'an expired start must never spawn');
		await assertCleanFailure(ctx);
	});
}

test('fixture startup expiry removes and unpublishes its owned install', async () => {
	const fixture = join(root, 'component');
	await fsPromises.mkdir(fixture);
	await fsPromises.writeFile(join(fixture, 'config.yaml'), 'name: fixture');
	setupElapsedMs = 1000;
	const ctx: HarperTestContext = {};
	await rejects(setupHarperWithFixture(ctx, fixture, { startupMaxMs: 1000, harperBinPath: readyScript }), startupError(1000));
	strictEqual(children.length, 0);
	await assertCleanFailure(ctx);
});

test('pool waits before the claim do not consume the startup ceiling', async () => {
	await fsPromises.writeFile(poolPath, `[${process.pid}]`);
	poolWaitElapsedMs = 10000;
	const ctx: HarperTestContext = {};
	try {
		await startHarper(ctx, { startupMaxMs: 1000, harperBinPath: readyScript });
		strictEqual(ctx.harper?.hostname, '127.0.0.1');
		match(ctx.harper?.startupOutput?.stdout || '', /successfully started/);
	} finally {
		await teardownHarper(ctx as StartedHarperTestContext);
	}
});

test('time spent publishing and validating an already claimed slot consumes the ceiling', async () => {
	publishElapsedMs = 1000;
	const ctx: HarperTestContext = {};
	await rejects(startHarper(ctx, { startupMaxMs: 1000, harperBinPath: readyScript }), startupError(1000));
	strictEqual(children.length, 0);
	await assertCleanFailure(ctx);
});

test('boot receives only the budget left after setup, and failure reaps before cleanup', async (t) => {
	setupElapsedMs = 900;
	const setTimer = t.mock.method(globalThis, 'setTimeout');
	const ctx: HarperTestContext = {};
	await rejects(startHarper(ctx, { startupMaxMs: 1000, startupTimeoutMs: 3000, harperBinPath: chattyScript }), startupError(1000));
	ok(setTimer.mock.calls.some((call) => call.arguments[1] === 100), 'only the remaining 100ms is available for boot');
	strictEqual(children.length, 1);
	ok(children[0].exitCode !== null || children[0].signalCode !== null, 'child exit must precede resource cleanup');
	await assertCleanFailure(ctx);
});

test('readiness observed at the deadline is rejected even before the timer fires', async () => {
	readinessElapsedMs = 1000;
	const ctx: HarperTestContext = {};
	await rejects(startHarper(ctx, { startupMaxMs: 1000, harperBinPath: readyScript }), startupError(1000));
	ok(children[0].exitCode !== null || children[0].signalCode !== null);
	await assertCleanFailure(ctx);
});

test('a failed exit retains its status and diagnostics even when observed at the deadline', async () => {
	exitElapsedMs = 1000;
	const ctx: HarperTestContext = {};
	await rejects(startHarper(ctx, { startupMaxMs: 1000, harperBinPath: exitScript }), (error: Error) => {
		ok(error instanceof HarperStartupError);
		match(error.message, /failed with exit code\/signal 1/);
		match(error.stderr, /boot failed/);
		return true;
	});
	await assertCleanFailure(ctx);
});

test('a normal exit observed at the deadline cannot bypass the startup ceiling', async () => {
	exitElapsedMs = 1000;
	const ctx: HarperTestContext = {};
	await rejects(startHarper(ctx, { startupMaxMs: 1000, harperBinPath: cleanExitScript }), startupError(1000));
	await assertCleanFailure(ctx);
});

test('a failed leader is reaped with its descendant before the slot is released', { skip: process.platform === 'win32' }, async () => {
	observeRelease = true;
	let descendantPid: number | undefined;
	const ctx: HarperTestContext = {};
	try {
		await rejects(startHarper(ctx, { startupMaxMs: 5000, harperBinPath: descendantScript, env: { TEST_PORT: String(testPort) } }), (error: Error) => {
			ok(error instanceof HarperStartupError);
			descendantPid = Number(error.stderr.match(/descendant:(\d+)/)?.[1]);
			ok(descendantPid);
			return true;
		});
		strictEqual(releasedWhileChildAlive, false, 'the pool must not be released while the descendant holds its port');
		ok(await portUtils.isPortFree('127.0.0.1', testPort), 'the descendant must have been killed');
		await assertCleanFailure(ctx);
	} finally {
		if (descendantPid) {
			try { process.kill(descendantPid, 'SIGKILL'); } catch {}
		}
	}
});

test('ports still held after failed startup keep the slot and owned directory parked', async (t) => {
	portsRemainHeld = true;
	const warn = t.mock.method(console, 'warn', () => {});
	try {
		await rejects(startHarper({}, { startupMaxMs: 1000, harperBinPath: exitScript }), /failed with exit code\/signal 1/);
		deepStrictEqual(JSON.parse(await fsPromises.readFile(poolPath, 'utf-8')), [process.pid]);
		ok((await fsPromises.readdir(root)).some((name) => name.startsWith('harper-integration-test-') && !name.endsWith('.json')));
		ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('still in use after startup failed')));
	} finally {
		for (const name of await fsPromises.readdir(root)) {
			if (name.startsWith('harper-integration-test-') && !name.endsWith('.json')) await fsPromises.rm(join(root, name), { recursive: true, force: true });
		}
	}
});

test('script resolution cannot admit a spawn after the deadline', async (t) => {
	const script = join(root, 'resolution-ready.cjs');
	await fsPromises.copyFile(readyScript, script);
	t.mock.method(console, 'log', () => { clock += 1000; });
	const ctx: HarperTestContext = {};
	await rejects(startHarper(ctx, { startupMaxMs: 1000, harperBinPath: script }), startupError(1000));
	strictEqual(children.length, 0);
	await assertCleanFailure(ctx);
});

test('a setup error releases the new reservation and removes its install', async () => {
	setupError = new Error('log mkdir failed');
	const ctx: HarperTestContext = {};
	await rejects(startHarper(ctx, { harperBinPath: readyScript }), (error) => error === setupError);
	await assertCleanFailure(ctx);
});

test('failed spawn cleans up without waiting for an exit event that never fires', async () => {
	const script = join(root, 'spawn-error.cjs');
	await fsPromises.copyFile(readyScript, script);
	await rejects(startHarper({}, { harperBinPath: script, env: { PATH: join(root, 'missing-bin') } }), { code: 'ENOENT' });
	strictEqual(children[0].pid, undefined);
	await assertCleanFailure({});
});

test('failure preserves a caller directory while releasing a newly claimed address', async () => {
	const dataRootDir = await fsPromises.mkdtemp(join(root, 'caller-install-'));
	const ctx: HarperTestContext = { harper: { dataRootDir } };
	setupElapsedMs = 1000;
	await rejects(startHarper(ctx, { startupMaxMs: 1000, harperBinPath: readyScript }), startupError(1000));
	deepStrictEqual(ctx.harper, { dataRootDir });
	ok((await fsPromises.stat(dataRootDir)).isDirectory());
	deepStrictEqual(JSON.parse(await fsPromises.readFile(poolPath, 'utf-8')), [null]);
});

test('a reused hostname has a fresh per-call budget and survives a failed restart', async () => {
	const dataRootDir = await fsPromises.mkdtemp(join(root, 'restart-install-'));
	const original = { dataRootDir, hostname: '127.0.0.1' };
	const ctx: HarperTestContext = { harper: original };
	await fsPromises.writeFile(poolPath, `[${process.pid}]`);
	setupElapsedMs = 1000;
	await rejects(startHarper(ctx, { startupMaxMs: 1000, harperBinPath: readyScript }), startupError(1000));
	strictEqual(ctx.harper, original);
	deepStrictEqual(JSON.parse(await fsPromises.readFile(poolPath, 'utf-8')), [process.pid]);
	setupElapsedMs = 500;
	try {
		const started = await startHarper(ctx, { startupMaxMs: 1000, harperBinPath: readyScript });
		match(started.harper.startupOutput?.stdout || '', /successfully started/);
	} finally {
		await teardownHarper(ctx as StartedHarperTestContext);
	}
});

test('an expired start leaves a pool corrupted after its claim quarantined and unchanged', async () => {
	setupElapsedMs = 1000;
	corruptDuringSetup = true;
	await rejects(startHarper({}, { startupMaxMs: 1000, harperBinPath: readyScript }), startupError(1000));
	strictEqual(children.length, 0);
	strictEqual(await fsPromises.readFile(poolPath, 'utf-8'), '[torn');
	strictEqual(await readPoolFile(), null, 'a lost claim must remain quarantined');
});

test('cleanup after quarantine recovery cannot clear a newer reservation with the same PID', async (t) => {
	setupElapsedMs = 360001;
	replaceDuringSetup = true;
	const warn = t.mock.method(console, 'warn', () => {});
	const ctx: HarperTestContext = {};
	await rejects(startHarper(ctx, { startupMaxMs: 1000, harperBinPath: readyScript }), startupError(1000));
	strictEqual(children.length, 0);
	deepStrictEqual(JSON.parse(await fsPromises.readFile(poolPath, 'utf-8')), [process.pid], 'cleanup must preserve the newer claim');
	ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('Skipping automatic release')));
});

test('an unconfirmed child exit keeps its reservation and install parked', async (t) => {
	const child = Object.assign(new EventEmitter(), {
		pid: 2147483647,
		exitCode: null,
		signalCode: null,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: () => true,
	}) as unknown as childProcess.ChildProcess;
	unconfirmedChild = child;
	const warn = t.mock.method(console, 'warn', () => {});
	try {
		await rejects(startHarper({}, { startupMaxMs: 10, harperBinPath: readyScript }), startupError(10));
		deepStrictEqual(JSON.parse(await fsPromises.readFile(poolPath, 'utf-8')), [process.pid]);
		ok((await fsPromises.readdir(root)).some((name) => name.startsWith('harper-integration-test-') && !name.endsWith('.json')));
		ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('Could not confirm startup process exit')));
	} finally {
		child.emit('exit', null, 'SIGKILL');
		for (const name of await fsPromises.readdir(root)) {
			if (name.startsWith('harper-integration-test-') && !name.endsWith('.json')) await fsPromises.rm(join(root, name), { recursive: true, force: true });
		}
	}
});
