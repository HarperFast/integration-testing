import { test } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { isPortFree, waitForPortsFree } from '../src/portUtils.ts';

const HOST = '127.0.0.1';
const IS_CI = !!process.env.CI;

/** Binds a server to host:port and resolves once it is listening. */
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

/** Binds to port 0 and returns the still-listening server plus its OS-assigned port. */
async function listenEphemeral(host: string): Promise<{ server: Server; port: number }> {
	const server = await listen(host, 0);
	const { port } = server.address() as AddressInfo;
	return { server, port };
}

/**
 * Acquires `count` distinct, (very probably) free ports by binding that many ephemeral servers at
 * once — distinct because two live servers can't share a port — then releasing them all.
 *
 * This is the one unavoidable TOCTOU in these tests: nothing can hold a port open *as free*, so a
 * test that needs a free port has to accept that something else could grab it between release and
 * the assertion. {@link withFreePorts} re-runs the body to absorb that rare race.
 */
async function getFreePorts(host: string, count: number): Promise<number[]> {
	const servers = await Promise.all(Array.from({ length: count }, () => listenEphemeral(host)));
	const ports = servers.map((s) => s.port);
	await Promise.all(servers.map((s) => close(s.server)));
	return ports;
}

/** Runs `body` with freshly-acquired free ports, retrying with new ports if the TOCTOU race trips. */
async function withFreePorts(
	host: string,
	count: number,
	body: (ports: number[]) => Promise<void>,
	attempts = 5
): Promise<void> {
	let lastErr: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			await body(await getFreePorts(host, count));
			return;
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr;
}

test('isPortFree returns true for an unbound port', async () => {
	await withFreePorts(HOST, 1, async ([port]) => {
		strictEqual(await isPortFree(HOST, port), true);
	});
});

test('isPortFree returns false for a bound port', async () => {
	const { server, port } = await listenEphemeral(HOST);
	try {
		strictEqual(await isPortFree(HOST, port), false);
	} finally {
		await close(server);
	}
});

test('waitForPortsFree resolves true immediately when all ports are free', async () => {
	await withFreePorts(HOST, 2, async (ports) => {
		const start = Date.now();
		const freed = await waitForPortsFree(HOST, ports, 1000, 50);
		ok(freed, 'expected ports to be reported free');
		// `freed` is the correctness assertion. The upper-bound timing check is itself a flake source
		// on contended CI (a GC/scheduler stall can blow the ceiling even when the code is correct),
		// so it only runs locally as a no-busy-wait regression guard.
		if (!IS_CI) ok(Date.now() - start < 500, 'should not have polled/waited');
	});
});

test('waitForPortsFree waits until a held port is released, then resolves true', async () => {
	const { server, port } = await listenEphemeral(HOST);
	// Release the port shortly after we start waiting.
	setTimeout(() => void close(server), 200);
	const freed = await waitForPortsFree(HOST, [port], 2000, 50);
	ok(freed, 'expected the port to become free before the timeout');
});

test('waitForPortsFree resolves false when a port stays held past the timeout', async () => {
	const { server, port } = await listenEphemeral(HOST);
	try {
		const freed = await waitForPortsFree(HOST, [port], 300, 50);
		strictEqual(freed, false);
	} finally {
		await close(server);
	}
});
