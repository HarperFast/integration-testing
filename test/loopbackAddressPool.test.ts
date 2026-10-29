import { test, after } from 'node:test';
import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert';
import { connect, createServer, type AddressInfo, type Server } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** Distinct free ports: all are held at once, so the OS cannot hand out the same one twice. */
async function freePorts(count: number): Promise<number[]> {
	const servers = await Promise.all(Array.from({ length: count }, () => listen(HOST, 0)));
	const ports = servers.map((server) => (server.address() as AddressInfo).port);
	await Promise.all(servers.map(close));
	return ports;
}

// The pool reads these once, when it is imported. Every port is ephemeral, so neither a real Harper nor a
// concurrent run on this machine can make the result depend on the host.
const scratchDir = mkdtempSync(join(tmpdir(), 'loopback-pool-test-'));
const [claimPort, operationsPort, httpPort, mqttPort] = await freePorts(4);
process.env.TMPDIR = process.env.TEMP = scratchDir;
process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START = '1';
process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT = '1';
process.env.HARPER_INTEGRATION_TEST_LOOPBACK_CLAIM_PORT = String(claimPort);
process.env.HARPER_INTEGRATION_TEST_CONFLICT_PROBE_PORT = String(operationsPort);
process.env.HARPER_INTEGRATION_TEST_HTTP_CONFLICT_PROBE_PORT = String(httpPort);
process.env.HARPER_INTEGRATION_TEST_OTHER_CONFLICT_PROBE_PORTS = String(mqttPort);
delete process.env[ALLOW_ENV];
const { getNextAvailableLoopbackAddress, releaseLoopbackAddress, releaseAllLoopbackAddressesForCurrentProcess } =
	await import('../src/loopbackAddressPool.ts');
const { startHarper, setupHarperWithFixture, publishHarperNode, createHarperContext } = await import(
	'../src/harperLifecycle.ts'
);

after(() => rmSync(scratchDir, { recursive: true, force: true }));

async function claimIsFree(): Promise<boolean> {
	return isPortFree(HOST, claimPort);
}

async function listenOnAllInterfaces(host: string, port: number): Promise<Server | string> {
	try {
		return await listen(host, port);
	} catch (error) {
		return `cannot listen on ${host}: ${(error as NodeJS.ErrnoException).code}`;
	}
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

test('hands out an address and holds its claim port until released', async () => {
	const address = await getNextAvailableLoopbackAddress();
	strictEqual(address, HOST);
	ok(!(await claimIsFree()), 'the claim port is held while the address is');
	await releaseLoopbackAddress(address);
	ok(await claimIsFree(), 'releasing frees the claim port');
	await releaseLoopbackAddress(address);
});

test('releasing an address another process holds leaves its claim alone', async () => {
	const otherHolder = await listen(HOST, claimPort);
	try {
		await releaseLoopbackAddress(HOST);
		ok(otherHolder.listening);
		ok(!(await claimIsFree()));
	} finally {
		await close(otherHolder);
	}
});

test('a release that overlaps the next allocation of the same address does not release the new claim', async () => {
	const first = await getNextAvailableLoopbackAddress();
	const releasing = releaseLoopbackAddress(first);
	const second = await getNextAvailableLoopbackAddress();
	await releasing;
	strictEqual(second, HOST);
	ok(!(await claimIsFree()), 'the second claim is still held');
	await releaseLoopbackAddress(second);
	ok(await claimIsFree());
});

test('releaseAllLoopbackAddressesForCurrentProcess frees every claim', async () => {
	await getNextAvailableLoopbackAddress();
	await releaseAllLoopbackAddressesForCurrentProcess();
	ok(await claimIsFree());
});

test('a release completes while a client that asked for the holder stays connected', { timeout: 5000 }, async () => {
	const address = await getNextAvailableLoopbackAddress();
	const client = connect({ host: HOST, port: claimPort });
	client.on('error', () => {});
	const reply: string = await new Promise((resolve) => client.once('data', (chunk) => resolve(String(chunk))));
	match(reply, /"protocol":"harper-integration-test-loopback-claim\/1"/);
	match(reply, new RegExp(`"pid":${process.pid}`));
	await releaseLoopbackAddress(address);
	ok(await claimIsFree());
	client.destroy();
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
			ok(await claimIsFree(), 'the refused address must go back to the pool');
		});
	}
}

test('a listener on all interfaces on an MQTT-class port refuses the address only where it blocks binding it (Linux)', async (t) => {
	const listener = await listenOnAllInterfaces('0.0.0.0', mqttPort);
	if (typeof listener === 'string') return t.skip(listener);
	try {
		if (process.platform === 'linux') {
			const error = await refusal();
			strictEqual(error.name, 'ForeignListenerError');
			strictEqual(error.port, mqttPort);
		} else {
			const address = await getNextAvailableLoopbackAddress();
			strictEqual(address, HOST);
			await releaseLoopbackAddress(address);
		}
	} finally {
		await close(listener);
	}
	ok(await claimIsFree());
});

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

for (const [portName, port] of [
	['operations', operationsPort],
	['HTTP', httpPort],
	['MQTT-class', mqttPort],
] as const) {
	test(`waits out a listener bound to the address's ${portName} port instead of refusing it`, { timeout: 15000 }, async (t) => {
		const warn = t.mock.method(console, 'warn', () => {});
		const canaryWarned = () =>
			warn.mock.calls.some((call) => String(call.arguments[0]).includes(`still in use by another Harper node (port ${port} bound)`));
		const lingering = await listen(HOST, port);
		t.after(() => (lingering.listening ? close(lingering) : undefined));
		const allocation = getNextAvailableLoopbackAddress();
		while (!canaryWarned()) await sleep(10);
		ok(await claimIsFree(), 'the skipped address is not held while it waits');
		await close(lingering);
		strictEqual(await allocation, HOST);
		await releaseLoopbackAddress(HOST);
	});
}

test('refuses an address whose port answers no handshake, as one that could not be checked', async (t) => {
	if (process.platform === 'win32') return t.skip('stalling a handshake needs SIGSTOP');
	const listener = await startChildListener('0.0.0.0', httpPort);
	try {
		if (!(await isPortFree(HOST, httpPort))) {
			return t.skip('a listener on all interfaces blocks binding the address here, so the bind check refuses it first');
		}
		if (!(await listener.stall())) return t.skip(RESETS_INSTEAD_OF_STALLING);
		const error = await refusal();
		strictEqual(error.name, 'LoopbackAddressValidationError');
		match(error.message, new RegExp(`No answer from ${HOST}:${httpPort}`));
		match(error.message, new RegExp(`${ALLOW_ENV}=1`));
	} finally {
		await listener.close();
	}
	ok(await claimIsFree(), 'the refused address must go back to the pool');
});

test('startHarper and setupHarperWithFixture remove the install directory they created when allocation refuses the address', async (t) => {
	const listener = await listenOnAllInterfaces('0.0.0.0', httpPort);
	if (typeof listener === 'string') return t.skip(listener);
	const installParent = join(scratchDir, 'installs');
	mkdirSync(installParent);
	process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR = installParent;
	// Were the address handed out, startHarper would go on to launch Harper; make that fail instead.
	process.env.HARPER_INTEGRATION_TEST_INSTALL_SCRIPT = join(scratchDir, 'no-such-harper.js');
	try {
		await rejects(startHarper(createHarperContext('refused')), { name: 'ForeignListenerError' });
		deepStrictEqual(readdirSync(installParent), []);

		const fixture = mkdtempSync(join(scratchDir, 'fixture-'));
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

let freshImportCounter = 0;

for (const value of ['0', '65536', '1.5', 'nine']) {
	test(`refuses HARPER_INTEGRATION_TEST_LOOPBACK_CLAIM_PORT=${value} when imported`, async () => {
		process.env.HARPER_INTEGRATION_TEST_LOOPBACK_CLAIM_PORT = value;
		try {
			await rejects(import(`../src/loopbackAddressPool.ts?claim-port=${++freshImportCounter}`), /CLAIM_PORT must be an integer/);
		} finally {
			process.env.HARPER_INTEGRATION_TEST_LOOPBACK_CLAIM_PORT = String(claimPort);
		}
	});
}

test("refuses a claim port that is one of Harper's ports when imported", async () => {
	process.env.HARPER_INTEGRATION_TEST_LOOPBACK_CLAIM_PORT = String(mqttPort);
	try {
		await rejects(import(`../src/loopbackAddressPool.ts?claim-port=${++freshImportCounter}`), /must not be one of Harper's ports/);
	} finally {
		process.env.HARPER_INTEGRATION_TEST_LOOPBACK_CLAIM_PORT = String(claimPort);
	}
});
