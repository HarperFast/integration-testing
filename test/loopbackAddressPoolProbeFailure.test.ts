import { test, after } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { createServer, type AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptsConnections } from '../src/portUtils.ts';

const HOST = '127.0.0.1';
const ALLOW_ENV = 'HARPER_INTEGRATION_TEST_ALLOW_FOREIGN_LISTENERS';

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, HOST, () => resolve());
	});
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

// Port 0 as the HTTP canary: the bind canary binds an ephemeral port, but connecting to port 0 fails
// with something other than a refusal where the OS rejects it outright (EADDRNOTAVAIL on macOS).
const poolDir = mkdtempSync(join(tmpdir(), 'loopback-pool-probe-test-'));
const operationsPort = await freePort();
process.env.TMPDIR = process.env.TMP = process.env.TEMP = poolDir;
process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_START = '1';
process.env.HARPER_INTEGRATION_TEST_LOOPBACK_POOL_COUNT = '1';
process.env.HARPER_INTEGRATION_TEST_CONFLICT_PROBE_PORT = String(operationsPort);
process.env.HARPER_INTEGRATION_TEST_HTTP_CONFLICT_PROBE_PORT = '0';
delete process.env[ALLOW_ENV];
const { getNextAvailableLoopbackAddress, releaseLoopbackAddress } = await import('../src/loopbackAddressPool.ts');

after(() => rmSync(poolDir, { recursive: true, force: true }));

const probeFails = await acceptsConnections(HOST, 0).then(
	() => false,
	() => true
);
const SKIP = probeFails ? false : 'connecting to port 0 is refused here, so the probe cannot be made to fail';

function readPool(): unknown {
	return JSON.parse(readFileSync(join(poolDir, 'harper-integration-test-loopback-pool.json'), 'utf-8'));
}

test('an address that cannot be checked is refused, with the reason, and goes back to the pool', { skip: SKIP }, async () => {
	let error: any;
	try {
		await releaseLoopbackAddress(await getNextAvailableLoopbackAddress());
	} catch (rejection) {
		error = rejection;
	}
	ok(error, 'expected getNextAvailableLoopbackAddress to reject');
	strictEqual(error.name, 'LoopbackAddressValidationError');
	match(error.message, /Could not check whether another process accepts connections on 127\.0\.0\.1/);
	match(error.message, new RegExp(`${ALLOW_ENV}=1`));
	ok(error.cause, 'the probe error is the cause');
	deepStrictEqual(readPool(), [null]);
});

test(`an address that cannot be checked is handed out with a warning when ${ALLOW_ENV} is set`, { skip: SKIP }, async (t) => {
	const warn = t.mock.method(console, 'warn', () => {});
	process.env[ALLOW_ENV] = '1';
	try {
		const address = await getNextAvailableLoopbackAddress();
		strictEqual(address, HOST);
		await releaseLoopbackAddress(address);
	} finally {
		delete process.env[ALLOW_ENV];
	}
	ok(
		warn.mock.calls.some((call) => String(call.arguments[0]).includes('Could not check 127.0.0.1')),
		'expected a warning that the check could not be made'
	);
});
