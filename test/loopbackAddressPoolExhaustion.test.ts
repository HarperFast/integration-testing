import { test, after, mock } from 'node:test';
import { match, ok, strictEqual } from 'node:assert';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pidNamespaceUnavailable, startHolder, type Holder } from './loopbackHolder.ts';

const HOST = '127.0.0.1';

function listen(port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(port, HOST, () => resolve(server));
	});
}

/** Distinct free ports: all are held at once, so the OS cannot hand out the same one twice. */
async function freePorts(count: number): Promise<number[]> {
	const servers = await Promise.all(Array.from({ length: count }, () => listen(0)));
	const ports = servers.map((server) => (server.address() as AddressInfo).port);
	await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
	return ports;
}

const scratchDir = mkdtempSync(join(tmpdir(), 'loopback-pool-exhaustion-test-'));
const [claimPort, canaryPort] = await freePorts(2);
// The pool reads these once, when it is imported; the holder processes inherit them.
process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START = '1';
process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT = '1';
process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_TIMEOUT_MS = '2500';
process.env.HARPER_INTEGRATION_TEST_LOOPBACK_CLAIM_PORT = String(claimPort);
process.env.HARPER_INTEGRATION_TEST_CONFLICT_PROBE_PORT = String(canaryPort);
process.env.HARPER_INTEGRATION_TEST_HTTP_CONFLICT_PROBE_PORT = String(canaryPort);
process.env.HARPER_INTEGRATION_TEST_OTHER_CONFLICT_PROBE_PORTS = '';
delete process.env.HARPER_INTEGRATION_TEST_ALLOW_FOREIGN_LISTENERS;
const { getNextAvailableLoopbackAddress, releaseLoopbackAddress, LoopbackPoolExhaustedError } = await import(
	'../src/loopbackAddressPool.ts'
);

after(() => rmSync(scratchDir, { recursive: true, force: true }));

/** A holder with a TMPDIR of its own, so nothing but the claim itself can tell it apart from this process. */
async function holdingHolder(options: Parameters<typeof startHolder>[0] = {}): Promise<Holder> {
	const ownTmp = mkdtempSync(join(scratchDir, 'holder-tmp-'));
	const holder = startHolder({ ...options, env: { TMPDIR: ownTmp, TMP: ownTmp, TEMP: ownTmp, ...options.env } });
	try {
		const outcome = await holder.outcome;
		strictEqual(outcome.address, HOST, `the holder should hold ${HOST}, got ${JSON.stringify(outcome)}`);
	} catch (error) {
		await holder.kill();
		throw error;
	}
	return holder;
}

/** Resolves once `allocation` has logged that it is waiting, proving it found the pool full first. */
async function untilWaiting(warn: ReturnType<typeof mock.method>, allocation: Promise<string>): Promise<void> {
	let settled = false;
	allocation.then(
		() => (settled = true),
		() => (settled = true)
	);
	while (!warn.mock.calls.some((call) => String(call.arguments[0]).includes('Still waiting'))) {
		if (settled) throw new Error('the allocation settled without waiting');
		await sleep(10);
	}
}

/** Returns an allocation's address to the pool whether it has settled yet or not. */
async function settleAllocation(allocation: Promise<string>): Promise<void> {
	await allocation.then(releaseLoopbackAddress, () => {});
}

async function exhaustion(): Promise<any> {
	const error = await getNextAvailableLoopbackAddress().then(
		async (address) => {
			await releaseLoopbackAddress(address);
			throw new Error(`an address was handed out from a full pool: ${address}`);
		},
		(rejection) => rejection
	);
	ok(error instanceof LoopbackPoolExhaustedError, `expected LoopbackPoolExhaustedError, got ${error}`);
	return error;
}

test('an exhausted pool rejects naming the holding process, instead of waiting forever', async () => {
	const holder = await holdingHolder();
	const warn = mock.method(console, 'warn', () => {});
	try {
		const error = await exhaustion();
		strictEqual(error.name, 'LoopbackPoolExhaustedError');
		match(error.message, /127\.0\.0\.1-127\.0\.0\.1 \(1 addresses\), each held by a listener on its port \d+/);
		match(error.message, new RegExp(`pid ${holder.child.pid} holds 127\\.0\\.0\\.1`));
		match(error.message, /HARPER_INTEGRATION_TEST_LOOPBACK_POOL_TIMEOUT_MS/);

		const notices = warn.mock.calls.map((call) => String(call.arguments[0])).filter((text) => text.includes('Still waiting'));
		strictEqual(notices.length, 1, 'one warning names the holders before the wait ends');
		match(notices[0], new RegExp(`pid ${holder.child.pid} holds 127\\.0\\.0\\.1`));
	} finally {
		warn.mock.restore();
		await holder.stop();
	}
});

test("this process's own claim is listed as this process", async () => {
	const address = await getNextAvailableLoopbackAddress();
	const warn = mock.method(console, 'warn', () => {});
	try {
		const error = await exhaustion();
		match(error.message, new RegExp(`pid ${process.pid} \\(this process\\) holds 127\\.0\\.0\\.1`));
	} finally {
		warn.mock.restore();
		await releaseLoopbackAddress(address);
	}
});

test('an address released during the wait is handed out rather than rejected', async () => {
	const held = await getNextAvailableLoopbackAddress();
	const warn = mock.method(console, 'warn', () => {});
	const allocation = getNextAvailableLoopbackAddress();
	try {
		await untilWaiting(warn, allocation);
		await releaseLoopbackAddress(held);
		strictEqual(await allocation, HOST);
	} finally {
		warn.mock.restore();
		await releaseLoopbackAddress(held);
		await settleAllocation(allocation);
	}
});

test('a holder that exits during the wait frees its address at once', async () => {
	const holder = await holdingHolder();
	const warn = mock.method(console, 'warn', () => {});
	const allocation = getNextAvailableLoopbackAddress();
	try {
		await untilWaiting(warn, allocation);
		await holder.stop();
		strictEqual(await allocation, HOST);
	} finally {
		warn.mock.restore();
		await holder.stop();
		await settleAllocation(allocation);
	}
});

test("a SIGKILLed holder's address is handed out next, without the pool filling first", async () => {
	const twoSlots = { HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT: '2' };
	const holder = await holdingHolder({ env: twoSlots });
	await holder.kill();
	const saved = process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT;
	process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT = twoSlots.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT;
	const twoSlotPoolUrl = '../src/loopbackAddressPool.ts?two-slots';
	let pool: typeof import('../src/loopbackAddressPool.ts');
	try {
		pool = await import(twoSlotPoolUrl);
	} finally {
		process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT = saved;
	}
	// 127.0.0.2 is free (and is not an address at all on macOS without aliases), so a pool that reclaimed dead
	// holders only when full would hand it out instead.
	const address = await pool.getNextAvailableLoopbackAddress();
	try {
		strictEqual(address, HOST);
	} finally {
		await pool.releaseLoopbackAddress(address);
	}
});

test('processes with different TMPDIRs that allocate at once never hold one address together', async () => {
	const contenders = Array.from({ length: 4 }, () => {
		const ownTmp = mkdtempSync(join(scratchDir, 'contender-tmp-'));
		return startHolder({ waitForGo: true, env: { TMPDIR: ownTmp, TMP: ownTmp, TEMP: ownTmp } });
	});
	try {
		await Promise.all(contenders.map((contender) => contender.ready));
		for (const contender of contenders) contender.go();
		const outcomes = await Promise.all(contenders.map((contender) => contender.outcome));
		strictEqual(outcomes.filter((outcome) => outcome.address === HOST).length, 1, JSON.stringify(outcomes));
		strictEqual(outcomes.filter((outcome) => outcome.error === 'LoopbackPoolExhaustedError').length, 3, JSON.stringify(outcomes));
	} finally {
		await Promise.all(contenders.map((contender) => contender.stop()));
	}
});

test('a holder in another PID namespace holds its address while it runs, and frees it when it exits', async (t) => {
	const unavailable = pidNamespaceUnavailable();
	if (unavailable) {
		if (process.env.LOOPBACK_POOL_TEST_REQUIRE_PID_NAMESPACE) throw new Error(unavailable);
		console.log(`# skipping the PID namespace case: ${unavailable}`);
		return t.skip(unavailable);
	}
	const holder = await holdingHolder({ pidNamespace: true });
	const warn = mock.method(console, 'warn', () => {});
	try {
		const { pid } = await holder.outcome;
		ok(pid !== holder.child.pid, 'the holder runs in a PID namespace of its own');
		const error = await exhaustion();
		match(error.message, new RegExp(`pid ${pid} in another PID namespace \\(pid:\\[\\d+\\]\\) holds 127\\.0\\.0\\.1`));
	} finally {
		warn.mock.restore();
		await holder.stop();
	}
	const address = await getNextAvailableLoopbackAddress();
	try {
		strictEqual(address, HOST);
	} finally {
		await releaseLoopbackAddress(address);
	}
});

/** A listener on the claim port that is not a pool holder. Closing it resets its connections, leaving no TIME_WAIT. */
async function listenOnClaimPort(onConnection: (socket: Socket) => void): Promise<{ close(): Promise<void> }> {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on('error', () => {});
		socket.once('close', () => sockets.delete(socket));
		onConnection(socket);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(claimPort, HOST, () => resolve());
	});
	return {
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				for (const socket of sockets) socket.resetAndDestroy();
			}),
	};
}

const strangers: [string, (socket: Socket) => void][] = [
	['answers with something else', (socket) => socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')],
	['answers with an unknown protocol', (socket) => socket.write('{"protocol":"other","pid":1}\n')],
	['sends a reply too long to be one', (socket) => socket.write('x'.repeat(64 * 1024))],
	[
		'sends an identity line too long to be one',
		(socket) => socket.write(`${JSON.stringify({ protocol: 'harper-integration-test-loopback-claim/1', pid: 4242, padding: 'x'.repeat(4096) })}\n`),
	],
	['never answers', () => {}],
];
for (const [behavior, onConnection] of strangers) {
	test(`a claim port held by a process that ${behavior} is listed as unidentified, within the deadline`, async () => {
		const stranger = await listenOnClaimPort(onConnection);
		const warn = mock.method(console, 'warn', () => {});
		const startedAt = performance.now();
		try {
			const error = await exhaustion();
			match(error.message, /held by a process that did not identify itself: 127\.0\.0\.1/);
			const elapsedMs = performance.now() - startedAt;
			ok(elapsedMs < 6000, `the diagnosis took ${Math.round(elapsedMs)}ms`);
		} finally {
			warn.mock.restore();
			await stranger.close();
		}
	});
}

test('a claim still being checked by another allocation is not listed as holding its address', async () => {
	const checking = await listenOnClaimPort((socket) =>
		socket.write(`${JSON.stringify({ protocol: 'harper-integration-test-loopback-claim/1', pid: 4242, checking: true })}\n`)
	);
	const warn = mock.method(console, 'warn', () => {});
	try {
		const error = await exhaustion();
		match(error.message, /pid 4242 is checking 127\.0\.0\.1/);
		ok(!/pid 4242 holds/.test(error.message), error.message);
	} finally {
		warn.mock.restore();
		await checking.close();
	}
});
