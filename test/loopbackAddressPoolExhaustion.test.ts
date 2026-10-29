import { test, after, mock } from 'node:test';
import { match, ok, strictEqual } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

const poolDir = mkdtempSync(join(tmpdir(), 'loopback-pool-exhaustion-test-'));
const canaryPort = await freePort();
process.env.TMPDIR = process.env.TEMP = poolDir;
process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START = '1';
process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT = '2';
process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_TIMEOUT_MS = '2500';
process.env.HARPER_INTEGRATION_TEST_CONFLICT_PROBE_PORT = String(canaryPort);
process.env.HARPER_INTEGRATION_TEST_HTTP_CONFLICT_PROBE_PORT = String(canaryPort);
delete process.env.HARPER_INTEGRATION_TEST_ALLOW_FOREIGN_LISTENERS;
const { getNextAvailableLoopbackAddress, releaseLoopbackAddress, LoopbackPoolExhaustedError } = await import(
	'../src/loopbackAddressPool.ts'
);

const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
ok(holder.pid, 'the holder process started');
const holderPid = holder.pid;

after(() => {
	holder.kill();
	rmSync(poolDir, { recursive: true, force: true });
});

async function kill(child: ChildProcess) {
	const exited = once(child, 'exit');
	child.kill('SIGKILL');
	await exited;
}

function writePool(pool: (number | null)[]) {
	writeFileSync(join(poolDir, 'harper-integration-test-loopback-pool.json'), JSON.stringify(pool));
}

test('an exhausted pool rejects with the pool range and the pids holding it, instead of waiting forever', async () => {
	writePool([process.pid, holderPid]);
	const warn = mock.method(console, 'warn', () => {});
	try {
		const error = await getNextAvailableLoopbackAddress().then(
			() => {
				throw new Error('an address was handed out from a full pool');
			},
			(rejection) => rejection
		);
		ok(error instanceof LoopbackPoolExhaustedError);
		strictEqual(error.name, 'LoopbackPoolExhaustedError');
		match(error.message, /127\.0\.0\.1-127\.0\.0\.2 \(2 addresses\)/);
		match(error.message, new RegExp(`pid ${process.pid} \\(this process\\) holds 127\\.0\\.0\\.1`));
		match(error.message, new RegExp(`pid ${holderPid} holds 127\\.0\\.0\\.2`));
		match(error.message, /HARPER_INTEGRATION_TEST_LOOPBACK_POOL_TIMEOUT_MS/);

		const notices = warn.mock.calls.map((call) => String(call.arguments[0])).filter((text) => text.includes('Still waiting'));
		strictEqual(notices.length, 1, 'one warning names the holders before the wait ends');
		match(notices[0], new RegExp(`pid ${holderPid} holds 127\\.0\\.0\\.2`));
	} finally {
		warn.mock.restore();
		writePool([null, null]);
	}
});

test('an address freed during the wait is handed out rather than rejected', async () => {
	writePool([process.pid, holderPid]);
	const [address] = await Promise.all([
		getNextAvailableLoopbackAddress(),
		sleep(500).then(() => releaseLoopbackAddress('127.0.0.1')),
	]);
	try {
		strictEqual(address, '127.0.0.1');
	} finally {
		await releaseLoopbackAddress(address);
	}
});

test('a holder that dies after the deadline is reclaimed rather than reported', async () => {
	const dying = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
	try {
		writePool([dying.pid!, holderPid]);
		const [address] = await Promise.all([
			getNextAvailableLoopbackAddress(),
			sleep(2500).then(() => kill(dying)),
		]);
		try {
			strictEqual(address, '127.0.0.1');
		} finally {
			await releaseLoopbackAddress(address);
		}
	} finally {
		dying.kill('SIGKILL');
	}
});

test('a pool holding only dead pids is reclaimed, not reported as exhausted', async () => {
	const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
	await new Promise((resolve) => dead.once('exit', resolve));
	writePool([dead.pid!, holderPid]);
	const address = await getNextAvailableLoopbackAddress();
	try {
		strictEqual(address, '127.0.0.1');
	} finally {
		await releaseLoopbackAddress(address);
	}
});
