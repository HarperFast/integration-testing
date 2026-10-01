import { test, after, mock } from 'node:test';
import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isPortFree } from '../src/portUtils.ts';
import { RESETS_INSTEAD_OF_STALLING, startChildListener } from './stalledListener.ts';

const HOST = '127.0.0.1';
const ALLOW_ENV = 'HARPER_INTEGRATION_TEST_ALLOW_FOREIGN_LISTENERS';

function listen(host: string, port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(port, host, () => resolve(server));
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

/** Two distinct free ports: both are held at once, so the OS cannot hand out the same one twice. */
async function twoFreePorts(): Promise<[number, number]> {
	const servers = await Promise.all([listen(HOST, 0), listen(HOST, 0)]);
	const ports = servers.map((server) => (server.address() as AddressInfo).port);
	await Promise.all(servers.map(close));
	return [ports[0], ports[1]];
}

// The pool reads these once, when it is imported.
const poolDir = mkdtempSync(join(tmpdir(), 'loopback-pool-test-'));
const [operationsPort, httpPort] = await twoFreePorts();
// The pool keeps its state in os.tmpdir(), which prefers TMPDIR on POSIX and TEMP on Windows.
process.env.TMPDIR = process.env.TEMP = poolDir;
process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START = '1';
process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT = '1';
process.env.HARPER_INTEGRATION_TEST_CONFLICT_PROBE_PORT = String(operationsPort);
process.env.HARPER_INTEGRATION_TEST_HTTP_CONFLICT_PROBE_PORT = String(httpPort);
delete process.env[ALLOW_ENV];
const { getNextAvailableLoopbackAddress, releaseLoopbackAddress, readPoolFile, writePoolFile } = await import('../src/loopbackAddressPool.ts');
const { startHarper, setupHarperWithFixture, publishHarperNode, createHarperContext } = await import(
	'../src/harperLifecycle.ts'
);

after(() => rmSync(poolDir, { recursive: true, force: true }));

function readPool(): unknown {
	return JSON.parse(readFileSync(join(poolDir, 'harper-integration-test-loopback-pool.json'), 'utf-8'));
}

const CANARY_CATCHES_IT =
	'an exclusive bind of the pool address conflicts with a listener on all interfaces here, so the conflict canary refuses the address before this check runs';

/** Where an exclusive bind of the pool address conflicts with it (Linux), resolves a reason to skip instead. */
async function listenOnAllInterfaces(host: string, port: number): Promise<Server | string> {
	let server: Server;
	try {
		server = await listen(host, port);
	} catch (error) {
		return `cannot listen on ${host}: ${(error as NodeJS.ErrnoException).code}`;
	}
	if (await isPortFree(HOST, port)) return server;
	await close(server);
	return CANARY_CATCHES_IT;
}

/** The allocation's rejection; an address handed out instead goes back first, so the one-slot pool cannot wedge. */
async function refusal(): Promise<any> {
	let address: string;
	try {
		address = await getNextAvailableLoopbackAddress();
	} catch (error) {
		return error;
	}
	await releaseLoopbackAddress(address);
	throw new Error(`expected getNextAvailableLoopbackAddress to reject, but it handed out ${address}`);
}

let freshImportCounter = 0;
/** Monotonic cache-busting suffix — millisecond-resolution timestamps can collide. */
function freshModuleUrl(): string {
	return `../src/loopbackAddressPool.ts?fresh=${++freshImportCounter}`;
}

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), 'loopback-pool-test-'));
	try {
		await body(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const POOL_FILE_NAME = 'harper-integration-test-loopback-pool.json';

/** Makes a file look like it was last written an hour ago, well past the quarantine. */
async function age(path: string): Promise<void> {
	const anHourAgo = new Date(Date.now() - 3600000);
	await utimes(path, anHourAgo, anHourAgo);
}

/**
 * A fresh copy of the pool module whose pool and lock live in `dir` and which hands out only
 * 127.0.0.1. Both canary ports are 0 (an ephemeral bind, always free) so a real Harper on this
 * machine can't make the result depend on the host.
 */
async function importIsolatedPool(dir: string): Promise<typeof import('../src/loopbackAddressPool.ts')> {
	const overrides: Record<string, string> = {
		TMPDIR: dir,
		TMP: dir,
		TEMP: dir,
		HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START: '1',
		HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT: '1',
		HARPER_INTEGRATION_TEST_CONFLICT_PROBE_PORT: '0',
		HARPER_INTEGRATION_TEST_HTTP_CONFLICT_PROBE_PORT: '0',
	};
	const saved = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
	Object.assign(process.env, overrides);
	try {
		return await import(freshModuleUrl());
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test('hands out an address when no other process listens on its ports', async () => {
	const address = await getNextAvailableLoopbackAddress();
	strictEqual(address, HOST);
	await releaseLoopbackAddress(address);
	deepStrictEqual(readPool(), [null]);
});

for (const wildcard of ['0.0.0.0', '::']) {
	for (const [portName, port] of [
		['operations', operationsPort],
		['HTTP', httpPort],
	] as const) {
		test(`refuses an address whose ${portName} port a listener on ${wildcard} accepts, and releases it`, async (t) => {
			const listener = await listenOnAllInterfaces(wildcard, port);
			if (typeof listener === 'string') return t.skip(listener);
			let error: any;
			try {
				error = await refusal();
			} finally {
				await close(listener);
			}
			strictEqual(error.name, 'ForeignListenerError');
			strictEqual(error.loopbackAddress, HOST);
			strictEqual(error.port, port);
			match(error.message, new RegExp(`${HOST}:${port}`));
			match(error.message, new RegExp(`${ALLOW_ENV}=1`));
			deepStrictEqual(readPool(), [null], 'the refused address must go back to the pool');
		});
	}
}

for (const value of ['1', 'true', 'TRUE']) {
	test(`hands the address out with a warning when ${ALLOW_ENV}=${value}`, async (t) => {
		const listener = await listenOnAllInterfaces('0.0.0.0', httpPort);
		if (typeof listener === 'string') return t.skip(listener);
		const warn = t.mock.method(console, 'warn', () => {});
		process.env[ALLOW_ENV] = value;
		try {
			const address = await getNextAvailableLoopbackAddress();
			strictEqual(address, HOST);
			await releaseLoopbackAddress(address);
		} finally {
			delete process.env[ALLOW_ENV];
			await close(listener);
		}
		const warnings = warn.mock.calls.map((call) => String(call.arguments[0]));
		ok(
			warnings.some((warning) => warning.includes(`${HOST}:${httpPort}`) && warning.includes(ALLOW_ENV)),
			`expected a warning naming ${HOST}:${httpPort}, got ${JSON.stringify(warnings)}`
		);
	});
}

for (const value of ['0', 'false', '']) {
	test(`still refuses the address when ${ALLOW_ENV}=${JSON.stringify(value)}`, async (t) => {
		const listener = await listenOnAllInterfaces('0.0.0.0', httpPort);
		if (typeof listener === 'string') return t.skip(listener);
		process.env[ALLOW_ENV] = value;
		let error: any;
		try {
			error = await refusal();
		} finally {
			delete process.env[ALLOW_ENV];
			await close(listener);
		}
		strictEqual(error.name, 'ForeignListenerError');
	});
}

test('waits out a listener bound to the address itself instead of refusing it', { timeout: 15000 }, async (t) => {
	const warn = t.mock.method(console, 'warn', () => {});
	const canaryWarned = () =>
		warn.mock.calls.some((call) => String(call.arguments[0]).includes('still in use by another Harper node'));
	const lingering = await listen(HOST, httpPort);
	t.after(() => (lingering.listening ? close(lingering) : undefined));
	const allocation = getNextAvailableLoopbackAddress();
	while (!canaryWarned()) await sleep(10);
	await close(lingering);
	strictEqual(await allocation, HOST);
	await releaseLoopbackAddress(HOST);
});

test('refuses an address whose port answers no handshake, as one that could not be checked', async (t) => {
	if (process.platform === 'win32') return t.skip('stalling a handshake needs SIGSTOP');
	const listener = await startChildListener('0.0.0.0', httpPort);
	try {
		if (!(await isPortFree(HOST, httpPort))) return t.skip(CANARY_CATCHES_IT);
		if (!(await listener.stall())) return t.skip(RESETS_INSTEAD_OF_STALLING);
		const error = await refusal();
		strictEqual(error.name, 'LoopbackAddressValidationError');
		match(error.message, new RegExp(`No answer from ${HOST}:${httpPort}`));
		match(error.message, new RegExp(`${ALLOW_ENV}=1`));
	} finally {
		await listener.close();
	}
	deepStrictEqual(readPool(), [null], 'the refused address must go back to the pool');
});

test('startHarper and setupHarperWithFixture remove the install directory they created when allocation refuses the address', async (t) => {
	const listener = await listenOnAllInterfaces('0.0.0.0', httpPort);
	if (typeof listener === 'string') return t.skip(listener);
	const installParent = join(poolDir, 'installs');
	mkdirSync(installParent);
	process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR = installParent;
	// Were the address handed out, startHarper would go on to launch Harper; make that fail instead.
	process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(poolDir, 'no-such-harper.js');
	try {
		await rejects(startHarper(createHarperContext('refused')), { name: 'ForeignListenerError' });
		deepStrictEqual(readdirSync(installParent), []);

		const fixture = mkdtempSync(join(poolDir, 'fixture-'));
		writeFileSync(join(fixture, 'config.yaml'), '');
		const fixtureCtx = createHarperContext('refused-fixture');
		await rejects(setupHarperWithFixture(fixtureCtx, fixture), { name: 'ForeignListenerError' });
		deepStrictEqual(readdirSync(installParent), []);
		strictEqual(fixtureCtx.harper, undefined, 'a retry must not reuse the removed install directory');

		const callerDir = mkdtempSync(join(installParent, 'caller-'));
		const ctx = createHarperContext('refused-with-directory');
		publishHarperNode(ctx, { dataRootDir: callerDir });
		await rejects(startHarper(ctx), { name: 'ForeignListenerError' });
		ok(existsSync(callerDir), "a caller-supplied install directory is the caller's to remove");
	} finally {
		delete process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR;
		delete process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT;
		await close(listener);
	}
});

test('readPoolFile quarantines an unusable pool file, then reinitializes it once it has gone unmodified long enough', async (t) => {
	t.mock.method(console, 'warn', () => {});
	await withTempDir(async (dir) => {
		const poolPath = join(dir, 'pool.json');
		for (const content of ['[1,2,nul', '', 'null', '{}', '[]']) {
			await writeFile(poolPath, content);
			strictEqual(await readPoolFile(poolPath), null, `fresh ${JSON.stringify(content)} should be quarantined`);

			await age(poolPath);
			const pool = await readPoolFile(poolPath);
			ok(pool && pool.length > 0 && pool.every((slot) => slot === null), `aged ${JSON.stringify(content)} should reinitialize`);
		}
	});
});

test('readPoolFile reads a pool file deleted between its read and its stat as missing', async () => {
	const m = mock.module('node:fs/promises', {
		namedExports: {
			...fsPromises,
			readFile: async () => '[1,2,nul',
			stat: async () => {
				const error = new Error('simulated ENOENT') as NodeJS.ErrnoException;
				error.code = 'ENOENT';
				throw error;
			},
		},
	});
	try {
		const { readPoolFile: freshReadPoolFile } = await import(freshModuleUrl());
		const pool = await freshReadPoolFile('unused');
		ok(pool.length > 0 && pool.every((slot: number | null) => slot === null));
	} finally {
		m.restore();
	}
});

test('a reservation lost to an unusable pool file is not reissued until the quarantine ends', async (t) => {
	const warn = t.mock.method(console, 'warn', () => {});
	await withTempDir(async (dir) => {
		const pool = await importIsolatedPool(dir);
		const poolPath = join(dir, POOL_FILE_NAME);
		strictEqual(await pool.getNextAvailableLoopbackAddress(), '127.0.0.1');

		// A writer that doesn't publish by rename dies mid-write, losing that reservation.
		await writeFile(poolPath, '[');
		const reissued = pool.getNextAvailableLoopbackAddress();
		try {
			strictEqual(await Promise.race([reissued.then(() => 'reissued'), sleep(2500).then(() => 'waiting')]), 'waiting');

			await pool.releaseLoopbackAddress('127.0.0.1');
			await pool.releaseAllLoopbackAddressesForCurrentProcess();
			strictEqual(await readFile(poolPath, 'utf-8'), '[', 'releasing must not end the quarantine');

			await age(poolPath);
			strictEqual(await Promise.race([reissued, sleep(5000).then(() => 'still waiting')]), '127.0.0.1');
		} finally {
			// Unblocks the allocation if an assertion above failed, so the test can't hang.
			await rm(poolPath, { force: true });
			await reissued;
		}
		strictEqual(warn.mock.calls.filter((call) => String(call.arguments[0]).includes('is unusable')).length, 1);
	});
});

test('releaseLoopbackAddress clears only a slot this process holds', async () => {
	await withTempDir(async (dir) => {
		const pool = await importIsolatedPool(dir);
		const poolPath = join(dir, POOL_FILE_NAME);

		strictEqual(await pool.getNextAvailableLoopbackAddress(), '127.0.0.1');
		await pool.releaseLoopbackAddress('127.0.0.1');
		deepStrictEqual(JSON.parse(await readFile(poolPath, 'utf-8')), [null]);

		const otherRunnerPid = process.pid + 1;
		await writeFile(poolPath, JSON.stringify([otherRunnerPid]));
		await pool.releaseLoopbackAddress('127.0.0.1');
		deepStrictEqual(JSON.parse(await readFile(poolPath, 'utf-8')), [otherRunnerPid]);
	});
});

test('readPoolFile still rethrows errors unrelated to a missing/corrupt file', async () => {
	await withTempDir(async (dir) => {
		const poolPath = join(dir, 'pool.json');
		const m = mock.module('node:fs/promises', {
			// @types/node 22.0.0 only knows `namedExports`; `exports` isn't in its types yet.
			namedExports: {
				...fsPromises,
				readFile: async () => {
					const error = new Error('simulated EACCES') as NodeJS.ErrnoException;
					error.code = 'EACCES';
					throw error;
				},
			},
		});
		try {
			const { readPoolFile: freshReadPoolFile } = await import(freshModuleUrl());
			await rejects(() => freshReadPoolFile(poolPath), /simulated EACCES/);
		} finally {
			m.restore();
		}
	});
});

test('writePoolFile round-trips through readPoolFile and leaves no leftover pending file', async () => {
	await withTempDir(async (dir) => {
		const poolPath = join(dir, 'pool.json');
		const pool = [null, 123, null, 456];

		await writePoolFile(pool, poolPath);

		deepStrictEqual(await readPoolFile(poolPath), pool);
		deepStrictEqual(await readdir(dir), ['pool.json']);
	});
});

test('writePoolFile never leaves a partially-written file visible at the pool path', async () => {
	await withTempDir(async (dir) => {
		const poolPath = join(dir, 'pool.json');
		const original = [null, null, null];
		await writeFile(poolPath, JSON.stringify(original));

		// A hard kill in this same window (vs. this mocked rejection) bypasses catch/finally and
		// orphans the pending file — the pool has no reaper for that, unlike the instance registry.
		const m = mock.module('node:fs/promises', {
			namedExports: {
				...fsPromises,
				rename: async () => {
					throw new Error('simulated rename failure');
				},
			},
		});
		try {
			const { writePoolFile: freshWritePoolFile } = await import(freshModuleUrl());
			await rejects(() => freshWritePoolFile([1, 2, 3], poolPath), /simulated rename failure/);
		} finally {
			m.restore();
		}

		deepStrictEqual(JSON.parse(await readFile(poolPath, 'utf-8')), original);
		deepStrictEqual(await readdir(dir), ['pool.json']);
	});
});
